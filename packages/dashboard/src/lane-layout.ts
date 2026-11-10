// Event loop lane: callbacks and GC pauses → positioned blocks, one row per kind of work,
// with iteration boundaries. Pure geometry; lane-view.ts draws it.

import { TASK_CATEGORIES, type GcEvent, type Iteration, type LoopEvent, type TaskCategory } from '@node-xray/core';

export type LaneRow = TaskCategory | 'gc';

export const LANE_ROWS: readonly LaneRow[] = [...TASK_CATEGORIES, 'gc'];

export type LaneItem = { readonly kind: 'callback'; readonly event: LoopEvent } | { readonly kind: 'gc'; readonly event: GcEvent };

export interface LaneBlock {
  readonly row: LaneRow;
  x: number;
  w: number;
  /** The first item drawn here; `merged` more were too narrow to draw apart. */
  readonly item: LaneItem;
  merged: number;
}

export interface IterationMark {
  readonly x: number;
  readonly iteration: Iteration;
}

export interface LaneLayout {
  readonly start: number;
  readonly end: number;
  readonly blocks: readonly LaneBlock[];
  readonly marks: readonly IterationMark[];
}

export interface LaneLayoutArgs {
  readonly events: readonly LoopEvent[];
  readonly gc: readonly GcEvent[];
  readonly iterations: readonly Iteration[];
  /** Right edge, epoch ms. */
  readonly end: number;
  readonly spanMs: number;
  /** Drawing width in px. */
  readonly width: number;
}

/** Blocks narrower than this merge with a neighbour that touches them. */
const MIN_BLOCK_PX = 1;

export function layoutLane({ events, gc, iterations, end, spanMs, width }: LaneLayoutArgs): LaneLayout {
  const start = end - spanMs;
  const scale = width / spanMs;
  const lastInRow = new Map<LaneRow, LaneBlock>();
  const blocks: LaneBlock[] = [];

  const place = (row: LaneRow, from: number, duration: number, item: LaneItem): void => {
    if (from + duration < start || from > end) return;
    const x = Math.max(0, (from - start) * scale);
    const w = Math.max(MIN_BLOCK_PX, Math.min(width, (from + duration - start) * scale) - x);
    const last = lastInRow.get(row);
    if (last !== undefined && w <= MIN_BLOCK_PX && last.w <= MIN_BLOCK_PX * 2 && Math.abs(x - last.x) <= MIN_BLOCK_PX) {
      last.merged++;
      return;
    }
    const block: LaneBlock = { row, x, w, item, merged: 0 };
    blocks.push(block);
    lastInRow.set(row, block);
  };

  // Sorted by start so neighbours in a row are adjacent (events arrive in completion order).
  const callbacks = events.filter((e) => e.start + e.duration >= start && e.start <= end).sort((a, b) => a.start - b.start);
  for (const event of callbacks) place(event.category, event.start, event.duration, { kind: 'callback', event });
  for (const event of gc) place('gc', event.start, event.duration, { kind: 'gc', event });

  const marks: IterationMark[] = [];
  for (const iteration of iterations) {
    if (iteration.end < start || iteration.start > end) continue;
    marks.push({ x: Math.max(0, (iteration.start - start) * scale), iteration });
  }
  return { start, end, blocks, marks };
}

/** The block under the pointer in a row, preferring the widest when several overlap. */
export function hitTest(layout: LaneLayout, row: LaneRow, x: number, slopPx = 2): LaneBlock | null {
  let best: LaneBlock | null = null;
  for (const block of layout.blocks) {
    if (block.row !== row || x < block.x - slopPx || x > block.x + block.w + slopPx) continue;
    if (best === null || block.w > best.w) best = block;
  }
  return best;
}

export interface CallbackGroup {
  readonly category: TaskCategory;
  /** Callback name, or the resource type when it has none. */
  readonly label: string;
  readonly count: number;
  /** ms */
  readonly total: number;
  readonly longest: number;
}

export interface IterationDetail {
  readonly iteration: Iteration;
  /** Callbacks of the iteration in start order. */
  readonly callbacks: readonly LoopEvent[];
  /** The same callbacks grouped by kind and name, most time first. */
  readonly groups: readonly CallbackGroup[];
}

export function groupCallbacks(callbacks: readonly LoopEvent[]): CallbackGroup[] {
  const groups = new Map<string, { category: TaskCategory; label: string; count: number; total: number; longest: number }>();
  for (const e of callbacks) {
    const label = e.name === '' ? e.resource : e.name;
    const key = `${e.category}\u0000${label}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { category: e.category, label, count: 0, total: 0, longest: 0 };
      groups.set(key, group);
    }
    group.count++;
    group.total += e.duration;
    group.longest = Math.max(group.longest, e.duration);
  }
  return [...groups.values()].sort((a, b) => b.total - a.total || b.count - a.count);
}

export function iterationDetail(events: readonly LoopEvent[], iteration: Iteration): IterationDetail {
  const callbacks = events
    .filter((e) => (iteration.inferred ? e.iteration < 0 : e.iteration === iteration.index) && e.start >= iteration.start && e.start <= iteration.end)
    .sort((a, b) => a.start - b.start);
  return { iteration, callbacks, groups: groupCallbacks(callbacks) };
}
