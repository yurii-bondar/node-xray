import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cpuFlame, encodeRecord, toLoopEvents, groupIterations, type CpuProfile, type Hello, type LoopTraceEvent } from '@node-xray/core';
import { findByPath, frameKind, layoutFlame, nodeKey } from '../src/flame-layout.js';
import { hitTest, iterationDetail, layoutLane } from '../src/lane-layout.js';
import { OriginalsCache, parseOriginals } from '../src/originals.js';
import { columns, markerTimes, shortIoKey } from '../src/series.js';
import { parseStatus, sourceLabel, Store } from '../src/store.js';

const hello: Hello = {
  type: 'hello',
  protocol: 1,
  pid: 4242,
  threadId: 0,
  nodeVersion: 'v24.15.0',
  platform: 'linux',
  arch: 'x64',
  argv: ['/usr/bin/node', '/srv/app/server.js'],
  execArgv: [],
  timeOrigin: 0,
  intervalMs: 250,
  cpus: 4,
  totalMemory: 1,
  agentScript: '',
};

describe('Store', () => {
  it('keeps one timeline per connection and names sources by hello', () => {
    const store = new Store();
    store.applyLine(encodeRecord(1, JSON.stringify(hello)));
    store.applyLine(encodeRecord(2, JSON.stringify({ ...hello, threadId: 1 })));
    store.applyLine(encodeRecord(0, JSON.stringify({ type: 'host', t: 1, swap: null, gpus: [] })));
    store.applyLine('{"c":1,"m":{"type":"bogus"}}');
    assert.deepEqual([...store.sources.keys()], ['4242:0', '4242:1']);
    assert.equal(store.host.hostSamples().length, 1);
    assert.equal(store.rejected, 1);
    assert.equal(store.defaultSource()?.id, '4242:0');
    assert.equal(sourceLabel(hello), 'pid 4242 · node server.js');
    assert.equal(sourceLabel({ ...hello, threadId: 2 }), 'pid 4242 · worker 2 · node server.js');
    const revision = store.revision;
    store.reset();
    assert.equal(store.sources.size, 0);
    assert.ok(store.revision > revision);
  });

  it('reads the run status', () => {
    assert.deepEqual(parseStatus('{"state":"exited","command":"node a.js","code":3}'), { state: 'exited', command: 'node a.js', code: 3 });
    assert.deepEqual(parseStatus('{"state":"running","command":"npm start"}'), { state: 'running', command: 'npm start' });
    assert.deepEqual(parseStatus('{"state":"detached","command":"attach 4242"}'), { state: 'detached', command: 'attach 4242' });
    assert.equal(parseStatus('{"state":"exited","command":"x"}'), null);
    assert.equal(parseStatus('nope'), null);
  });
});

describe('columns', () => {
  it('slices the window by time and maps x to seconds', () => {
    const items = [{ t: 1000, v: 1 }, { t: 2000, v: 2 }, { t: 3000, v: 3 }];
    assert.deepEqual(columns(items, 2000, [(i) => i.v, (i) => (i.v > 2 ? null : i.v)]), [[2, 3], [2, 3], [2, null]]);
    assert.deepEqual(columns(items, 0, [(i) => i.v]), [[1, 2, 3], [1, 2, 3]]);
    assert.deepEqual(columns([], 5, [(i: { t: number }) => i.t]), [[], []]);
  });
});

function ev(resource: string, iteration: number, start: number, duration: number, name = ''): LoopTraceEvent {
  return { resource, name, iteration, start, duration, depth: 0 };
}

describe('shortIoKey', () => {
  it('keeps the operation and the last two path segments', () => {
    assert.equal(shortIoKey('readFile /srv/app/data/users.json'), 'readFile …/data/users.json');
    assert.equal(shortIoKey('stat /etc'), 'stat /etc');
    assert.equal(shortIoKey('read (fd)'), 'read (fd)');
    assert.equal(shortIoKey('lookup api.example.com'), 'lookup api.example.com');
    assert.equal(shortIoKey('(other)'), '(other)');
  });
});

describe('markerTimes', () => {
  it('keeps the first time of each run of findings', () => {
    assert.deepEqual(markerTimes([1000, 1250, 1500, 1750, 9000, 9250, 3000], 2000), [1000, 9000]);
    assert.deepEqual(markerTimes([5000, 1000], 2000), [1000, 5000]);
    assert.deepEqual(markerTimes([], 2000), []);
  });
});

