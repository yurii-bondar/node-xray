// Draws the event loop lane and the iteration strip; tooltips on hover.

import { CATEGORY_LABEL, formatMs, TASK_CATEGORIES, type Iteration, type TaskCategory } from '@node-xray/core';
import { cssVar, fitCanvas, showTip } from './dom.js';
import { hitTest, LANE_ROWS, layoutLane, type LaneBlock, type LaneLayout, type LaneLayoutArgs, type LaneRow } from './lane-layout.js';

const GUTTER = 92;
const TOP = 22;
const BOTTOM = 18;

export const ROW_COLOR: Readonly<Record<LaneRow, string>> = {
  timer: '--c-timer',
  io: '--c-io',
  immediate: '--c-immediate',
  nextTick: '--c-nextTick',
  microtask: '--c-microtask',
  promise: '--c-promise',
  gc: '--c-gc',
};

export const ROW_LABEL: Readonly<Record<LaneRow, string>> = { ...CATEGORY_LABEL, gc: 'GC pauses' };

const SHORT: Readonly<Record<TaskCategory, string>> = { timer: 'T', io: 'IO', immediate: 'Imm', nextTick: 'Tick', microtask: 'μ', promise: 'P' };

/** "4T 2IO 12P": what ran in an iteration, compactly. */
export function iterationSummary(iteration: Iteration): string {
  return TASK_CATEGORIES.filter((c) => iteration.counts[c] > 0)
    .map((c) => `${iteration.counts[c]}${SHORT[c]}`)
    .join(' ');
}

/** Row colours resolved once per frame: getComputedStyle per block would be thousands of calls. */
function palette(): Record<LaneRow, string> {
  const out = {} as Record<LaneRow, string>;
  for (const row of LANE_ROWS) out[row] = cssVar(ROW_COLOR[row]);
  return out;
}

function describeBlock(block: LaneBlock): string {
  const more = block.merged > 0 ? `\n+${block.merged} more here (zoom in: smaller span)` : '';
  if (block.item.kind === 'gc') {
    const gc = block.item.event;
    return `GC ${gc.kind}\npause ${formatMs(gc.duration)}${more}`;
  }
  const e = block.item.event;
  const name = e.name === '' ? '(anonymous)' : e.name;
  const iteration = e.iteration >= 0 ? `iteration #${e.iteration}` : 'iteration unknown';
  return `${ROW_LABEL[e.category]} · ${e.resource}\n${name}\n${formatMs(e.duration)} · ${iteration} · phase ${e.phase}${e.depth > 0 ? ` · nested ${e.depth}` : ''}${more}`;
}

function niceStep(spanMs: number): number {
  const raw = spanMs / 6;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (raw <= m * pow) return m * pow;
  return 10 * pow;
}

