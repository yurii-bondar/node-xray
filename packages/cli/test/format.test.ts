import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkBudgets, formatBytes, formatMs, parseBudgets, type Budget, type SourceReport } from '@node-xray/core';
import { formatBudgets, formatHost, formatReport, shortPath } from '../src/format.js';

const MiB = 1024 * 1024;
const kinds = { count: 0, pause: 0 };

const report: SourceReport = {
  pid: 4242,
  threadId: 0,
  argv: ['/usr/bin/node', '/srv/app/server.js'],
  nodeVersion: 'v24.15.0',
  from: 1000,
  to: 61_000,
  frames: 60,
  cpu: { avg: 35, max: 98 },
  loop: { utilization: { avg: 0.41, max: 0.97 }, delayP99: 180, delayMax: 250, iterationsPerSec: { avg: 1234, max: 2000 } },
  memory: {
    rssMax: 300 * MiB,
    heapUsedMax: 150 * MiB,
    heapLimit: 4096 * MiB,
    externalMax: 5 * MiB,
    memoryLimit: 1024 * MiB,
    processSwapMax: null,
    majorFaultsPerSec: { avg: 0, max: 0 },
    heapGrowthPerMin: null,
    nativeGrowthPerMin: null,
  },
  gc: { count: 12, pause: 400, maxPause: 200, pauseRatio: 400 / 60_000, byKind: { minor: { count: 10, pause: 100 }, major: { count: 2, pause: 300 }, incremental: kinds, weakcb: kinds, other: kinds } },
  overhead: { avg: 0.2, max: 1.5 },
  insights: [
    {
      kind: 'loop-stall',
      count: 3,
      worst: { kind: 'loop-stall', t: 31_000, delay: 900, gcPause: 0, cause: 'unknown' },
      culprit: { name: 'renderReport', url: 'file:///srv/app/report.js', line: 42, column: 3, self: 30, total: 30, selfShare: 0.6 },
    },
  ],
  hotFunctions: [{ name: 'renderReport', url: '/srv/app/report.js', line: 42, column: 3, self: 30, total: 30, selfShare: 0.6 }],
  topAllocations: [],
  loopTrace: {
    traced: 10_000,
    executed: { timer: 4, io: 2, immediate: 0, nextTick: 3, microtask: 0, promise: 12 },
    busy: { timer: 5, io: 1, immediate: 0, nextTick: 0.2, microtask: 0, promise: 2 },
    dropped: 0,
    queues: [{ resource: 'PROMISE', category: 'promise', pending: 7, created: 19, executed: 12, busy: 2 }],
  },
  http: {
    server: {
      requests: 1200,
      failed: 3,
      errorRate: 0.01,
      rps: 20,
      p50: 4,
      p90: 30,
      p99: 480,
      max: 1300,
      statuses: { '1xx': 0, '2xx': 1180, '3xx': 0, '4xx': 11, '5xx': 9 },
      routes: [{ key: 'GET /users/:id', count: 1000, errors: 2, totalMs: 9000, maxMs: 300 }],
      slowest: [{ route: 'GET /report', status: 200, ms: 1300 }],
    },
    client: null,
  },
  io: {
    fs: null,
    fsSync: {
      calls: 3,
      errors: 0,
      perSec: 0.05,
      totalMs: 42,
      p50: 10,
      p99: 30,
      max: 30,
      operations: [{ key: 'readFileSync /srv/app/config/big.json', count: 1, errors: 0, totalMs: 30, maxMs: 30 }],
      slowest: [],
    },
    dns: null,
  },
};

describe('units', () => {
  it('formats bytes and durations', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1536), '1.5 KiB');
    assert.equal(formatBytes(300 * MiB), '300.0 MiB');
    assert.equal(formatBytes(4096 * MiB), '4.00 GiB');
    assert.equal(formatMs(0.25), '0.3 ms');
    assert.equal(formatMs(180), '180 ms');
    assert.equal(formatMs(61_000), '1.0 min');
  });

  it('shortens paths under cwd and leaves the rest', () => {
    assert.equal(shortPath('file:///srv/app/src/x.js', '/srv/app'), 'src/x.js');
    assert.equal(shortPath('/srv/app/My%20Dir/x.js', '/srv/app'), 'My%20Dir/x.js');
    assert.equal(shortPath('file:///srv/app/My%20Dir/x.js', '/srv/app'), 'My Dir/x.js');
    assert.equal(shortPath('/etc/hosts', '/srv/app'), '/etc/hosts');
    assert.equal(shortPath('node:internal/timers', '/srv/app'), 'node:internal/timers');
  });
});

