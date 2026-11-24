import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CpuProfile } from '../src/cdp.js';
import { culpritWindow, insightTime, stallCulprit, summarizeInsights } from '../src/findings.js';
import { buildHostReport, buildReport } from '../src/report.js';
import { cpuFlame } from '../src/flame.js';
import { Timeline, type FindingsSpan } from '../src/timeline.js';
import { callFrame, hello, MiB, sample } from './fixtures.js';

const profile: CpuProfile = {
  startTime: 0,
  endTime: 1,
  samples: [],
  nodes: [
    { id: 1, callFrame: callFrame('(root)'), hitCount: 0, children: [2], positionTicks: [] },
    { id: 2, callFrame: callFrame('render', 41), hitCount: 9, children: [], positionTicks: [] },
  ],
};

describe('buildReport', () => {
  it('is null before hello', () => {
    assert.equal(buildReport(new Timeline()), null);
  });

  it('summarises CPU, loop, memory, GC, hot functions and the loop trace', () => {
    const timeline = new Timeline();
    timeline.apply(hello);
    timeline.apply(sample(1000, { cpu: { user: 0, system: 0 } }));
    timeline.apply(
      sample(2000, {
        cpu: { user: 500_000, system: 0 },
        uv: null,
        loopDelay: { min: 0, max: 250, mean: 3, stddev: 20, p50: 1, p90: 2, p99: 180 },
        gc: [{ start: 1500, duration: 200, kind: 'major' }],
        memory: { rss: 300 * MiB, heapTotal: 200 * MiB, heapUsed: 150 * MiB, external: 5 * MiB, arrayBuffers: MiB },
      }),
    );
    timeline.apply(sample(3000, { cpu: { user: 600_000, system: 100_000 } }));
    timeline.apply({ type: 'cpu-profile', start: 1000, end: 3000, profile });
    timeline.apply({
      type: 'loop-trace',
      start: 1000,
      end: 1250,
      events: [],
      counters: [
        { resource: 'Timeout', created: 2, executed: 4, settled: 1, busy: 3 },
        { resource: 'PROMISE', created: 9, executed: 9, settled: 9, busy: 1 },
      ],
      dropped: 7,
    });

    const report = buildReport(timeline);
    assert.ok(report);
    assert.equal(report.frames, 2);
    assert.deepEqual([report.from, report.to], [1000, 3000]);
    assert.deepEqual(report.cpu, { avg: 35, max: 50 });
    assert.equal(report.loop.delayP99, 180);
    assert.equal(report.loop.delayMax, 250);
    assert.equal(report.loop.iterationsPerSec, null);
    assert.equal(report.memory.rssMax, 300 * MiB);
    assert.equal(report.memory.processSwapMax, null);
    assert.deepEqual([report.gc.count, report.gc.pause, report.gc.maxPause, report.gc.pauseRatio], [1, 200, 200, 0.1]);
    assert.deepEqual(report.gc.byKind.major, { count: 1, pause: 200 });
    assert.deepEqual(report.insights.map((i) => [i.kind, i.count]), [
      ['loop-stall', 1],
      ['gc-pressure', 1],
    ]);
    assert.equal(report.insights[0]?.worst.kind === 'loop-stall' && report.insights[0].worst.cause, 'gc');
    assert.deepEqual(report.hotFunctions.map((f) => [f.name, f.line]), [['render', 42]]);
    assert.deepEqual(report.topAllocations, []);
    assert.ok(report.loopTrace);
    assert.equal(report.loopTrace.executed.timer, 4);
    assert.equal(report.loopTrace.dropped, 7);
    assert.deepEqual(report.loopTrace.queues.map((q) => [q.resource, q.pending]), [['Timeout', 1]]);
  });
});