describe('layoutLane', () => {
  const events = toLoopEvents({
    type: 'loop-trace',
    start: 0,
    end: 1000,
    events: [ev('Timeout', 7, 900, 20, 'poll'), ev('PROMISE', 7, 921, 1), ev('TCPWRAP', 8, 950, 10), ev('Timeout', 6, 100, 5)],
    counters: [],
    dropped: 0,
  });
  const iterations = groupIterations(events);

  it('places callbacks in their rows, scaled to the span, with iteration marks', () => {
    const layout = layoutLane({ events, gc: [{ start: 980, duration: 10, kind: 'major' }], iterations, end: 1000, spanMs: 200, width: 400 });
    assert.equal(layout.start, 800);
    const timer = layout.blocks.find((b) => b.row === 'timer');
    assert.deepEqual(timer && [timer.x, timer.w], [200, 40]);
    assert.ok(layout.blocks.some((b) => b.row === 'gc'));
    assert.equal(layout.blocks.filter((b) => b.row === 'timer').length, 1, 'the timer at t=100 is outside the span');
    assert.deepEqual(layout.marks.map((m) => m.iteration.index), [7, 8]);
    assert.equal(hitTest(layout, 'timer', 210)?.item.kind, 'callback');
    assert.equal(hitTest(layout, 'io', 10), null);
  });

  it('merges callbacks too narrow to draw apart', () => {
    const many = toLoopEvents({
      type: 'loop-trace',
      start: 0,
      end: 1000,
      events: Array.from({ length: 50 }, (_, i) => ev('PROMISE', 1, 500 + i * 0.01, 0.005)),
      counters: [],
      dropped: 0,
    });
    const layout = layoutLane({ events: many, gc: [], iterations: [], end: 1000, spanMs: 1000, width: 100 });
    assert.equal(layout.blocks.length, 1);
    assert.equal(layout.blocks[0]?.merged, 49);
  });

  it('lists the callbacks of one iteration in order', () => {
    const seventh = iterations.find((it) => it.index === 7);
    assert.ok(seventh);
    const detail = iterationDetail(events, seventh);
    assert.deepEqual(detail.callbacks.map((e) => e.resource), ['Timeout', 'PROMISE']);
    assert.deepEqual(detail.groups.map((g) => [g.category, g.label, g.count, g.total]), [
      ['timer', 'poll', 1, 20],
      ['promise', 'PROMISE', 1, 1],
    ]);
  });
});

describe('flame layout', () => {
  const profile: CpuProfile = {
    startTime: 0,
    endTime: 1,
    samples: [],
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, hitCount: 0, children: [2, 3], positionTicks: [] },
      { id: 2, callFrame: { functionName: 'handle', scriptId: '1', url: 'file:///srv/app/a.js', lineNumber: 0, columnNumber: 0 }, hitCount: 6, children: [4], positionTicks: [] },
      { id: 3, callFrame: { functionName: 'parse', scriptId: '2', url: 'file:///srv/app/node_modules/x/i.js', lineNumber: 0, columnNumber: 0 }, hitCount: 2, children: [], positionTicks: [] },
      { id: 4, callFrame: { functionName: 'readFile', scriptId: '3', url: 'node:fs', lineNumber: 0, columnNumber: 0 }, hitCount: 2, children: [], positionTicks: [] },
    ],
  };
  const tree = cpuFlame(profile, { start: 0, end: 1 });

  it('lays out an icicle: children left-aligned under their parent', () => {
    const rects = layoutFlame(tree.root, 100);
    const at = (name: string): [number, number, number] | undefined => {
      const r = rects.find((rect) => rect.node.name === name);
      return r && [r.x, r.w, r.depth];
    };
    assert.deepEqual(at('(root)'), [0, 100, 0]);
    assert.deepEqual(at('handle'), [0, 80, 1]);
    assert.deepEqual(at('parse'), [80, 20, 1]);
    assert.deepEqual(at('readFile'), [0, 20, 2]);
  });

  it('skips frames too narrow to see and follows zoom paths across rebuilds', () => {
    assert.equal(layoutFlame(tree.root, 100, 25).some((r) => r.node.name === 'parse'), false);
    const handle = tree.root.children[0];
    assert.ok(handle);
    const again = cpuFlame(profile, { start: 1, end: 2 });
    assert.equal(findByPath(again.root, [nodeKey(handle)])?.name, 'handle');
    assert.equal(findByPath(again.root, ['nope']), null);
  });

  it('colours by where the code lives', () => {
    assert.deepEqual(
      ['file:///srv/app/a.js', 'file:///srv/app/node_modules/x/i.js', 'node:fs', ''].map((url) => frameKind({ name: 'f', url, line: 1, column: 1 })),
      ['app', 'deps', 'node', 'native'],
    );
  });
});

describe('OriginalsCache', () => {
  const position = { url: '/srv/app/dist/main.js', line: 2, column: 6 };
  const answer = { originals: { '/srv/app/dist/main.js:2:6': { file: '/srv/app/src/main.ts', line: 3, column: 1, name: 'main' } } };

  it('reads only well-formed answers', () => {
    assert.equal(parseOriginals(answer).get('/srv/app/dist/main.js:2:6')?.file, '/srv/app/src/main.ts');
    assert.equal(parseOriginals({ originals: { k: { file: 1 } } }).size, 0);
    assert.equal(parseOriginals('nope').size, 0);
  });

  it('asks once per position in one batch, then answers from memory', async () => {
    const asked: number[] = [];
    let updates = 0;
    const cache = new OriginalsCache(
      async (positions) => {
        asked.push(positions.length);
        return answer;
      },
      () => updates++,
    );
    assert.equal(cache.get(position), null, 'unknown until the CLI answers');
    cache.get({ ...position, line: 9 });
    cache.get(position);
    assert.equal(cache.get({ url: 'node:fs', line: 1, column: 1 }), null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(asked, [2]);
    assert.equal(updates, 1);
    assert.equal(cache.get(position)?.line, 3);
    assert.equal(cache.get({ ...position, line: 9 }), null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(asked, [2], 'no second request');
  });

  it('does not retry forever when the CLI is gone', async () => {
    let calls = 0;
    const cache = new OriginalsCache(async () => {
      calls++;
      throw new Error('offline');
    }, () => undefined);
    cache.get(position);
    await new Promise((resolve) => setTimeout(resolve, 0));
    cache.get(position);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls, 1);
  });
});
