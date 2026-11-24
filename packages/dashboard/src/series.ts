// Frames → column arrays for uPlot (x in seconds), sparklines and GC summaries. No DOM here.

import { DEFAULT_INSIGHT_OPTIONS, type Frame, type GcEvent, type GcKind } from '@node-xray/core';
import type { Level } from './nav.js';

export type Column = Array<number | null>;

export interface Timed {
  readonly t: number;
}

/** Index of the first item with `t >= from`; items are in time order. */
function firstFrom(items: readonly Timed[], from: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((items[mid] as Timed).t < from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Items with `t >= from` (all when `from` is 0), one column per picker, x first. */
export function columns<T extends Timed>(items: readonly T[], from: number, pickers: ReadonlyArray<(item: T) => number | null>): [number[], ...Column[]] {
  const start = from > 0 ? firstFrom(items, from) : 0;
  const n = items.length - start;
  const xs = new Array<number>(n);
  const ys: Column[] = pickers.map(() => new Array<number | null>(n));
  for (let i = 0; i < n; i++) {
    const item = items[start + i] as T;
    xs[i] = item.t / 1000;
    for (let p = 0; p < pickers.length; p++) (ys[p] as Column)[i] = (pickers[p] as (item: T) => number | null)(item);
  }
  return [xs, ...ys];
}

/** `readFile /srv/app/data/users.json` → `readFile data/users.json`: last two segments of a path target. */
export function shortIoKey(key: string): string {
  const space = key.indexOf(' ');
  if (space === -1) return key;
  const target = key.slice(space + 1);
  if (!target.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(target)) return key;
  const parts = target.split(/[\\/]/).filter((part) => part !== '');
  return parts.length <= 2 ? key : `${key.slice(0, space)} …/${parts.slice(-2).join('/')}`;
}

/**
 * A finding that holds for many ticks in a row (a request stuck for a minute) would draw a
 * marker per tick: keep the first time of each run, and start a new run after a gap.
 */
export function markerTimes(times: readonly number[], gapMs: number): number[] {
  const sorted = [...times].sort((a, b) => a - b);
  const out: number[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const t of sorted) {
    if (t - previous > gapMs) out.push(t);
    previous = t;
  }
  return out;
}

export interface SparkArgs {
  readonly values: readonly (number | null)[];
  readonly width: number;
  readonly height: number;
}

/** SVG path of a sparkline scaled from 0 to the maximum; a `null` breaks the line. '' when there is nothing to draw. */
export function sparkPath({ values, width, height }: SparkArgs): string {
  if (values.length < 2) return '';
  let max = 0;
  for (const v of values) if (v !== null && v > max) max = v;
  const step = width / (values.length - 1);
  const parts: string[] = [];
  let pen = false;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? null;
    if (v === null) {
      pen = false;
      continue;
    }
    const y = max > 0 ? height - (Math.max(0, v) / max) * height : height;
    parts.push(`${pen ? 'L' : 'M'}${(i * step).toFixed(1)} ${y.toFixed(1)}`);
    pen = true;
  }
  return parts.length < 2 ? '' : parts.join(' ');
}

/** V8's names for the pause kinds, as the GC trace and DevTools show them. */
export const GC_LABEL: Readonly<Record<GcKind, string>> = {
  minor: 'Scavenge',
  major: 'Mark-Compact',
  incremental: 'Incremental marking',
  weakcb: 'Weak callbacks',
  other: 'Other',
};

export interface GcKindRow {
  readonly kind: GcKind;
  readonly runs: number;
  readonly avg: number;
  readonly max: number;
  readonly total: number;
}

/** Pauses grouped by kind, most total pause first. */
export function gcByKind(events: readonly GcEvent[]): GcKindRow[] {
  const byKind = new Map<GcKind, { runs: number; max: number; total: number }>();
  for (const e of events) {
    const row = byKind.get(e.kind) ?? { runs: 0, max: 0, total: 0 };
    row.runs++;
    row.max = Math.max(row.max, e.duration);
    row.total += e.duration;
    byKind.set(e.kind, row);
  }
  return [...byKind]
    .map(([kind, { runs, max, total }]) => ({ kind, runs, avg: total / runs, max, total }))
    .sort((a, b) => b.total - a.total);
}

/** Upper bounds (ms) of the pause histogram buckets; one more bucket holds everything above the last. */
export const PAUSE_BUCKETS: readonly number[] = [1, 5, 20, 50, 100, 250];

/** Pauses per bucket of `PAUSE_BUCKETS` (`PAUSE_BUCKETS.length + 1` counts). */
export function pauseHistogram(events: readonly GcEvent[]): number[] {
  const counts = new Array<number>(PAUSE_BUCKETS.length + 1).fill(0);
  for (const e of events) {
    let i = 0;
    while (i < PAUSE_BUCKETS.length && e.duration >= (PAUSE_BUCKETS[i] as number)) i++;
    counts[i] = (counts[i] as number) + 1;
  }
  return counts;
}

export interface RecentArgs {
  /** How far back from the latest frame, ms. */
  readonly ms: number;
  readonly pick: (frame: Frame) => number;
}

export interface RecentTotal {
  readonly total: number;
  /** What the summed frames cover, ms: less than asked for while the run is young. */
  readonly coveredMs: number;
}

/** `pick` summed over the frames that end within the last `ms` before the latest frame. */
export function recentTotal(frames: readonly Frame[], { ms, pick }: RecentArgs): RecentTotal {
  const last = frames[frames.length - 1];
  let total = 0;
  let coveredMs = 0;
  if (last === undefined) return { total, coveredMs };
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i] as Frame;
    // A frame covers (t - dt, t]: the one ending exactly `ms` ago lies before the span.
    if (frame.t <= last.t - ms) break;
    total += pick(frame);
    coveredMs += frame.dt;
  }
  return { total, coveredMs };
}

