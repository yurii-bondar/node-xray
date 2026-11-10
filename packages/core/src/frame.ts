// Two consecutive raw samples → one frame of rates and ratios, ready to chart.

import { GC_KINDS, type GcKind, type Hello, type HeapSpace, type HeapStats, type LoopDelay, type Memory, type ResourceCount, type Sample } from './protocol.js';
import { ratePerSecond } from './stats.js';

export interface GcKindWindow {
  readonly count: number;
  readonly pause: number;
}

export interface GcWindow {
  readonly count: number;
  /** Sum of pauses in the frame, ms. */
  readonly pause: number;
  readonly maxPause: number;
  /** Share of wall time spent in GC pauses, 0..1. */
  readonly pauseRatio: number;
  readonly byKind: Readonly<Record<GcKind, GcKindWindow>>;
}

export interface CpuWindow {
  /** Percent of one core; above 100 with worker threads or native threads busy. */
  readonly user: number;
  readonly system: number;
  readonly total: number;
  /** Percent of the whole machine (all cores). */
  readonly ofMachine: number;
}

export interface LoopWindow {
  /** Share of the frame the loop was busy, 0..1. */
  readonly utilization: number;
  readonly delay: LoopDelay;
  /** Loop iterations per second; `null` on Node without `uvMetricsInfo`. */
  readonly iterationsPerSec: number | null;
  /** libuv events (I/O completions, timers) processed per second. */
  readonly eventsPerSec: number | null;
}

export interface OsWindow {
  readonly rss: number;
  readonly maxRss: number;
  /** Memory the process may use: cgroup limit, else machine RAM. */
  readonly memoryLimit: number;
  /** rss / memoryLimit, 0..1. */
  readonly memoryShare: number;
  readonly processSwap: number | null;
  readonly systemFree: number;
  readonly systemAvailable: number | null;
  readonly majorFaultsPerSec: number;
  readonly minorFaultsPerSec: number;
  readonly voluntarySwitchesPerSec: number;
  readonly involuntarySwitchesPerSec: number;
  readonly fsReadsPerSec: number;
  readonly fsWritesPerSec: number;
  readonly loadAvg1: number;
}

export interface Frame {
  /** Epoch ms at the end of the frame. */
  readonly t: number;
  /** Frame length, ms. */
  readonly dt: number;
  readonly cpu: CpuWindow;
  readonly loop: LoopWindow;
  readonly memory: Memory;
  readonly heap: HeapStats;
  readonly heapSpaces: readonly HeapSpace[];
  readonly gc: GcWindow;
  readonly resources: readonly ResourceCount[];
  readonly os: OsWindow;
  /** CPU the agent itself used, percent of one core. */
  readonly overhead: number;
}

/** Facts about the source that do not change between samples. */
export type SourceFacts = Pick<Hello, 'cpus' | 'totalMemory'>;

export interface DeriveFrameArgs {
  readonly prev: Sample;
  readonly cur: Sample;
  readonly facts: SourceFacts;
}

function gcWindow(sample: Sample, dt: number): GcWindow {
  const byKind = {} as Record<GcKind, { count: number; pause: number }>;
  for (const kind of GC_KINDS) byKind[kind] = { count: 0, pause: 0 };
  let pause = 0;
  let maxPause = 0;
  for (const event of sample.gc) {
    const slot = byKind[event.kind];
    slot.count++;
    slot.pause += event.duration;
    pause += event.duration;
    if (event.duration > maxPause) maxPause = event.duration;
  }
  return { count: sample.gc.length, pause, maxPause, pauseRatio: Math.min(1, pause / dt), byKind };
}

function percentOfCore(previousUs: number, currentUs: number, dt: number): number {
  return Math.max(0, (currentUs - previousUs) / 1000 / dt) * 100;
}

/** `null` when time did not move forward (duplicate or reordered sample). */
export function deriveFrame({ prev, cur, facts }: DeriveFrameArgs): Frame | null {
  const dt = cur.t - prev.t;
  if (dt <= 0) return null;

  const user = percentOfCore(prev.cpu.user, cur.cpu.user, dt);
  const system = percentOfCore(prev.cpu.system, cur.cpu.system, dt);
  const busy = cur.loop.active - prev.loop.active;
  const idle = cur.loop.idle - prev.loop.idle;
  const memoryLimit = cur.system.limit ?? facts.totalMemory;

  return {
    t: cur.t,
    dt,
    cpu: { user, system, total: user + system, ofMachine: (user + system) / Math.max(1, facts.cpus) },
    loop: {
      utilization: busy + idle > 0 ? Math.max(0, busy) / (busy + idle) : 0,
      delay: cur.loopDelay,
      iterationsPerSec: prev.uv && cur.uv ? ratePerSecond(prev.uv.loopCount, cur.uv.loopCount, dt) : null,
      eventsPerSec: prev.uv && cur.uv ? ratePerSecond(prev.uv.events, cur.uv.events, dt) : null,
    },
    memory: cur.memory,
    heap: cur.heap,
    heapSpaces: cur.heapSpaces,
    gc: gcWindow(cur, dt),
    resources: cur.resources,
    os: {
      rss: cur.memory.rss,
      maxRss: cur.rusage.maxRss,
      memoryLimit,
      memoryShare: memoryLimit > 0 ? cur.memory.rss / memoryLimit : 0,
      processSwap: cur.system.processSwap,
      systemFree: cur.system.free,
      systemAvailable: cur.system.available,
      majorFaultsPerSec: ratePerSecond(prev.rusage.majorFaults, cur.rusage.majorFaults, dt),
      minorFaultsPerSec: ratePerSecond(prev.rusage.minorFaults, cur.rusage.minorFaults, dt),
      voluntarySwitchesPerSec: ratePerSecond(prev.rusage.voluntarySwitches, cur.rusage.voluntarySwitches, dt),
      involuntarySwitchesPerSec: ratePerSecond(prev.rusage.involuntarySwitches, cur.rusage.involuntarySwitches, dt),
      fsReadsPerSec: ratePerSecond(prev.rusage.fsReads, cur.rusage.fsReads, dt),
      fsWritesPerSec: ratePerSecond(prev.rusage.fsWrites, cur.rusage.fsWrites, dt),
      loadAvg1: cur.system.loadAvg1,
    },
    overhead: (cur.overheadUs / 1000 / dt) * 100,
  };
}