describe('formatReport', () => {
  const text = formatReport(report, { cwd: '/srv/app', originals: new Map() });

  it('has one line per section', () => {
    assert.match(text, /^── node server\.js {2}\(pid 4242, v24\.15\.0, 1\.0 min, 60 samples\)$/m);
    assert.match(text, /CPU {9}avg 35\.0 % {2}max 98\.0 % of one core/);
    assert.match(text, /delay p99 180 ms max 250 ms {3}1234 iterations\/s/);
    assert.match(text, /RSS max 300\.0 MiB of 1\.00 GiB/);
    assert.match(text, /Swap {8}process not reported on this OS/);
    assert.match(text, /GC {10}12 runs, 400 ms paused \(0\.7 %\), longest 200 ms {3}minor 10 \/ 100 ms {2}major 2 \/ 300 ms/);
  });

  it('shows what went through the loop and what is still queued', () => {
    assert.match(text, /Loop trace {2}10\.00 s traced: timers 4 \(5\.0 ms\) {2}I\/O 2 \(1\.0 ms\) {2}nextTicks 3 \(0\.2 ms\) {2}promises 12 \(2\.0 ms\)/);
    assert.match(text, /still pending: PROMISE 7/);
  });

  it('summarises HTTP traffic with the heaviest routes', () => {
    assert.match(text, /HTTP in {5}1200 requests \(20\.0\/s\), errors 1\.0 % {3}p50 4\.0 ms p90 30 ms p99 480 ms max 1\.30 s/);
    assert.match(text, /2xx 1180 {2}4xx 11 {2}5xx 9 {2}failed 3/);
    assert.match(text, /9\.00 s in GET \/users\/:id ×1000 \(avg 9\.0 ms, max 300 ms, 2 errors\)/);
    assert.match(text, /slowest: GET \/report 1\.30 s → 200/);
    assert.doesNotMatch(text, /HTTP out/);
  });

  it('shows file system calls with paths under cwd shortened', () => {
    assert.match(text, /Files sync {2}3 calls \(0\.1\/s\) {3}p50 10 ms p99 30 ms max 30 ms, blocked the loop 42 ms/);
    assert.match(text, /30 ms in readFileSync config\/big\.json ×1 \(max 30 ms\)/);
    assert.doesNotMatch(text, /── DNS|^ {2}DNS/m);
  });

  it('explains findings and points at the code', () => {
    assert.match(text, /! loop-stall ×3, worst: event loop stalled 900 ms at \+30\.00 s \(synchronous code\)/);
    assert.match(text, /likely in renderReport {2}report\.js:42 \(60\.0 % of CPU in that window\)/);
    assert.match(text, /60\.0 % {2}renderReport {2}report\.js:42/);
  });

  it('shows the original source when a source map resolved the frame', () => {
    const originals = new Map([['/srv/app/report.js:42:3', { file: '/srv/app/src/report.ts', line: 17, column: 5, name: 'renderReport' }]]);
    assert.match(formatReport(report, { cwd: '/srv/app', originals }), /60\.0 % {2}renderReport {2}src\/report\.ts:17/);
  });

  it('says so when the process ended before the first sample', () => {
    assert.match(formatReport({ ...report, frames: 0 }, { cwd: '/', originals: new Map() }), /no samples/);
  });
});

describe('formatHost', () => {
  it('prints swap and GPUs, nothing when there is nothing', () => {
    assert.equal(formatHost({ swapUsedMax: null, swapTotal: null, gpus: [] }), null);
    const text = formatHost({
      swapUsedMax: MiB,
      swapTotal: 2048 * MiB,
      gpus: [{ index: 0, name: 'Apple M4 Pro', utilization: { avg: 0.2, max: 0.5 }, memoryUsedMax: 900 * MiB, memoryTotal: null, processMemoryMax: null }],
    });
    assert.equal(text, '── host\n  system swap max 1.0 MiB of 2.00 GiB\n  GPU 0 Apple M4 Pro: busy avg 20.0 % max 50.0 %, memory max 900.0 MiB (shared)');
  });
});

describe('formatBudgets', () => {
  it('marks met, broken and skipped budgets', () => {
    const budgets = parseBudgets(['loop.p99<200ms,loop.max<100ms,heap.growth<1MiB/min']) as Budget[];
    const text = formatBudgets(checkBudgets(budgets, [report]));
    assert.equal(
      text,
      ['── budgets: 1 broken, 1 met, 1 without data', '  ✓ loop.p99<200ms: 180 ms', '  ✗ loop.max<100ms: 250 ms', '  – heap.growth<1MiB/min: no data in this run'].join('\n'),
    );
    const two = formatBudgets(checkBudgets(budgets.slice(0, 1), [report, { ...report, pid: 7, threadId: 1 }]));
    assert.match(two, /✓ loop\.p99<200ms: 180 ms \(pid 7, worker 1\)/);
  });
});
