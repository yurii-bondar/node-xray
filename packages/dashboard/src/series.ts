// Frames → column arrays for uPlot (x in seconds). No DOM here.

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
