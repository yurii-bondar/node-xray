// Rules that turn frames into findings a person would otherwise have to spot on the charts.

import type { Frame } from './frame.js';
import { httpRates, type HttpMessage, type HttpStuck } from './http.js';
import type { IoMessage } from './io.js';
import { linearFit } from './stats.js';

export interface Trend {
  /** Epoch ms of the first and last point used. */
  readonly from: number;
  readonly to: number;
  readonly bytesPerMin: number;
  readonly r2: number;
}

export type Insight =
  | { readonly kind: 'loop-stall'; readonly t: number; readonly delay: number; readonly gcPause: number; readonly cause: 'gc' | 'unknown' }
  | { readonly kind: 'gc-pressure'; readonly t: number; readonly pauseRatio: number }
  | { readonly kind: 'heap-growth'; readonly trend: Trend }
  | { readonly kind: 'native-growth'; readonly trend: Trend }
  | { readonly kind: 'near-heap-limit'; readonly t: number; readonly used: number; readonly limit: number }
  | { readonly kind: 'near-memory-limit'; readonly t: number; readonly rss: number; readonly limit: number }
  | { readonly kind: 'swapping'; readonly t: number; readonly majorFaultsPerSec: number; readonly processSwap: number | null }
  | { readonly kind: 'detached-contexts'; readonly t: number; readonly count: number }
  | { readonly kind: 'http-errors'; readonly t: number; readonly side: HttpSideName; readonly rate: number; readonly requests: number }
  | { readonly kind: 'http-slow'; readonly t: number; readonly side: HttpSideName; readonly p99: number }
  | { readonly kind: 'http-stuck'; readonly t: number; readonly side: HttpSideName; readonly count: number; readonly oldest: HttpStuck }
  /** Synchronous file system calls held the event loop in a tick. */
  | { readonly kind: 'fs-blocking'; readonly t: number; readonly ms: number; readonly worst: string }
  | { readonly kind: 'dns-slow'; readonly t: number; readonly ms: number; readonly worst: string };

/** Requests this process serves, or requests it makes. */
export type HttpSideName = 'server' | 'client';

export type InsightKind = Insight['kind'];

export interface InsightOptions {
  /** Loop delay (max in a frame) that counts as a stall, ms. */
  readonly loopStallMs: number;
  /** A stall is blamed on GC when the longest pause covers this share of it. */
  readonly gcBlameShare: number;
  /** Share of wall time in GC pauses that counts as pressure. */
  readonly gcPressureRatio: number;
  /** Width of the buckets whose minimum is the post-GC floor, ms. */
  readonly trendBucketMs: number;
  readonly minTrendBuckets: number;
  readonly minTrendR2: number;
  readonly minGrowthBytesPerMin: number;
  /** used / limit that counts as close to the heap or memory limit. */
  readonly limitShare: number;
  readonly majorFaultsPerSec: number;
  /** Share of failed requests (5xx, aborted, network errors) that counts as an error spike. */
  readonly httpErrorRate: number;
  /** Fewer requests than this in a tick are too few to judge a rate. */
  readonly httpMinRequests: number;
  readonly httpSlowP99Ms: number;
  /** A request running this long is reported as stuck. */
  readonly httpStuckMs: number;
  /** Time in *Sync fs calls within one tick that counts as blocking the loop. */
  readonly fsBlockingMs: number;
  /** A DNS lookup this slow is reported. */
  readonly dnsSlowMs: number;
}

export const DEFAULT_INSIGHT_OPTIONS: InsightOptions = {
  loopStallMs: 100,
  gcBlameShare: 0.5,
  gcPressureRatio: 0.1,
  trendBucketMs: 30_000,
  minTrendBuckets: 5,
  minTrendR2: 0.8,
  minGrowthBytesPerMin: 1024 * 1024,
  limitShare: 0.9,
  // Reading files through mmap also counts; real swap thrashing runs to hundreds per second.
  majorFaultsPerSec: 100,
  httpErrorRate: 0.05,
  httpMinRequests: 20,
  httpSlowP99Ms: 1000,
  httpStuckMs: 10_000,
  fsBlockingMs: 20,
  dnsSlowMs: 200,
};

/**
 * A growing heap is a sawtooth: allocations push it up, GCs bring it down. What matters is the
 * floor, so take the minimum per bucket and fit a line through those. The last, incomplete
 * bucket is skipped: fewer samples make its minimum look higher than it is.
 */
export function floorTrend(frames: readonly Frame[], value: (frame: Frame) => number, options: InsightOptions): Trend | null {
  const first = frames[0];
  const last = frames[frames.length - 1];
  if (first === undefined || last === undefined) return null;
  const t0 = first.t;
  const complete = Math.floor((last.t - t0) / options.trendBucketMs);
  if (complete < options.minTrendBuckets) return null;

  const xs: number[] = [];
  const ys: number[] = [];
  let bucket = -1;
  for (const frame of frames) {
    const index = Math.floor((frame.t - t0) / options.trendBucketMs);
    if (index >= complete) break;
    const y = value(frame);
    if (index !== bucket) {
      bucket = index;
      xs.push(frame.t);
      ys.push(y);
    } else if (y < (ys[ys.length - 1] as number)) {
      xs[xs.length - 1] = frame.t;
      ys[ys.length - 1] = y;
    }
  }
  const fit = linearFit(xs, ys);
  if (fit === null) return null;
  return { from: xs[0] as number, to: xs[xs.length - 1] as number, bytesPerMin: fit.slope * 60_000, r2: fit.r2 };
}

