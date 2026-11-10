import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CpuProfile, HeapProfile } from '../src/cdp.js';
import { allocationFlame, cpuFlame, hotFunctions, mergeFlames, scriptPath, withoutScript, type FlameNode } from '../src/flame.js';
import { callFrame } from './fixtures.js';

const window = { start: 0, end: 5000 };

// (root) → main → handle → parse
//                ↘ handle (other column: same name, different position)
//        → (garbage collector)
const profile: CpuProfile = {
  startTime: 0,
  endTime: 5_000_000,
  samples: [],
  nodes: [
    { id: 1, callFrame: { ...callFrame('(root)'), url: '', lineNumber: -1, columnNumber: -1 }, hitCount: 0, children: [2, 6], positionTicks: [] },
    { id: 2, callFrame: callFrame('main', 0), hitCount: 1, children: [3, 5], positionTicks: [] },
    { id: 3, callFrame: callFrame('handle', 9), hitCount: 2, children: [4], positionTicks: [] },
    { id: 4, callFrame: callFrame('parse', 19), hitCount: 5, children: [], positionTicks: [] },
    { id: 5, callFrame: callFrame('handle', 9), hitCount: 3, children: [], positionTicks: [] },
    { id: 6, callFrame: { ...callFrame('(garbage collector)'), url: '' }, hitCount: 4, children: [], positionTicks: [] },
  ],
};

function shape(node: FlameNode): unknown {
  return [node.name, node.self, node.total, node.children.map(shape)];
}

describe('cpuFlame', () => {
  it('builds a tree with self/total, merging identical siblings, heaviest first', () => {
    const tree = cpuFlame(profile, window);
    assert.equal(tree.unit, 'samples');
    assert.deepEqual(shape(tree.root), [
      '(root)',
      0,
      15,
      [
        ['main', 1, 11, [['handle', 5, 10, [['parse', 5, 5, []]]]]],
        ['(garbage collector)', 4, 4, []],
      ],
    ]);
    const main = tree.root.children[0];
    assert.equal(main?.line, 1, '1-based line');
    assert.equal(tree.root.line, 0, 'no position for (root)');
  });

  it('counts samples when hitCount is absent', () => {
    const tree = cpuFlame({ ...profile, nodes: profile.nodes.map((n) => ({ ...n, hitCount: 0 })), samples: [4, 4, 6] }, window);
    assert.equal(tree.root.total, 3);
  });
});

describe('allocationFlame', () => {
  it('weights the tree by sampled bytes', () => {
    const heap: HeapProfile = {
      head: {
        callFrame: callFrame('(root)'),
        selfSize: 0,
        children: [
          {
            callFrame: callFrame('readBody', 4),
            selfSize: 1024,
            children: [{ callFrame: callFrame('JSON.parse', 0, ''), selfSize: 4096, children: [] }],
          },
          { callFrame: callFrame('cacheSet', 30), selfSize: 0, children: [] },
        ],
      },
    };
    const tree = allocationFlame(heap, window);
    assert.equal(tree.unit, 'bytes');
    assert.deepEqual(shape(tree.root), ['(root)', 0, 5120, [['readBody', 1024, 5120, [['JSON.parse', 4096, 4096, []]]]]]);
  });
});

describe('scriptPath', () => {
  it('maps file URLs and paths of one script to the same string', () => {
    assert.equal(scriptPath('file:///Users/Me/My%20Dir/agent.cjs'), '/Users/Me/My Dir/agent.cjs');
    assert.equal(scriptPath('/Users/Me/My Dir/agent.cjs'), '/Users/Me/My Dir/agent.cjs');
    assert.equal(scriptPath('file:///C:/x/agent.cjs'), 'C:/x/agent.cjs');
    assert.equal(scriptPath('C:\\x\\agent.cjs'), 'C:/x/agent.cjs');
    assert.equal(scriptPath('node:fs'), 'node:fs');
  });
});

describe('withoutScript', () => {
  it("cuts out a script's frames and everything they called", () => {
    const agent = 'file:///opt/xray/agent.cjs';
    const tree = cpuFlame(
      {
        ...profile,
        nodes: [
          { id: 1, callFrame: callFrame('(root)'), hitCount: 0, children: [2, 4], positionTicks: [] },
          { id: 2, callFrame: callFrame('tick', 10, agent), hitCount: 1, children: [3], positionTicks: [] },
          { id: 3, callFrame: callFrame('stringify', 0, ''), hitCount: 5, children: [], positionTicks: [] },
          { id: 4, callFrame: callFrame('handle', 3), hitCount: 2, children: [], positionTicks: [] },
        ],
      },
      window,
    );
    assert.deepEqual(shape(withoutScript(tree, agent).root), ['(root)', 0, 2, [['handle', 2, 2, []]]]);
    assert.deepEqual(shape(withoutScript(tree, '/opt/xray/agent.cjs').root), ['(root)', 0, 2, [['handle', 2, 2, []]]], 'path matches the file URL');
    assert.equal(withoutScript(tree, ''), tree);
  });
});

describe('mergeFlames / hotFunctions', () => {
  it('sums windows and spans their time', () => {
    const a = cpuFlame(profile, { start: 0, end: 5000 });
    const b = cpuFlame(profile, { start: 5000, end: 10_000 });
    const merged = mergeFlames([a, b]);
    assert.ok(merged);
    assert.equal(merged.root.total, 30);
    assert.equal(merged.root.children[0]?.children[0]?.self, 10);
    assert.deepEqual([merged.start, merged.end], [0, 10_000]);
    assert.equal(mergeFlames([]), null);
  });

  it('refuses to mix samples with bytes', () => {
    const heap = allocationFlame({ head: { callFrame: callFrame('(root)'), selfSize: 1, children: [] } }, window);
    assert.throws(() => mergeFlames([cpuFlame(profile, window), heap]), /cannot merge/);
  });

  it('ranks functions by self weight and counts recursion once in total', () => {
    const recursive: CpuProfile = {
      ...profile,
      nodes: [
        { id: 1, callFrame: callFrame('(root)'), hitCount: 0, children: [2], positionTicks: [] },
        { id: 2, callFrame: callFrame('walk', 5), hitCount: 1, children: [3], positionTicks: [] },
        { id: 3, callFrame: callFrame('walk', 5), hitCount: 1, children: [4], positionTicks: [] },
        { id: 4, callFrame: callFrame('visit', 9), hitCount: 6, children: [], positionTicks: [] },
      ],
    };
    const hot = hotFunctions(cpuFlame(recursive, window), 5);
    assert.deepEqual(
      hot.map((f) => [f.name, f.self, f.total, f.selfShare]),
      [
        ['visit', 6, 6, 0.75],
        ['walk', 2, 8, 0.25],
      ],
    );
    assert.equal(hotFunctions(cpuFlame(profile, window), 1).length, 1);
  });

  it('leaves idle and program time out of the list and out of the shares', () => {
    const idle: CpuProfile = {
      ...profile,
      nodes: [
        { id: 1, callFrame: callFrame('(root)'), hitCount: 0, children: [2, 3, 4], positionTicks: [] },
        { id: 2, callFrame: callFrame('(idle)'), hitCount: 90, children: [], positionTicks: [] },
        { id: 3, callFrame: callFrame('(program)'), hitCount: 5, children: [], positionTicks: [] },
        { id: 4, callFrame: callFrame('work', 1), hitCount: 5, children: [], positionTicks: [] },
      ],
    };
    assert.deepEqual(hotFunctions(cpuFlame(idle, window), 5).map((f) => [f.name, f.selfShare]), [['work', 1]]);
  });
});