export class LaneView {
  #layout: LaneLayout | null = null;
  #rowHeight = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly tip: HTMLElement,
  ) {
    canvas.addEventListener('mousemove', (event) => this.#hover(event));
    canvas.addEventListener('mouseleave', () => (this.tip.hidden = true));
  }

  render(args: Omit<LaneLayoutArgs, 'width'>): void {
    const ctx = fitCanvas(this.canvas);
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const plotWidth = Math.max(10, width - GUTTER);
    const layout = layoutLane({ ...args, width: plotWidth });
    this.#layout = layout;
    this.#rowHeight = (height - TOP - BOTTOM) / LANE_ROWS.length;

    ctx.clearRect(0, 0, width, height);
    const muted = cssVar('--muted');
    const grid = cssVar('--grid');
    const text = cssVar('--f-text');
    const colors = palette();
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    LANE_ROWS.forEach((row, i) => {
      const y = TOP + i * this.#rowHeight;
      ctx.fillStyle = muted;
      ctx.fillText(ROW_LABEL[row], 8, y + this.#rowHeight / 2);
      ctx.fillStyle = grid;
      ctx.fillRect(GUTTER, y + this.#rowHeight - 0.5, plotWidth, 1);
    });

    // Iteration boundaries, with what ran in each when there is room to say it.
    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, 0, plotWidth, height);
    ctx.clip();
    const marks = layout.marks;
    marks.forEach((mark, i) => {
      const x = GUTTER + mark.x;
      ctx.fillStyle = grid;
      ctx.fillRect(x, TOP - 4, 1, height - TOP - BOTTOM + 4);
      const next = marks[i + 1];
      const room = (next ? GUTTER + next.x : width) - x;
      if (room < 28) return;
      ctx.fillStyle = muted;
      const label = room > 120 ? `#${mark.iteration.index} · ${iterationSummary(mark.iteration)}` : `#${mark.iteration.index}`;
      ctx.fillText(label, x + 3, TOP / 2, room - 6);
    });

    for (const block of layout.blocks) {
      const row = LANE_ROWS.indexOf(block.row);
      const y = TOP + row * this.#rowHeight + 3;
      const h = this.#rowHeight - 6;
      ctx.fillStyle = colors[block.row];
      ctx.fillRect(GUTTER + block.x, y, Math.max(1, block.w), h);
      if (block.w > 48 && block.item.kind === 'callback') {
        ctx.fillStyle = text;
        const label = block.item.event.name || block.item.event.resource;
        ctx.fillText(label, GUTTER + block.x + 4, y + h / 2, block.w - 8);
      }
    }
    ctx.restore();

    // Time axis, relative to the right edge ("now").
    const step = niceStep(args.spanMs);
    ctx.fillStyle = muted;
    ctx.textAlign = 'center';
    for (let ago = 0; ago <= args.spanMs; ago += step) {
      const x = GUTTER + plotWidth - (ago / args.spanMs) * plotWidth;
      ctx.fillRect(x, height - BOTTOM, 1, 4);
      ctx.fillText(ago === 0 ? 'now' : `−${formatMs(ago)}`, Math.min(Math.max(x, GUTTER + 20), width - 20), height - BOTTOM / 2 + 2);
    }
    ctx.textAlign = 'start';
  }

  #hover(event: MouseEvent): void {
    const layout = this.#layout;
    if (layout === null || this.#rowHeight <= 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const row = LANE_ROWS[Math.floor((y - TOP) / this.#rowHeight)];
    const block = row === undefined || x < GUTTER ? null : hitTest(layout, row, x - GUTTER);
    if (block === null) {
      this.tip.hidden = true;
      return;
    }
    showTip(this.tip, describeBlock(block), x, y);
  }
}

const BAR = 7;
const GAP = 2;

/** Last iterations as stacked bars (counts per category); click selects one. */
export class IterationStrip {
  #shown: Iteration[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    onSelect: (iteration: Iteration) => void,
  ) {
    canvas.addEventListener('click', (event) => {
      const rect = canvas.getBoundingClientRect();
      const fromRight = rect.right - event.clientX;
      const index = this.#shown.length - 1 - Math.floor(fromRight / (BAR + GAP));
      const iteration = this.#shown[index];
      if (iteration !== undefined) onSelect(iteration);
    });
  }

  render(iterations: readonly Iteration[], selected: number | null): void {
    const ctx = fitCanvas(this.canvas);
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    ctx.clearRect(0, 0, width, height);
    const fit = Math.floor(width / (BAR + GAP));
    this.#shown = iterations.slice(-fit);
    let max = 1;
    for (const it of this.#shown) {
      let total = 0;
      for (const c of TASK_CATEGORIES) total += it.counts[c];
      max = Math.max(max, total);
    }
    const scale = (height - 4) / max;
    const colors = palette();
    const outline = cssVar('--text');
    this.#shown.forEach((it, i) => {
      const x = width - (this.#shown.length - i) * (BAR + GAP);
      let y = height;
      for (const c of TASK_CATEGORIES) {
        const h = it.counts[c] * scale;
        if (h <= 0) continue;
        ctx.fillStyle = colors[c];
        ctx.fillRect(x, y - h, BAR, h);
        y -= h;
      }
      if (it.index === selected) {
        ctx.strokeStyle = outline;
        ctx.strokeRect(x - 1, 0.5, BAR + 2, height - 1);
      }
    });
  }
}
