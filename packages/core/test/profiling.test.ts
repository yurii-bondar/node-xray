import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCpuProfile, parseHeapProfile, type CpuProfile } from '../src/cdp.js';
import { changedFunctions, diffFlames, workOf } from '../src/diff.js';
import { toCpuProfile, toHeapProfile } from '../src/export.js';
import { allocationFlame, cpuFlame } from '../src/flame.js';
import { decodeVlq, SourceMap, sourceMappingUrl } from '../src/sourcemap.js';
import { Timeline } from '../src/timeline.js';
import { callFrame } from './fixtures.js';

function profile(hits: Readonly<Record<string, number>>): CpuProfile {
  return {
    startTime: 0,
    endTime: 1_000_000,
    samples: [],
    nodes: [
      { id: 1, callFrame: { ...callFrame('(root)'), url: '', lineNumber: -1, columnNumber: -1 }, hitCount: 0, children: [2, 3, 4], positionTicks: [] },
      { id: 2, callFrame: { ...callFrame('(idle)'), url: '', lineNumber: -1, columnNumber: -1 }, hitCount: hits['idle'] ?? 0, children: [], positionTicks: [] },
      { id: 3, callFrame: callFrame('handle', 9), hitCount: hits['handle'] ?? 0, children: [5], positionTicks: [] },
      { id: 4, callFrame: callFrame('render', 30), hitCount: hits['render'] ?? 0, children: [], positionTicks: [] },
      { id: 5, callFrame: callFrame('parse', 19), hitCount: hits['parse'] ?? 0, children: [], positionTicks: [] },
    ],
  };
}

describe('exports', () => {
  it('writes a .cpuprofile that reads back as the same tree', () => {
    const tree = cpuFlame(profile({ idle: 5, handle: 2, parse: 3, render: 1 }), { start: 1000, end: 2000 });
    const exported = toCpuProfile(tree);
    assert.equal(exported.samples.length, 11);
    assert.equal(exported.timeDeltas.reduce((a, b) => a + b, 0), exported.endTime - exported.startTime);
    assert.deepEqual([exported.startTime, exported.endTime], [1_000_000, 2_000_000]);
    const back = cpuFlame(parseCpuProfile(JSON.parse(JSON.stringify(exported)), '$'), { start: 1000, end: 2000 });
    assert.deepEqual(back, tree);
    assert.equal(exported.nodes[0]?.callFrame.lineNumber, -1, 'unknown positions stay -1');
  });

  it('writes a .heapprofile that reads back as the same tree', () => {
    const tree = allocationFlame(
      { head: { callFrame: callFrame('(root)'), selfSize: 0, children: [{ callFrame: callFrame('readBody', 4), selfSize: 4096, children: [] }] } },
      { start: 0, end: 1 },
    );
    const back = allocationFlame(parseHeapProfile(JSON.parse(JSON.stringify(toHeapProfile(tree))), '$'), { start: 0, end: 1 });
    assert.deepEqual(back, tree);
  });

  it('refuses the wrong kind of tree', () => {
    const cpu = cpuFlame(profile({ handle: 1 }), { start: 0, end: 1 });
    assert.throws(() => toHeapProfile(cpu), /allocation tree/);
  });
});

describe('diff', () => {
  const base = cpuFlame(profile({ idle: 90, handle: 4, parse: 4, render: 2 }), { start: 0, end: 1 });
  // Twice the work and almost no idle; parse got relatively heavier.
  const now = cpuFlame(profile({ idle: 2, handle: 2, parse: 14, render: 4 }), { start: 1, end: 2 });

  it('compares shares of work, ignoring idle', () => {
    assert.equal(workOf(base.root), 10);
    const diff = diffFlames(base, now);
    assert.ok(Math.abs(diff.total - 1) < 1e-9, 'the current tree sums to its whole work');
    assert.equal(diff.children.some((c) => c.name === '(idle)'), false);
    const handle = diff.children.find((c) => c.name === 'handle');
    assert.ok(handle);
    assert.deepEqual([handle.total, handle.baseTotal], [16 / 20, 8 / 10]);
    const parse = handle.children[0];
    assert.ok(parse && Math.abs(parse.self - 0.7) < 1e-9 && Math.abs(parse.baseSelf - 0.4) < 1e-9);
  });

  it('ranks functions by how much their share moved', () => {
    const changes = changedFunctions(base, now, 3);
    assert.deepEqual(
      changes.map((c) => [c.name, Number(c.delta.toFixed(2))]),
      [
        ['parse', 0.3],
        ['handle', -0.3],
        ['render', 0],
      ],
    );
  });
});

describe('source maps', () => {
  it('decodes base64 VLQ', () => {
    assert.deepEqual(decodeVlq('AAgBC'), [0, 0, 16, 1]);
    assert.deepEqual(decodeVlq('D'), [-1]);
    assert.deepEqual(decodeVlq('2HwrE'), [123, 2232]);
    assert.throws(() => decodeVlq('g'), /unterminated/);
  });

  // Generated line 1: col 0 → a.ts 1:1. Line 2: col 0 → a.ts 2:1, col 4 → a.ts 2:5 named `parse`,
  // col 13 → b.ts 10:3.
  const map = SourceMap.parse({
    version: 3,
    sourceRoot: 'src',
    sources: ['a.ts', 'b.ts'],
    names: ['parse'],
    mappings: 'AAAA;AACA,IAAIA,SCQF',
  });

  it('finds the original position of a generated one', () => {
    assert.ok(map.ok);
    if (!map.ok) return;
    assert.deepEqual(map.value.lookup(1, 1), { source: 'src/a.ts', line: 1, column: 1, name: null });
    assert.deepEqual(map.value.lookup(2, 7), { source: 'src/a.ts', line: 2, column: 5, name: 'parse' });
    assert.deepEqual(map.value.lookup(2, 40), { source: 'src/b.ts', line: 10, column: 3, name: null });
    assert.equal(map.value.lookup(9, 1), null);
  });

  it('rejects what it cannot read', () => {
    assert.equal(SourceMap.parse({ version: 2, sources: [], mappings: '' }).ok, false);
    assert.equal(SourceMap.parse({ version: 3, sections: [] }).ok, false);
    assert.equal(SourceMap.parse({ version: 3, sources: [], mappings: '!!' }).ok, false);
  });

  it('finds the map comment on the last line', () => {
    assert.equal(sourceMappingUrl('x();\n//# sourceMappingURL=app.js.map\n'), 'app.js.map');
    assert.equal(sourceMappingUrl('x();\n//# sourceMappingURL=data:application/json;base64,eyJ9\n\n'), 'data:application/json;base64,eyJ9');
    assert.equal(sourceMappingUrl('// sourceMappingURL=app.js.map in a comment\nx();'), null);
  });
});

describe('Timeline CPU total', () => {
  it('merges every window, beyond what the ring keeps', () => {
    const timeline = new Timeline({ cpuWindows: 1 });
    for (let i = 0; i < 3; i++) timeline.apply({ type: 'cpu-profile', start: i, end: i + 1, profile: profile({ handle: 1 }) });
    assert.equal(timeline.cpuFlame()?.root.total, 1);
    assert.equal(timeline.cpuFlameTotal()?.root.total, 3);
    assert.deepEqual([timeline.cpuFlameTotal()?.start, timeline.cpuFlameTotal()?.end], [0, 3]);
  });
});
