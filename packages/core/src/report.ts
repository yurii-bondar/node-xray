// Summary of a run: what a person reads after `xray run` exits, and what CI compares.

import type { InsightSummary } from './findings.js';
import { hotFunctions, withoutScript, type FlameTree, type HotFunction } from './flame.js';
import type { Frame } from './frame.js';
import { summarizeHttp, type HttpSummary } from './http.js';
import { summarizeIo, type IoSummary } from './io.js';
import { DEFAULT_INSIGHT_OPTIONS, floorTrend, type InsightOptions } from './insights.js';
import { TASK_CATEGORIES, type QueueState, type TaskCategory, type TraceWindow } from './loop.js';
import { GC_KINDS, type GcKind, type Hello, type HostSample } from './protocol.js';
import type { Timeline } from './timeline.js';

export interface Range {
  readonly avg: number;
  readonly max: number;
}

export interface LoopTraceSummary {
  /** ms covered by trace batches. */
  readonly traced: number;
  readonly executed: Readonly<Record<TaskCategory, number>>;
  /** Callback time per category, ms (inclusive of nested callbacks). */
  readonly busy: Readonly<Record<TaskCategory, number>>;
  readonly dropped: number;
  /** Still pending when the run ended, most first. */
  readonly queues: readonly QueueState[];
}

export interface SourceReport {
  readonly pid: number;
  readonly threadId: number;
  readonly argv: readonly string[];
  readonly nodeVersion: string;
  readonly from: number;
  readonly to: number;
  readonly frames: number;
  /** Percent of one core. */
  readonly cpu: Range;
  readonly loop: {
    readonly utilization: Range;
    /** Worst per-frame p99 delay, ms. */
    readonly delayP99: number;
    readonly delayMax: number;
    readonly iterationsPerSec: Range | null;
  };
  readonly memory: {
    readonly rssMax: number;
    readonly heapUsedMax: number;
    readonly heapLimit: number;
    readonly externalMax: number;
    readonly memoryLimit: number;
    readonly processSwapMax: number | null;
    readonly majorFaultsPerSec: Range;
    /** Slope of the post-GC heap floor; null until there are enough 30 s buckets (a few minutes). */
    readonly heapGrowthPerMin: number | null;
    /** Same for memory outside the JS heap (RSS − heap total). */
    readonly nativeGrowthPerMin: number | null;
  };
  readonly gc: {
    readonly count: number;
    /** ms */
    readonly pause: number;
    readonly maxPause: number;
    /** pause / wall time, 0..1. */
    readonly pauseRatio: number;
    readonly byKind: Readonly<Record<GcKind, { readonly count: number; readonly pause: number }>>;
  };
  /** Agent's own main-thread time, percent. */
  readonly overhead: Range;
  readonly insights: readonly InsightSummary[];
  /** Over the whole run (every CPU window), the agent's own frames left out; empty unless CPU profiling ran. */
  readonly hotFunctions: readonly HotFunction[];
  /** Empty unless heap sampling ran; weights are bytes. */
  readonly topAllocations: readonly HotFunction[];
  readonly loopTrace: LoopTraceSummary | null;
  /** Requests served and made over the run; null for a side with no traffic. */
  readonly http: { readonly server: HttpSummary | null; readonly client: HttpSummary | null };
  /** File system (async and *Sync) and DNS over the run; null for a kind with no calls. */
  readonly io: { readonly fs: IoSummary | null; readonly fsSync: IoSummary | null; readonly dns: IoSummary | null };
}

function range(frames: readonly Frame[], value: (frame: Frame) => number): Range {
  if (frames.length === 0) return { avg: 0, max: 0 };
  let sum = 0;
  let max = Number.NEGATIVE_INFINITY;
  for (const frame of frames) {
    const v = value(frame);
    sum += v;
    if (v > max) max = v;
  }
  return { avg: sum / frames.length, max };
}

function maxOf(frames: readonly Frame[], value: (frame: Frame) => number): number {
  let max = 0;
  for (const frame of frames) max = Math.max(max, value(frame));
  return max;
}

