// Frames → column arrays for uPlot (x in seconds), sparklines and GC summaries. No DOM here.

import type { GcEvent, GcKind } from '@node-xray/core';

export type Column = Array<number | null>;

export interface Timed {
  readonly t: number;
}

/** Items with `t >= from` (all when `from` is 0), one column per picker, x first. */
export function columns<T extends Timed>(items: readonly T[], from: number, pickers: ReadonlyArray<(item: T) => number | null>): [number[], ...Column[]] {
  let start = 0;
  if (from > 0) {
    // Items are in time order: binary search for the window start.
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((items[mid] as T).t < from) lo = mid + 1;
      else hi = mid;
    }
    start = lo;
  }
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
