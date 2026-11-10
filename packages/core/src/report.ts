// Summary of a run: what a person reads after `xray run` exits, and what CI compares.

import { hotFunctions, withoutScript, type FlameTree, type HotFunction } from './flame.js';
import type { Frame } from './frame.js';
import { summarizeHttp, type HttpSummary } from './http.js';
import { summarizeIo, type IoSummary } from './io.js';
import { DEFAULT_INSIGHT_OPTIONS, floorTrend, type Insight, type InsightKind, type InsightOptions } from './insights.js';
import { TASK_CATEGORIES, type QueueState, type TaskCategory, type TraceWindow } from './loop.js';
import { GC_KINDS, type GcKind, type HostSample } from './protocol.js';
import type { Timeline } from './timeline.js';

export interface Range {
  readonly avg: number;
  readonly max: number;
}

export interface InsightSummary {
  readonly kind: InsightKind;
  /** Frames it fired in (1 for state findings). */
  readonly count: number;
  /** The most severe occurrence. */
  readonly worst: Insight;
  /** For a loop stall not caused by GC: the busiest function of the CPU window around it. */
  readonly culprit: HotFunction | null;
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
  /** Empty unless CPU profiling ran. */
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

function severity(insight: Insight): number {
  switch (insight.kind) {
    case 'loop-stall':
      return insight.delay;
    case 'gc-pressure':
      return insight.pauseRatio;
    case 'swapping':
      return insight.majorFaultsPerSec;
    case 'heap-growth':
    case 'native-growth':
      return insight.trend.bytesPerMin;
    case 'near-heap-limit':
      return insight.used / insight.limit;
    case 'near-memory-limit':
      return insight.rss / insight.limit;
    case 'detached-contexts':
      return insight.count;
    case 'http-errors':
      return insight.rate;
    case 'http-slow':
      return insight.p99;
    case 'http-stuck':
      return insight.oldest.ageMs;
    case 'fs-blocking':
    case 'dns-slow':
      return insight.ms;
    default: {
      const unreachable: never = insight;
      return unreachable;
    }
  }
}

/** One line per kind, worst first within the kind, kinds in first-seen order. */
export function summarizeInsights(insights: readonly Insight[]): InsightSummary[] {
  const byKind = new Map<InsightKind, { count: number; worst: Insight }>();
  for (const insight of insights) {
    const entry = byKind.get(insight.kind);
    if (entry === undefined) byKind.set(insight.kind, { count: 1, worst: insight });
    else {
      entry.count++;
      if (severity(insight) > severity(entry.worst)) entry.worst = insight;
    }
  }
  return [...byKind].map(([kind, { count, worst }]) => ({ kind, count, worst, culprit: null }));
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

/** Busiest function of the CPU window that overlaps `[t - spanMs, t]` the most. */
export function stallCulprit(windows: readonly FlameTree[], t: number, spanMs: number): HotFunction | null {
  let best: FlameTree | null = null;
  let bestOverlap = 0;
  for (const window of windows) {
    const overlap = Math.min(window.end, t) - Math.max(window.start, t - spanMs);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = window;
    }
  }
  return best === null ? null : (hotFunctions(best, 1)[0] ?? null);
}

export interface ReportOptions {
  readonly hotLimit: number;
  readonly insights: Partial<InsightOptions>;
}

/** `null` until the source has said hello. */
export function buildReport(timeline: Timeline, overrides: Partial<ReportOptions> = {}): SourceReport | null {
  const hello = timeline.hello;
  if (hello === null) return null;
  const options: ReportOptions = { hotLimit: 10, insights: {}, ...overrides };
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
  // The agent's own frames are not the application's work.
  const cpuWindows = timeline.cpuWindows().map((window) => withoutScript(window, hello.agentScript));
  const allAllocations = timeline.allocations();
  const allocations = allAllocations === null ? null : withoutScript(allAllocations, hello.agentScript);
  const cpu = timeline.cpuFlame();
  const insights = summarizeInsights(timeline.insights(options.insights)).map((summary) =>
    summary.worst.kind === 'loop-stall' && summary.worst.cause === 'unknown'
      ? { ...summary, culprit: stallCulprit(cpuWindows, summary.worst.t, hello.intervalMs) }
      : summary,
  );

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
    insights,
    hotFunctions: cpu ? hotFunctions(withoutScript(cpu, hello.agentScript), options.hotLimit) : [],
    topAllocations: allocations ? hotFunctions(allocations, options.hotLimit) : [],
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