function summarizeLoopTrace(windows: readonly TraceWindow[], queues: readonly QueueState[]): LoopTraceSummary | null {
  if (windows.length === 0) return null;
  const executed = {} as Record<TaskCategory, number>;
  const busy = {} as Record<TaskCategory, number>;
  for (const category of TASK_CATEGORIES) {
    executed[category] = 0;
    busy[category] = 0;
  }
  let traced = 0;
  let dropped = 0;
  for (const window of windows) {
    traced += window.end - window.start;
    dropped += window.dropped;
    for (const category of TASK_CATEGORIES) {
      executed[category] += window.byCategory[category].executed;
      busy[category] += window.byCategory[category].busy;
    }
  }
  return { traced, executed, busy, dropped, queues: queues.filter((q) => q.pending > 0) };
}

export interface ReportOptions {
  readonly hotLimit: number;
  readonly insights: Partial<InsightOptions>;
}

/** Hot functions of one tree without the agent's frames (not the application's work), kept while the tree object lives (a whole-run tree changes per CPU window, not per report). */
const hotByTree = new WeakMap<FlameTree, { readonly key: string; readonly hot: readonly HotFunction[] }>();

function hotOf(tree: FlameTree, agentScript: string, limit: number): readonly HotFunction[] {
  const key = `${limit}\u0000${agentScript}`;
  const memo = hotByTree.get(tree);
  if (memo?.key === key) return memo.hot;
  const hot = hotFunctions(withoutScript(tree, agentScript), limit);
  hotByTree.set(tree, { key, hot });
  return hot;
}

/** The last report per timeline, valid while its version and the options stay the same. */
const reports = new WeakMap<Timeline, { readonly version: number; readonly key: string; readonly report: SourceReport }>();

/** `null` until the source has said hello. Built once per timeline version and options (callers share the result). */
export function buildReport(timeline: Timeline, overrides: Partial<ReportOptions> = {}): SourceReport | null {
  const hello = timeline.hello;
  if (hello === null) return null;
  const options: ReportOptions = { hotLimit: 10, insights: {}, ...overrides };
  const key = JSON.stringify(options);
  const memo = reports.get(timeline);
  if (memo !== undefined && memo.version === timeline.version && memo.key === key) return memo.report;
  const report = createReport(timeline, hello, options);
  reports.set(timeline, { version: timeline.version, key, report });
  return report;
}

