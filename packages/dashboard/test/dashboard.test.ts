import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cpuFlame,
  encodeClosedRecord,
  encodeRecord,
  toLoopEvents,
  groupIterations,
  Timeline,
  toSourceId,
  type CpuProfile,
  type GcEvent,
  type Hello,
  type InsightSummary,
  type Iteration,
  type LoopTraceEvent,
  type Sample,
  type SourceId,
} from '@node-xray/core';
import { findByPath, frameKind, layoutFlame, nodeKey, stackAlong } from '../src/flame-layout.js';
import { parseTheme, parseThemeMessage } from '../src/host.js';
import { hitTest, iterationDetail, layoutLane, stepIteration } from '../src/lane-layout.js';
import { OriginalsCache, parseOriginals } from '../src/originals.js';
import { insightLevel, insightPage, pageAlerts, parseRoute } from '../src/nav.js';
import { columns, gcByKind, gcCoverageStart, gcLevel, keptSpan, markerTimes, pauseHistogram, PointCache, recentTotal, shortIoKey, sparkPath } from '../src/series.js';
import { lastResult, latestTime, LIVE, snapshotOf } from '../src/snapshot.js';
import { headerState, MAX_ENDED_SOURCES, parseStatus, sourceLabel, Store } from '../src/store.js';

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

function toId(pid: number, threadId = 0): SourceId {
  return toSourceId(pid, threadId);
}

/** A quiet sample at `t`; `gc` pauses as given. */
function sample(t: number, gc: Sample['gc'] = []): Sample {
  return {
    type: 'sample',
    t,
    cpu: { user: 0, system: 0 },
    loop: { idle: 0, active: 0 },
    loopDelay: { min: 0, max: 1, mean: 0.2, stddev: 0.1, p50: 0.1, p90: 0.5, p99: 0.9 },
    uv: null,
    memory: { rss: 100, heapTotal: 60, heapUsed: 40, external: 2, arrayBuffers: 1 },
    heap: { limit: 4096, totalAvailable: 4000, malloced: 1, peakMalloced: 2, nativeContexts: 1, detachedContexts: 0 },
    heapSpaces: [],
    gc,
    resources: [],
    rusage: { maxRss: 120, minorFaults: 0, majorFaults: 0, voluntarySwitches: 0, involuntarySwitches: 0, fsReads: 0, fsWrites: 0 },
    system: { free: 4096, available: null, limit: null, processSwap: null, loadAvg1: 0.5 },
    overheadUs: 0,
  };
}