describe('stall culprits', () => {
  const blocking: CpuProfile = {
    ...profile,
    nodes: [
      { id: 1, callFrame: callFrame('(root)'), hitCount: 0, children: [2, 3], positionTicks: [] },
      { id: 2, callFrame: callFrame('(idle)'), hitCount: 50, children: [], positionTicks: [] },
      { id: 3, callFrame: callFrame('blockingReport', 8), hitCount: 30, children: [], positionTicks: [] },
    ],
  };

  it('picks the busiest function of the window overlapping the stall', () => {
    const windows = [culpritWindow(cpuFlame(profile, { start: 0, end: 1000 })), culpritWindow(cpuFlame(blocking, { start: 1000, end: 2000 }))];
    assert.equal(stallCulprit(windows, { t: 1900, spanMs: 1000 }).culprit?.name, 'blockingReport');
    assert.equal(stallCulprit(windows, { t: 900, spanMs: 1000 }).culprit?.name, 'render');
    assert.equal(stallCulprit(windows, { t: 1300, spanMs: 1000 }).culprit?.name, 'render', 'most of the span lies in the first window');
    assert.deepEqual(stallCulprit([], { t: 900, spanMs: 1000 }), { culprit: null, culpritStack: null });
  });

  it('finds the culprit of an early stall in a long run and looks back over the whole stretched frame', () => {
    const timeline = new Timeline({ cpuWindows: 2 });
    timeline.apply({ ...hello, intervalMs: 1000 });
    timeline.apply(sample(1000));
    // The stall delayed the tick: the frame covers 2.5 s, most of it in the blocking window before the last second.
    timeline.apply(sample(3500, { loopDelay: { min: 0, max: 1400, mean: 5, stddev: 30, p50: 0, p90: 1, p99: 1400 } }));
    // [t - interval, t] would overlap the second window more; the whole frame overlaps the first.
    timeline.apply({ type: 'cpu-profile', start: 1000, end: 2800, profile: blocking });
    timeline.apply({ type: 'cpu-profile', start: 2800, end: 4000, profile });
    for (let t = 4000; t < 30_000; t += 1000) timeline.apply({ type: 'cpu-profile', start: t, end: t + 1000, profile });
    assert.equal(timeline.cpuWindows().length, 2, 'the flame graph keeps only the last windows');
    const report = buildReport(timeline);
    assert.equal(report?.insights.find((i) => i.kind === 'loop-stall')?.culprit?.name, 'blockingReport');
    assert.deepEqual(
      report?.hotFunctions.map((f) => [f.name, f.self]),
      [
        ['render', 9 * 27],
        ['blockingReport', 30],
      ],
      'hot functions cover the whole run',
    );
  });

  it('builds findings and the report once per timeline version', () => {
    const timeline = new Timeline();
    timeline.apply(hello);
    timeline.apply(sample(1000));
    const version = timeline.version;
    assert.equal(timeline.insights(), timeline.insights());
    assert.equal(timeline.findings(), timeline.findings());
    assert.notEqual(timeline.findings({ loopStallMs: 1 }), timeline.findings());
    const report = buildReport(timeline);
    assert.equal(buildReport(timeline), report);
    assert.notEqual(buildReport(timeline, { hotLimit: 3 }), report);
    timeline.apply(sample(2000));
    assert.equal(timeline.version, version + 1);
    assert.notEqual(buildReport(timeline), report);
    assert.equal(buildReport(timeline)?.frames, 1);
  });

  it('names the culprit of a non-GC stall in the report', () => {
    const timeline = new Timeline();
    timeline.apply(hello);
    timeline.apply(sample(1000));
    timeline.apply(sample(2000, { loopDelay: { min: 0, max: 300, mean: 5, stddev: 30, p50: 0, p90: 1, p99: 290 } }));
    timeline.apply({ type: 'cpu-profile', start: 1000, end: 2000, profile: blocking });
    const stall = timeline.findings().find((i) => i.kind === 'loop-stall');
    assert.deepEqual(buildReport(timeline)?.insights, timeline.findings());
    assert.equal(stall?.culprit?.name, 'blockingReport');
    assert.equal(stall?.culprit?.line, 9);
    assert.deepEqual(stall?.culpritStack?.frames.map((f) => f.name), ['blockingReport']);
    assert.equal(stall?.culpritStack?.share, 1);
  });

  it('counts only the findings in a span, with the worst of those', () => {
    const timeline = new Timeline();
    timeline.apply(hello);
    const stall = (max: number) => ({ loopDelay: { min: 0, max, mean: 5, stddev: 30, p50: 0, p90: 1, p99: max } });
    for (const t of [1000, 2000, 3000, 4000, 5000]) timeline.apply(sample(t, t === 2000 ? stall(300) : t === 4000 ? stall(500) : {}));
    const stalls = (span: FindingsSpan) => timeline.findings({}, span).find((i) => i.kind === 'loop-stall');
    assert.deepEqual([stalls({})?.count, stalls({})?.worst], [2, timeline.insights().find((i) => i.kind === 'loop-stall' && i.t === 4000)]);
    assert.equal(stalls({ since: 3000 })?.count, 1);
    const early = stalls({ until: 3000 });
    assert.deepEqual([early?.count, early === undefined ? null : insightTime(early.worst)], [1, 2000]);
    assert.equal(stalls({ since: 4500 }), undefined);
    assert.equal(insightTime({ kind: 'heap-growth', trend: { from: 1, to: 9, bytesPerMin: 1, r2: 1 } }), 9);
  });
});

describe('summarizeInsights', () => {
  it('keeps one line per kind with its worst occurrence', () => {
    const summary = summarizeInsights([
      { kind: 'loop-stall', t: 1, delay: 120, gcPause: 0, cause: 'unknown' },
      { kind: 'detached-contexts', t: 2, count: 1 },
      { kind: 'loop-stall', t: 3, delay: 900, gcPause: 0, cause: 'unknown' },
      { kind: 'loop-stall', t: 4, delay: 300, gcPause: 0, cause: 'unknown' },
    ]);
    assert.deepEqual(summary.map((s) => [s.kind, s.count, s.worst.kind === 'loop-stall' ? s.worst.delay : s.worst.kind === 'detached-contexts' ? s.worst.t : -1]), [
      ['loop-stall', 3, 900],
      ['detached-contexts', 1, 2],
    ]);
  });
});

describe('buildHostReport', () => {
  it('reports swap and per-GPU peaks, null where unknown', () => {
    const gpu = { index: 0, name: 'Apple M4 Pro', memoryTotal: null, processMemory: null };
    const report = buildHostReport([
      { type: 'host', t: 1, swap: { total: 4 * 1024 * MiB, used: MiB }, gpus: [{ ...gpu, utilization: 0.2, memoryUsed: 100 }] },
      { type: 'host', t: 2, swap: { total: 6 * 1024 * MiB, used: 3 * MiB }, gpus: [{ ...gpu, utilization: 0.6, memoryUsed: 300 }] },
      { type: 'host', t: 3, swap: { total: 5 * 1024 * MiB, used: 2 * MiB }, gpus: [] },
    ]);
    assert.equal(report.swapUsedMax, 3 * MiB);
    assert.equal(report.swapTotal, 6 * 1024 * MiB, 'the largest total seen');
    assert.deepEqual(report.gpus, [{ index: 0, name: 'Apple M4 Pro', utilization: { avg: 0.4, max: 0.6 }, memoryUsedMax: 300, memoryTotal: null, processMemoryMax: null }]);
    assert.deepEqual(buildHostReport([]), { swapUsedMax: null, swapTotal: null, gpus: [] });
  });
});