/** One rule for GC time everywhere: `bad` from the share the GC pressure finding fires at, `warn` from a third of it. */
export function gcLevel(pauseShare: number): Level | 'ok' {
  const pressure = DEFAULT_INSIGHT_OPTIONS.gcPressureRatio;
  return pauseShare >= pressure ? 'bad' : pauseShare >= pressure / 3 ? 'warn' : 'ok';
}

export interface GcCoverageArgs {
  /** Where the window starts, epoch ms (0 = everything kept). */
  readonly from: number;
  /** How many events the timeline keeps. */
  readonly capacity: number;
}

/** Where the kept GC events start when older ones were dropped inside the window; null when they cover it. */
export function gcCoverageStart(events: readonly GcEvent[], { from, capacity }: GcCoverageArgs): number | null {
  const first = events[0];
  if (first === undefined || events.length < capacity || first.start <= from) return null;
  return first.start;
}

/** How long the kept frames reach back, ms. */
export function keptSpan(frames: readonly Frame[]): number {
  const first = frames[0];
  const last = frames[frames.length - 1];
  return first === undefined || last === undefined ? 0 : last.t - first.t + first.dt;
}

/** Points (`t` = the window's end) of HTTP or I/O windows, each derived once per window object: windows never change. */
export class PointCache<W extends object & { readonly end: number }, P extends Timed> {
  readonly #points = new WeakMap<W, P>();

  constructor(private readonly derive: (window: W) => P) {}

  /** Points of the windows ending at or after `from`, and of at least the last `keep` (sparklines). */
  since(windows: readonly W[], from: number, keep: number): P[] {
    let start = windows.length;
    while (start > 0 && ((windows[start - 1] as W).end >= from || windows.length - start < keep)) start--;
    const out = new Array<P>(windows.length - start);
    for (let i = start; i < windows.length; i++) {
      const window = windows[i] as W;
      let point = this.#points.get(window);
      if (point === undefined) {
        point = this.derive(window);
        this.#points.set(window, point);
      }
      out[i - start] = point;
    }
    return out;
  }
}
