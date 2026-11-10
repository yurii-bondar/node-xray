// File system and DNS per tick. DNS comes from Node's own `dns` performance entries; file system
// calls from the agent's opt-in `fs` timing (async callbacks and promises, and the *Sync calls
// that block the loop). The agent aggregates per tick; percentiles and summaries are here.

import { Fields, ProtocolError } from './guard.js';
import { HTTP_BUCKET_COUNT, histogramPercentile } from './http.js';

export interface IoOperation {
  /** `readFile /srv/app/config.json`, `read (fd)`, `lookup api.example.com`. */
  readonly key: string;
  readonly count: number;
  readonly errors: number;
  readonly totalMs: number;
  readonly maxMs: number;
}

export interface IoExample {
  readonly key: string;
  readonly ms: number;
  readonly failed: boolean;
}

export interface IoSide {
  readonly calls: number;
  readonly errors: number;
  readonly totalMs: number;
  readonly maxMs: number;
  /** Calls per latency bucket (`HTTP_BUCKETS_MS`). */
  readonly histogram: readonly number[];
  /** Bounded per tick; the rest are counted under `(other)`. */
  readonly operations: readonly IoOperation[];
  readonly slowest: readonly IoExample[];
}

export interface IoMessage {
  readonly type: 'io';
  readonly start: number;
  readonly end: number;
  /** Async file system calls (callbacks and promises); empty while fs timing is off. */
  readonly fs: IoSide;
  /** `*Sync` file system calls: each one blocked the event loop for its duration. */
  readonly fsSync: IoSide;
  readonly dns: IoSide;
}

export type IoKind = 'fs' | 'fsSync' | 'dns';

export const IO_KINDS: readonly IoKind[] = ['fs', 'fsSync', 'dns'];

export function emptyIoSide(): IoSide {
  return { calls: 0, errors: 0, totalMs: 0, maxMs: 0, histogram: new Array<number>(HTTP_BUCKET_COUNT).fill(0), operations: [], slowest: [] };
}

function parseSide(value: unknown, path: string): IoSide {
  const f = Fields.of(value, path);
  const histogram = f.numbers('histogram');
  if (histogram.length !== HTTP_BUCKET_COUNT) throw new ProtocolError(f.at('histogram'), `${HTTP_BUCKET_COUNT} buckets`);
  return {
    calls: f.number('calls'),
    errors: f.number('errors'),
    totalMs: f.number('totalMs'),
    maxMs: f.number('maxMs'),
    histogram,
    operations: f.list('operations', (v, p) => {
      const o = Fields.of(v, p);
      return { key: o.string('key'), count: o.number('count'), errors: o.number('errors'), totalMs: o.number('totalMs'), maxMs: o.number('maxMs') };
    }),
    slowest: f.list('slowest', (v, p) => {
      const e = Fields.of(v, p);
      return { key: e.string('key'), ms: e.number('ms'), failed: e.boolean('failed') };
    }),
  };
}

export function parseIo(f: Fields): IoMessage {
  return { type: 'io', start: f.number('start'), end: f.number('end'), fs: f.read('fs', parseSide), fsSync: f.read('fsSync', parseSide), dns: f.read('dns', parseSide) };
}

export interface IoRates {
  readonly t: number;
  readonly perSec: number;
  readonly p50: number;
  readonly p99: number;
  readonly max: number;
  /** Time spent in these calls per second of wall time, ms/s (for sync fs: how long the loop was blocked). */
  readonly msPerSec: number;
}

export function ioRates(side: IoSide, window: { readonly start: number; readonly end: number }): IoRates {
  const seconds = Math.max(0.001, (window.end - window.start) / 1000);
  return {
    t: window.end,
    perSec: side.calls / seconds,
    p50: histogramPercentile(side.histogram, 50, side.maxMs),
    p99: histogramPercentile(side.histogram, 99, side.maxMs),
    max: side.maxMs,
    msPerSec: side.totalMs / seconds,
  };
}

export interface IoSummary {
  readonly calls: number;
  readonly errors: number;
  readonly perSec: number;
  readonly totalMs: number;
  readonly p50: number;
  readonly p99: number;
  readonly max: number;
  /** By total time, heaviest first. */
  readonly operations: readonly IoOperation[];
  readonly slowest: readonly IoExample[];
}

/** Ticks of one kind added up; null when nothing of that kind happened. */
export function summarizeIo(windows: readonly IoMessage[], kind: IoKind, limit = 10): IoSummary | null {
  const histogram = new Array<number>(HTTP_BUCKET_COUNT).fill(0);
  const operations = new Map<string, { key: string; count: number; errors: number; totalMs: number; maxMs: number }>();
  const slowest: IoExample[] = [];
  let calls = 0;
  let errors = 0;
  let totalMs = 0;
  let max = 0;
  let start = Number.POSITIVE_INFINITY;
  let end = 0;
  for (const window of windows) {
    const side = window[kind];
    start = Math.min(start, window.start);
    end = Math.max(end, window.end);
    calls += side.calls;
    errors += side.errors;
    totalMs += side.totalMs;
    max = Math.max(max, side.maxMs);
    side.histogram.forEach((c, i) => (histogram[i] = (histogram[i] ?? 0) + c));
    for (const op of side.operations) {
      const entry = operations.get(op.key) ?? { key: op.key, count: 0, errors: 0, totalMs: 0, maxMs: 0 };
      entry.count += op.count;
      entry.errors += op.errors;
      entry.totalMs += op.totalMs;
      entry.maxMs = Math.max(entry.maxMs, op.maxMs);
      operations.set(op.key, entry);
    }
    slowest.push(...side.slowest);
  }
  if (calls === 0) return null;
  slowest.sort((a, b) => b.ms - a.ms);
  return {
    calls,
    errors,
    perSec: calls / Math.max(0.001, (end - start) / 1000),
    totalMs,
    p50: histogramPercentile(histogram, 50, max),
    p99: histogramPercentile(histogram, 99, max),
    max,
    operations: [...operations.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, limit),
    slowest: slowest.slice(0, limit),
  };
}