function growing(trend: Trend | null, options: InsightOptions): trend is Trend {
  return trend !== null && trend.bytesPerMin >= options.minGrowthBytesPerMin && trend.r2 >= options.minTrendR2;
}

/** Findings over frames (oldest first). Point findings repeat per frame; state findings use the newest frame. */
export function analyze(frames: readonly Frame[], overrides: Partial<InsightOptions> = {}): Insight[] {
  const options: InsightOptions = { ...DEFAULT_INSIGHT_OPTIONS, ...overrides };
  const out: Insight[] = [];

  for (const frame of frames) {
    const delay = frame.loop.delay.max;
    if (delay >= options.loopStallMs) {
      const gcPause = frame.gc.maxPause;
      out.push({ kind: 'loop-stall', t: frame.t, delay, gcPause, cause: gcPause >= delay * options.gcBlameShare ? 'gc' : 'unknown' });
    }
    if (frame.gc.pauseRatio >= options.gcPressureRatio) {
      out.push({ kind: 'gc-pressure', t: frame.t, pauseRatio: frame.gc.pauseRatio });
    }
    if (frame.os.majorFaultsPerSec >= options.majorFaultsPerSec) {
      out.push({ kind: 'swapping', t: frame.t, majorFaultsPerSec: frame.os.majorFaultsPerSec, processSwap: frame.os.processSwap });
    }
  }

  const heap = floorTrend(frames, (frame) => frame.memory.heapUsed, options);
  if (growing(heap, options)) out.push({ kind: 'heap-growth', trend: heap });
  const native = floorTrend(frames, (frame) => frame.memory.rss - frame.memory.heapTotal, options);
  if (growing(native, options)) out.push({ kind: 'native-growth', trend: native });

  const latest = frames[frames.length - 1];
  if (latest !== undefined) {
    if (latest.heap.limit > 0 && latest.memory.heapUsed >= latest.heap.limit * options.limitShare) {
      out.push({ kind: 'near-heap-limit', t: latest.t, used: latest.memory.heapUsed, limit: latest.heap.limit });
    }
    if (latest.os.memoryShare >= options.limitShare) {
      out.push({ kind: 'near-memory-limit', t: latest.t, rss: latest.os.rss, limit: latest.os.memoryLimit });
    }
    if (latest.heap.detachedContexts > 0) {
      out.push({ kind: 'detached-contexts', t: latest.t, count: latest.heap.detachedContexts });
    }
  }
  return out;
}

/** Findings over HTTP ticks (oldest first), both sides. */
export function analyzeHttp(windows: readonly HttpMessage[], overrides: Partial<InsightOptions> = {}): Insight[] {
  const options: InsightOptions = { ...DEFAULT_INSIGHT_OPTIONS, ...overrides };
  const out: Insight[] = [];
  const sides: readonly HttpSideName[] = ['server', 'client'];
  for (const window of windows) {
    for (const side of sides) {
      const s = window[side];
      const rates = httpRates(s, window);
      const requests = s.finished + s.failed;
      if (requests >= options.httpMinRequests && rates.errorRate >= options.httpErrorRate) {
        out.push({ kind: 'http-errors', t: window.end, side, rate: rates.errorRate, requests });
      }
      if (s.finished >= options.httpMinRequests && rates.p99 >= options.httpSlowP99Ms) {
        out.push({ kind: 'http-slow', t: window.end, side, p99: rates.p99 });
      }
      const stuck = s.stuck.filter((r) => r.ageMs >= options.httpStuckMs);
      const oldest = stuck.reduce<HttpStuck | null>((a, r) => (a === null || r.ageMs > a.ageMs ? r : a), null);
      if (oldest !== null) out.push({ kind: 'http-stuck', t: window.end, side, count: stuck.length, oldest });
    }
  }
  return out;
}

/** Findings over file system and DNS ticks (oldest first). */
export function analyzeIo(windows: readonly IoMessage[], overrides: Partial<InsightOptions> = {}): Insight[] {
  const options: InsightOptions = { ...DEFAULT_INSIGHT_OPTIONS, ...overrides };
  const out: Insight[] = [];
  for (const window of windows) {
    if (window.fsSync.totalMs >= options.fsBlockingMs) {
      out.push({ kind: 'fs-blocking', t: window.end, ms: window.fsSync.totalMs, worst: window.fsSync.slowest[0]?.key ?? '' });
    }
    const slowest = window.dns.slowest[0];
    if (slowest !== undefined && slowest.ms >= options.dnsSlowMs) out.push({ kind: 'dns-slow', t: window.end, ms: slowest.ms, worst: slowest.key });
  }
  return out;
}
