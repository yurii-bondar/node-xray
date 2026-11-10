// The always-on tick: cheap native counters only, sent raw; core derives everything.

import { monitorEventLoopDelay, performance, PerformanceObserver, type IntervalHistogram, type PerformanceEntry } from 'node:perf_hooks';
import v8 from 'node:v8';
import type { LoopDelay, UvCounters, WireGcEvent, WireSample } from '@node-xray/core';
import type { SelfWork } from './self.js';
import { systemMemory, type SwapReader } from './system.js';

/** Histogram timer resolution, ms; subtracted so 0 means "no delay". */
const RESOLUTION_MS = 10;
/** GC events kept between ticks; a GC storm beyond this is visible in the counts anyway. */
const MAX_GC_PER_TICK = 1000;

export interface SamplerDeps {
  readonly self: SelfWork;
  readonly swap: SwapReader;
  readonly intervalMs: number;
  readonly send: (sample: WireSample) => void;
}

/** `uvMetricsInfo` exists from Node 20.18 / 22.8; read without trusting the type definitions. */
export function uvCounters(): UvCounters | null {
  const info: unknown = Reflect.get(performance.nodeTiming, 'uvMetricsInfo');
  if (typeof info !== 'object' || info === null) return null;
  const loopCount: unknown = Reflect.get(info, 'loopCount');
  const events: unknown = Reflect.get(info, 'events');
  return typeof loopCount === 'number' && typeof events === 'number' ? { loopCount, events } : null;
}

function gcKindCode(entry: PerformanceEntry): number {
  const detail: unknown = Reflect.get(entry, 'detail');
  const kind: unknown = typeof detail === 'object' && detail !== null ? Reflect.get(detail, 'kind') : undefined;
  return typeof kind === 'number' ? kind : 0;
}

export function loopDelay(histogram: IntervalHistogram, sinceLastTickMs: number, intervalMs: number): LoopDelay {
  if (histogram.count === 0) {
    // The loop never got to the histogram's timer: it was blocked for the whole tick.
    const blocked = Math.max(0, sinceLastTickMs - intervalMs);
    return { min: blocked, max: blocked, mean: blocked, stddev: 0, p50: blocked, p90: blocked, p99: blocked };
  }
  const ms = (ns: number): number => Math.max(0, ns / 1e6 - RESOLUTION_MS);
  return {
    min: ms(histogram.min),
    max: ms(histogram.max),
    mean: ms(histogram.mean),
    stddev: histogram.stddev / 1e6,
    p50: ms(histogram.percentile(50)),
    p90: ms(histogram.percentile(90)),
    p99: ms(histogram.percentile(99)),
  };
}

export class Sampler {
  readonly #histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  #gc: WireGcEvent[] = [];
  #observer: PerformanceObserver | null = null;
  #timer: NodeJS.Timeout | null = null;
  #lastTick = performance.now();
  #overheadUs = 0;

  constructor(private readonly deps: SamplerDeps) {}

  start(): void {
    const { self, intervalMs } = this.deps;
    this.#histogram.enable();
    this.#observer = new PerformanceObserver((list) => {
      self.run(() => {
        for (const entry of list.getEntries()) {
          if (this.#gc.length >= MAX_GC_PER_TICK) break;
          this.#gc.push({ start: performance.timeOrigin + entry.startTime, duration: entry.duration, kind: gcKindCode(entry) });
        }
      });
    });
    this.#observer.observe({ entryTypes: ['gc'] });
    this.#lastTick = performance.now();
    this.deps.swap.refresh();
    this.#timer = self.own(setInterval(() => self.run(() => this.tick()), intervalMs).unref());
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#observer?.disconnect();
    this.#observer = null;
    this.#histogram.disable();
  }

  /** Main-thread time the agent spent outside the tick (profile serialisation, trace flushes). */
  addOverhead(us: number): void {
    this.#overheadUs += us;
  }

  /** Collects and sends one sample now (also called once on process exit). */
  tick(): void {
    const started = performance.now();
    const sample = this.#collect(started);
    this.deps.send(sample);
    this.#histogram.reset();
    this.deps.swap.refresh();
    this.#lastTick = started;
    this.#overheadUs = (performance.now() - started) * 1000;
  }

  #collect(now: number): WireSample {
    const cpu = process.cpuUsage();
    const elu = performance.eventLoopUtilization();
    const memory = process.memoryUsage();
    const heap = v8.getHeapStatistics();
    const rusage = process.resourceUsage();
    const resources = new Map<string, number>();
    for (const type of process.getActiveResourcesInfo()) resources.set(type, (resources.get(type) ?? 0) + 1);
    const gc = this.#gc;
    this.#gc = [];
    return {
      type: 'sample',
      t: performance.timeOrigin + now,
      cpu: { user: cpu.user, system: cpu.system },
      loop: { idle: elu.idle, active: elu.active },
      loopDelay: loopDelay(this.#histogram, now - this.#lastTick, this.deps.intervalMs),
      uv: uvCounters(),
      memory: {
        rss: memory.rss,
        heapTotal: memory.heapTotal,
        heapUsed: memory.heapUsed,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
      },
      heap: {
        limit: heap.heap_size_limit,
        totalAvailable: heap.total_available_size,
        malloced: heap.malloced_memory,
        peakMalloced: heap.peak_malloced_memory,
        nativeContexts: heap.number_of_native_contexts,
        detachedContexts: heap.number_of_detached_contexts,
      },
      heapSpaces: v8.getHeapSpaceStatistics().map((space) => ({
        name: space.space_name,
        size: space.space_size,
        used: space.space_used_size,
        available: space.space_available_size,
      })),
      gc,
      resources: Object.fromEntries(resources),
      rusage: {
        maxRssKb: rusage.maxRSS,
        minorFaults: rusage.minorPageFault,
        majorFaults: rusage.majorPageFault,
        voluntarySwitches: rusage.voluntaryContextSwitches,
        involuntarySwitches: rusage.involuntaryContextSwitches,
        fsReads: rusage.fsRead,
        fsWrites: rusage.fsWrite,
      },
      system: systemMemory(this.deps.swap),
      overheadUs: this.#overheadUs,
    };
  }
}
