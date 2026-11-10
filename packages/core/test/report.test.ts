import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CpuProfile } from '../src/cdp.js';
import { buildHostReport, buildReport, stallCulprit, summarizeInsights } from '../src/report.js';
import { cpuFlame } from '../src/flame.js';
import { Timeline } from '../src/timeline.js';
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
    const windows = [cpuFlame(profile, { start: 0, end: 1000 }), cpuFlame(blocking, { start: 1000, end: 2000 })];
    assert.equal(stallCulprit(windows, 1900, 1000)?.name, 'blockingReport');
    assert.equal(stallCulprit(windows, 900, 1000)?.name, 'render');
    assert.equal(stallCulprit([], 900, 1000), null);
  });

  it('names the culprit of a non-GC stall in the report', () => {
    const timeline = new Timeline();
    timeline.apply(hello);
    timeline.apply(sample(1000));
    timeline.apply(sample(2000, { loopDelay: { min: 0, max: 300, mean: 5, stddev: 30, p50: 0, p90: 1, p99: 290 } }));
    timeline.apply({ type: 'cpu-profile', start: 1000, end: 2000, profile: blocking });
    const stall = buildReport(timeline)?.insights.find((i) => i.kind === 'loop-stall');
    assert.equal(stall?.culprit?.name, 'blockingReport');
    assert.equal(stall?.culprit?.line, 9);
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