/** A timeline with frames ending at 1000, 2000, … `seconds` s; `pauseAt` adds a GC pause of 100 ms to that second's frame. */
function timelineOf(seconds: number, pauseAt: readonly number[] = []): Timeline {
  const timeline = new Timeline();
  timeline.apply({ ...hello, intervalMs: 1000 });
  for (let s = 0; s <= seconds; s++) timeline.apply(sample(s * 1000, pauseAt.includes(s) ? [{ start: s * 1000 - 500, duration: 100, kind: 'minor' }] : []));
  return timeline;
}

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

  it('marks a source ended when its connection closes and keeps only the newest ended ones', () => {
    const store = new Store();
    const helloOf = (pid: number) => JSON.stringify({ ...hello, pid });
    store.applyLine(encodeRecord(1, helloOf(1)));
    store.applyLine(encodeRecord(2, JSON.stringify({ ...hello, pid: 1, threadId: 1 })));
    store.applyLine(encodeClosedRecord(1));
    assert.equal(store.sources.get(toId(1))?.ended, true);
    assert.equal(store.sources.get(toId(1, 1))?.ended, false);
    assert.equal(store.defaultSource()?.id, toId(1, 1), 'a live source comes before an ended main thread');
    store.applyLine(encodeClosedRecord(2));
    assert.equal(store.defaultSource()?.id, toId(1, 1), 'then the newest ended one');
    store.applyLine(encodeClosedRecord(99));
    for (let pid = 2; pid <= MAX_ENDED_SOURCES + 3; pid++) {
      store.applyLine(encodeRecord(pid + 10, helloOf(pid)));
      store.applyLine(encodeClosedRecord(pid + 10));
    }
    store.applyLine(encodeRecord(100, helloOf(1000)));
    assert.equal(store.sources.size, MAX_ENDED_SOURCES + 1, 'the live source is always kept');
    assert.equal(store.sources.has(toId(1)), false, 'the oldest ended ones are dropped');
    assert.equal(store.sources.has(toId(MAX_ENDED_SOURCES + 3)), true);
    assert.equal(store.defaultSource()?.id, toId(1000));
    assert.equal(store.rejected, 0);
  });

  it('says reconnecting while the stream is lost, and that commands cannot be sent', () => {
    const running = parseStatus('{"state":"running","command":"node a.js"}');
    assert.deepEqual(headerState(running, 'open'), { text: 'live · node a.js', tone: 'live', live: true });
    assert.deepEqual(headerState(running, 'lost'), { text: 'reconnecting… · node a.js', tone: 'done', live: false });
    assert.deepEqual(headerState(null, 'connecting'), { text: 'connecting…', tone: 'neutral', live: true });
    assert.equal(headerState(parseStatus('{"state":"replay","command":"r.xray.jsonl"}'), 'lost').text, 'r.xray.jsonl');
    assert.equal(headerState(parseStatus('{"state":"exited","command":"x","code":1}'), 'open').live, false);
    const store = new Store();
    const revision = store.revision;
    store.setConnection('lost');
    store.setConnection('lost');
    assert.equal(store.revision, revision + 1);
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
    assert.equal(findByPath(again.root, []), again.root);
  });

  it('lists the frames a zoom path passes through, stopping where the tree changed', () => {
    const handle = tree.root.children[0];
    const read = handle?.children[0];
    assert.ok(handle && read);
    assert.deepEqual(stackAlong(tree.root, [nodeKey(handle), nodeKey(read)]).map((n) => n.name), ['handle', 'readFile']);
    assert.deepEqual(stackAlong(tree.root, [nodeKey(handle), 'gone', nodeKey(read)]).map((n) => n.name), ['handle']);
    assert.deepEqual(stackAlong(tree.root, []), []);
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

describe('navigation', () => {
  it('reads the page from the hash and falls back to the overview', () => {
    assert.equal(parseRoute('#/gc'), 'gc');
    assert.equal(parseRoute('#loop'), 'loop');
    assert.equal(parseRoute(''), 'overview');
    assert.equal(parseRoute('#/nope'), 'overview');
  });

  it('sends each finding to its page and keeps the worst level per page', () => {
    assert.equal(insightPage('gc-pressure'), 'gc');
    assert.equal(insightPage('fs-blocking'), 'io');
    assert.equal(insightLevel('http-slow'), 'warn');
    const summary = (kind: InsightSummary['kind']): InsightSummary => ({ kind, count: 1, worst: { kind: 'detached-contexts', t: 0, count: 1 }, culprit: null, culpritStack: null });
    const alerts = pageAlerts([summary('http-slow'), summary('http-errors'), summary('heap-growth'), summary('http-slow')]);
    assert.equal(alerts.get('http'), 'bad');
    assert.equal(alerts.get('memory'), 'warn');
    assert.equal(alerts.has('loop'), false);
  });
});

describe('sparkPath', () => {
  it('scales from zero to the maximum and breaks at gaps', () => {
    assert.equal(sparkPath({ values: [0, 5, 10], width: 100, height: 20 }), 'M0.0 20.0 L50.0 10.0 L100.0 0.0');
    assert.equal(sparkPath({ values: [1, null, 1, 1], width: 30, height: 10 }), 'M0.0 0.0 M20.0 0.0 L30.0 0.0');
    assert.equal(sparkPath({ values: [0, 0], width: 10, height: 10 }), 'M0.0 10.0 L10.0 10.0');
    assert.equal(sparkPath({ values: [3], width: 10, height: 10 }), '');
  });
});

describe('GC summaries', () => {
  const gc = (kind: GcEvent['kind'], duration: number): GcEvent => ({ start: 0, duration, kind });
  const events = [gc('minor', 0.5), gc('minor', 2), gc('major', 120), gc('major', 300), gc('incremental', 6)];

  it('groups pauses by kind, most total first', () => {
    assert.deepEqual(
      gcByKind(events).map((row) => [row.kind, row.runs, row.max, row.total]),
      [
        ['major', 2, 300, 420],
        ['incremental', 1, 6, 6],
        ['minor', 2, 2, 2.5],
      ],
    );
  });

  it('counts pauses per bucket, the last one open-ended', () => {
    assert.deepEqual(pauseHistogram(events), [1, 1, 1, 0, 0, 1, 1]);
    assert.deepEqual(pauseHistogram([]), [0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('recent totals', () => {
  it('sums the frames of the last span, without the frame that ends at its start', () => {
    const frames = timelineOf(20, [10, 11, 20]).frames();
    assert.deepEqual(recentTotal(frames, { ms: 10_000, pick: (f) => f.gc.pause }), { total: 200, coveredMs: 10_000 }, 'the frame ending at 10 s is outside (10, 20]');
    assert.deepEqual(recentTotal(frames.slice(0, 3), { ms: 10_000, pick: (f) => f.gc.count }), { total: 0, coveredMs: 3000 }, 'a young run covers less');
    assert.deepEqual(recentTotal([], { ms: 10_000, pick: (f) => f.gc.pause }), { total: 0, coveredMs: 0 });
    assert.equal(keptSpan(frames), 20_000);
  });

  it('rates GC time by one rule', () => {
    assert.equal(gcLevel(0.2), 'bad');
    assert.equal(gcLevel(0.05), 'warn');
    assert.equal(gcLevel(0.01), 'ok');
  });

  it('says when the kept GC events start inside the window', () => {
    const events: GcEvent[] = [5000, 6000, 7000].map((start) => ({ start, duration: 1, kind: 'minor' }));
    assert.equal(gcCoverageStart(events, { from: 1000, capacity: 3 }), 5000, 'the ring is full: older ones were dropped');
    assert.equal(gcCoverageStart(events, { from: 1000, capacity: 10 }), null, 'nothing was dropped');
    assert.equal(gcCoverageStart(events, { from: 6000, capacity: 3 }), null, 'they cover the window');
    assert.equal(gcCoverageStart([], { from: 0, capacity: 3 }), null);
  });
});

describe('PointCache', () => {
  it('derives each window once and only the windows needed', () => {
    let derived = 0;
    const cache = new PointCache((w: { readonly end: number }) => {
      derived++;
      return { t: w.end };
    });
    const windows = [1000, 2000, 3000, 4000, 5000].map((end) => ({ end }));
    assert.deepEqual(cache.since(windows, 4000, 1).map((p) => p.t), [4000, 5000]);
    assert.deepEqual(cache.since(windows, Number.POSITIVE_INFINITY, 3).map((p) => p.t), [3000, 4000, 5000], 'at least the last `keep`');
    assert.equal(derived, 3);
    assert.equal(cache.since(windows, 0, 0).length, 5);
    assert.equal(derived, 5);
  });
});

describe('snapshot', () => {
  it('cuts every history at the pause and keeps it while paused', () => {
    const timeline = timelineOf(10, [3, 8]);
    const paused = snapshotOf(timeline, 5000);
    assert.deepEqual(paused.frames.map((f) => f.t), [1000, 2000, 3000, 4000, 5000]);
    assert.deepEqual(paused.gcEvents.map((e) => e.start), [2500]);
    timeline.apply(sample(11_000));
    assert.equal(snapshotOf(timeline, 5000), paused, 'new data does not change a paused view');
    const live = snapshotOf(timeline, LIVE);
    assert.equal(live.latest?.t, 11_000);
    assert.equal(snapshotOf(timeline, LIVE), live, 'the same until the next message');
    timeline.apply(sample(12_000));
    assert.notEqual(snapshotOf(timeline, LIVE), live);
    assert.equal(latestTime(timeline), 12_000);
    assert.equal(latestTime(new Timeline()), Number.NEGATIVE_INFINITY);
  });

  it('remembers the last result per arguments', () => {
    let calls = 0;
    const double = lastResult((a: object, n: number) => {
      calls++;
      return { a, n: n * 2 };
    });
    const key = {};
    assert.equal(double(key, 2), double(key, 2));
    assert.equal(calls, 1);
    double({}, 2);
    double(key, 3);
    assert.equal(calls, 3);
  });
});

describe('iteration keys', () => {
  const iterations = [1, 2, 3].map((index) => ({ index }) as Iteration);
  it('steps from the selected iteration, or the newest, and stops at the ends', () => {
    assert.equal(stepIteration(iterations, null, -1)?.index, 2);
    assert.equal(stepIteration(iterations, 1, -1)?.index, 1);
    assert.equal(stepIteration(iterations, 2, 1)?.index, 3);
    assert.equal(stepIteration(iterations, 2, Number.NEGATIVE_INFINITY)?.index, 1);
    assert.equal(stepIteration(iterations, 2, Number.POSITIVE_INFINITY)?.index, 3);
    assert.equal(stepIteration([], null, 1), undefined);
  });
});

describe('VS Code host', () => {
  it('takes only a light or dark theme message', () => {
    assert.equal(parseTheme('light'), 'light');
    assert.equal(parseTheme('sepia'), null);
    assert.equal(parseThemeMessage({ type: 'xray.theme', theme: 'dark' }), 'dark');
    assert.equal(parseThemeMessage({ type: 'xray.open', theme: 'dark' }), null);
    assert.equal(parseThemeMessage({ type: 'xray.theme', theme: 'blue' }), null);
    assert.equal(parseThemeMessage('xray.theme'), null);
  });
});