function createReport(timeline: Timeline, hello: Hello, options: ReportOptions): SourceReport {
  const trendOptions: InsightOptions = { ...DEFAULT_INSIGHT_OPTIONS, ...options.insights };
  const frames = timeline.frames();
  const first = frames[0];
  const last = frames[frames.length - 1];
  const elapsed = first && last ? last.t - first.t + first.dt : 0;

  const byKind = {} as Record<GcKind, { count: number; pause: number }>;
  for (const kind of GC_KINDS) byKind[kind] = { count: 0, pause: 0 };
  let gcPause = 0;
  let gcCount = 0;
  for (const frame of frames) {
    gcCount += frame.gc.count;
    gcPause += frame.gc.pause;
    for (const kind of GC_KINDS) {
      byKind[kind].count += frame.gc.byKind[kind].count;
      byKind[kind].pause += frame.gc.byKind[kind].pause;
    }
  }

  const withUv = frames.filter((frame) => frame.loop.iterationsPerSec !== null);
  const swapFrames = frames.filter((frame) => frame.os.processSwap !== null);
  const cpu = timeline.cpuFlameTotal();
  const allocations = timeline.allocations();

  return {
    pid: hello.pid,
    threadId: hello.threadId,
    argv: hello.argv,
    nodeVersion: hello.nodeVersion,
    from: first ? first.t - first.dt : hello.timeOrigin,
    to: last ? last.t : hello.timeOrigin,
    frames: frames.length,
    cpu: range(frames, (frame) => frame.cpu.total),
    loop: {
      utilization: range(frames, (frame) => frame.loop.utilization),
      delayP99: maxOf(frames, (frame) => frame.loop.delay.p99),
      delayMax: maxOf(frames, (frame) => frame.loop.delay.max),
      iterationsPerSec: withUv.length > 0 ? range(withUv, (frame) => frame.loop.iterationsPerSec ?? 0) : null,
    },
    memory: {
      rssMax: maxOf(frames, (frame) => frame.memory.rss),
      heapUsedMax: maxOf(frames, (frame) => frame.memory.heapUsed),
      heapLimit: last?.heap.limit ?? 0,
      externalMax: maxOf(frames, (frame) => frame.memory.external),
      memoryLimit: last?.os.memoryLimit ?? hello.totalMemory,
      processSwapMax: swapFrames.length > 0 ? maxOf(swapFrames, (frame) => frame.os.processSwap ?? 0) : null,
      majorFaultsPerSec: range(frames, (frame) => frame.os.majorFaultsPerSec),
      heapGrowthPerMin: floorTrend(frames, (frame) => frame.memory.heapUsed, trendOptions)?.bytesPerMin ?? null,
      nativeGrowthPerMin: floorTrend(frames, (frame) => frame.memory.rss - frame.memory.heapTotal, trendOptions)?.bytesPerMin ?? null,
    },
    gc: { count: gcCount, pause: gcPause, maxPause: maxOf(frames, (frame) => frame.gc.maxPause), pauseRatio: elapsed > 0 ? gcPause / elapsed : 0, byKind },
    overhead: range(frames, (frame) => frame.overhead),
    insights: timeline.findings(options.insights),
    hotFunctions: cpu ? hotOf(cpu, hello.agentScript, options.hotLimit) : [],
    topAllocations: allocations ? hotOf(allocations, hello.agentScript, options.hotLimit) : [],
    loopTrace: summarizeLoopTrace(timeline.traceWindows(), timeline.queues()),
    http: { server: summarizeHttp(timeline.httpWindows(), 'server'), client: summarizeHttp(timeline.httpWindows(), 'client') },
    io: { fs: summarizeIo(timeline.ioWindows(), 'fs'), fsSync: summarizeIo(timeline.ioWindows(), 'fsSync'), dns: summarizeIo(timeline.ioWindows(), 'dns') },
  };
}

export interface GpuReport {
  readonly index: number;
  readonly name: string;
  /** 0..1; `null` when the driver does not report it. */
  readonly utilization: Range | null;
  readonly memoryUsedMax: number;
  readonly memoryTotal: number | null;
  readonly processMemoryMax: number | null;
}

export interface HostReport {
  readonly swapUsedMax: number | null;
  readonly swapTotal: number | null;
  readonly gpus: readonly GpuReport[];
}

export function buildHostReport(samples: readonly HostSample[]): HostReport {
  let swapUsedMax: number | null = null;
  let swapTotal: number | null = null;
  const gpus = new Map<number, { name: string; utils: number[]; memoryUsedMax: number; memoryTotal: number | null; processMemoryMax: number | null }>();
  for (const sample of samples) {
    if (sample.swap !== null) {
      swapUsedMax = Math.max(swapUsedMax ?? 0, sample.swap.used);
      // macOS adds swap files as it needs them: the total grows during a run.
      swapTotal = Math.max(swapTotal ?? 0, sample.swap.total);
    }
    for (const gpu of sample.gpus) {
      let entry = gpus.get(gpu.index);
      if (entry === undefined) {
        entry = { name: gpu.name, utils: [], memoryUsedMax: 0, memoryTotal: gpu.memoryTotal, processMemoryMax: null };
        gpus.set(gpu.index, entry);
      }
      if (gpu.utilization !== null) entry.utils.push(gpu.utilization);
      entry.memoryUsedMax = Math.max(entry.memoryUsedMax, gpu.memoryUsed);
      if (gpu.processMemory !== null) entry.processMemoryMax = Math.max(entry.processMemoryMax ?? 0, gpu.processMemory);
    }
  }
  return {
    swapUsedMax,
    swapTotal,
    gpus: [...gpus].map(([index, entry]) => ({
      index,
      name: entry.name,
      utilization: entry.utils.length > 0 ? { avg: entry.utils.reduce((a, b) => a + b, 0) / entry.utils.length, max: Math.max(...entry.utils) } : null,
      memoryUsedMax: entry.memoryUsedMax,
      memoryTotal: entry.memoryTotal,
      processMemoryMax: entry.processMemoryMax,
    })),
  };
}
