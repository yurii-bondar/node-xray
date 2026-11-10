// Draws the CPU flame graph (icicle), tooltips, click to zoom. Given a DiffNode tree, it
// colours by change against the baseline instead: red got heavier, blue got lighter.

import { formatShare, type DiffNode, type FlameFrame, type FlameNode } from '@node-xray/core';
import { cssVar, fitCanvas, showTip, withAlpha } from './dom.js';
import { frameKind, hitFlame, layoutFlame, type FlameRect, type FrameKind } from './flame-layout.js';

const ROW = 18;
const MAX_ROWS = 40;
/** A change of this many share points of work is drawn at full strength. */
const FULL_CHANGE = 0.1;

const KIND_COLOR: Readonly<Record<FrameKind, string>> = { app: '--f-app', deps: '--f-deps', node: '--f-node', native: '--f-native' };

/** Small per-name brightness change so neighbours of one colour stay apart. */
function shade(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return 0.75 + ((hash >>> 0) % 25) / 100;
}

export function isDiff(node: FlameNode): node is DiffNode {
  return 'baseTotal' in node;
}

function points(delta: number): string {
  return `${delta >= 0 ? '+' : '−'}${Math.abs(delta * 100).toFixed(1)} pts`;
}

export interface FlameViewArgs {
  readonly canvas: HTMLCanvasElement;
  readonly tip: HTMLElement;
  /** Path (node keys) of the clicked frame, relative to the drawn root; null = zoom out. */
  readonly onZoom: (relativePath: readonly string[] | null) => void;
  /** Where a frame's code is, source-mapped when possible. */
  readonly locate: (frame: FlameFrame) => string;
  /** Double-click opens the frame's code (inside VS Code); null = not available. */
  readonly onOpen: ((frame: FlameFrame) => void) | null;
}

export class FlameView {
  #rects: FlameRect[] = [];
  #root: FlameNode | null = null;
  readonly #canvas: HTMLCanvasElement;
  readonly #tip: HTMLElement;
  readonly #locate: (frame: FlameFrame) => string;

  constructor({ canvas, tip, onZoom, locate, onOpen }: FlameViewArgs) {
    this.#canvas = canvas;
    this.#tip = tip;
    this.#locate = locate;
    canvas.addEventListener('mousemove', (event) => this.#hover(event));
    canvas.addEventListener('mouseleave', () => (tip.hidden = true));
    canvas.addEventListener('click', (event) => {
      const rect = this.#at(event);
      if (rect === null) return;
      onZoom(rect.depth === 0 ? null : rect.path);
    });
    if (onOpen !== null) {
      canvas.addEventListener('dblclick', (event) => {
        const rect = this.#at(event);
        if (rect !== null && rect.node.url !== '') onOpen(rect.node);
      });
    }
  }

  render(root: FlameNode): void {
    this.#root = root;
    const width = this.#canvas.clientWidth;
    this.#rects = layoutFlame(root, width);
    let depth = 0;
    for (const rect of this.#rects) depth = Math.max(depth, rect.depth);
    const ctx = fitCanvas(this.#canvas, Math.min(depth + 1, MAX_ROWS) * ROW + 2);
    ctx.clearRect(0, 0, width, this.#canvas.clientHeight);
    ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'middle';

    const text = cssVar('--f-text');
    const kinds: Record<FrameKind, string> = { app: cssVar(KIND_COLOR.app), deps: cssVar(KIND_COLOR.deps), node: cssVar(KIND_COLOR.node), native: cssVar(KIND_COLOR.native) };
    const hotter = cssVar('--bad');
    const cooler = cssVar('--s1');
    const diff = isDiff(root);

    for (const rect of this.#rects) {
      if (rect.depth >= MAX_ROWS) continue;
      const y = rect.depth * ROW;
      const node = rect.node;
      if (diff && isDiff(node)) {
        const delta = node.total - node.baseTotal;
        const strength = Math.min(1, Math.abs(delta) / FULL_CHANGE);
        ctx.fillStyle = strength < 0.02 ? withAlpha(kinds.native, 0.5) : withAlpha(delta > 0 ? hotter : cooler, 0.25 + 0.75 * strength);
      } else {
        ctx.globalAlpha = shade(node.name);
        ctx.fillStyle = kinds[frameKind(node)];
      }
      ctx.fillRect(rect.x, y, Math.max(0.5, rect.w - 1), ROW - 1);
      ctx.globalAlpha = 1;
      if (rect.w > 36) {
        ctx.fillStyle = text;
        ctx.fillText(node.name, rect.x + 4, y + ROW / 2, rect.w - 8);
      }
    }
  }

  #at(event: MouseEvent): FlameRect | null {
    const bounds = this.#canvas.getBoundingClientRect();
    return hitFlame(this.#rects, event.clientX - bounds.left, Math.floor((event.clientY - bounds.top) / ROW));
  }

  #hover(event: MouseEvent): void {
    const rect = this.#at(event);
    const root = this.#root;
    if (rect === null || root === null || root.total <= 0) {
      this.#tip.hidden = true;
      return;
    }
    const node = rect.node;
    const where = this.#locate(node);
    const weights = isDiff(node)
      ? `now ${formatShare(node.total)} · baseline ${formatShare(node.baseTotal)} (${points(node.total - node.baseTotal)})\nself now ${formatShare(node.self)} · baseline ${formatShare(node.baseSelf)}`
      : `total ${formatShare(node.total / root.total)} · self ${formatShare(node.self / root.total)}`;
    const bounds = this.#canvas.getBoundingClientRect();
    showTip(this.#tip, `${node.name}${where === '' ? '' : `\n${where}`}\n${weights}`, event.clientX - bounds.left, event.clientY - bounds.top);
  }
}
