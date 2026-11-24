// Draws the CPU flame graph (icicle), tooltips, click to zoom. Given a DiffNode tree, it
// colours by change against the baseline instead: red got heavier, blue got lighter.

import { formatShare, type DiffNode, type FlameFrame, type FlameNode } from '@node-xray/core';
import { cssVar, fitCanvas, showTip, withAlpha } from './dom.js';
import { findByPath, frameKind, hitFlame, layoutFlame, stackAlong, type FlameRect, type FrameKind } from './flame-layout.js';

const ROW = 18;
const MAX_ROWS = 40;
/** A change of this many share points of work is drawn at full strength. */
const FULL_CHANGE = 0.1;
/** Callers listed in the tooltip, nearest first; the stack panel has the rest. */
const TIP_CALLERS = 4;

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

export interface FlameScene {
  /** The whole profile: shares and callers are of it, also when zoomed. */
  readonly root: FlameNode;
  /** Node keys from `root` to the zoomed frame ([] = not zoomed); the zoomed frame is drawn as the top. */
  readonly path: readonly string[];
}

export class FlameView {
  #rects: FlameRect[] = [];
  #scene: FlameScene | null = null;
  /** Where the mouse is over the canvas (CSS px), so a redraw can refresh the tooltip under it. */
  #mouse: { readonly x: number; readonly y: number } | null = null;
  readonly #canvas: HTMLCanvasElement;
  readonly #tip: HTMLElement;
  readonly #locate: (frame: FlameFrame) => string;

  constructor({ canvas, tip, onZoom, locate, onOpen }: FlameViewArgs) {
    this.#canvas = canvas;
    this.#tip = tip;
    this.#locate = locate;
    canvas.setAttribute('role', 'img');
    canvas.addEventListener('mousemove', (event) => {
      const bounds = canvas.getBoundingClientRect();
      this.#mouse = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      this.#hover();
    });
    canvas.addEventListener('mouseleave', () => {
      this.#mouse = null;
      tip.hidden = true;
    });
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

  render(scene: FlameScene): void {
    this.#scene = scene;
    const root = findByPath(scene.root, scene.path) ?? scene.root;
    const share = scene.root.total > 0 && !isDiff(root) ? ` · ${formatShare(root.total / scene.root.total)} of the profile` : '';
    this.#canvas.setAttribute('aria-label', `CPU flame graph${scene.path.length === 0 ? '' : `, zoomed into ${root.name}${share}`}: use the hot functions table for the same data as text`);
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
    // The frames moved under a still mouse: say what is there now.
    this.#hover();
  }

  #at(event: MouseEvent): FlameRect | null {
    const bounds = this.#canvas.getBoundingClientRect();
    return this.#hit(event.clientX - bounds.left, event.clientY - bounds.top);
  }

  #hit(x: number, y: number): FlameRect | null {
    return hitFlame(this.#rects, x, Math.floor(y / ROW));
  }

  #hover(): void {
    const mouse = this.#mouse;
    const scene = this.#scene;
    const rect = mouse === null || scene === null ? null : this.#hit(mouse.x, mouse.y);
    if (mouse === null || scene === null || rect === null || scene.root.total <= 0) {
      this.#tip.hidden = true;
      return;
    }
    const root = scene.root;
    const node = rect.node;
    const where = this.#locate(node);
    const weights = isDiff(node)
      ? `now ${formatShare(node.total)} · baseline ${formatShare(node.baseTotal)} (${points(node.total - node.baseTotal)})\nself now ${formatShare(node.self)} · baseline ${formatShare(node.baseSelf)}`
      : `total ${formatShare(node.total / root.total)} · self ${formatShare(node.self / root.total)}`;
    // Callers up to the real root, not only to the zoomed frame.
    const callers = stackAlong(root, [...scene.path, ...rect.path]).slice(0, -1).reverse();
    const chain = callers.slice(0, TIP_CALLERS).map((caller) => `\n← ${caller.name}`).join('') + (callers.length > TIP_CALLERS ? `\n← … ${callers.length - TIP_CALLERS} more` : '');
    showTip(this.#tip, `${node.name}${where === '' ? '' : `\n${where}`}\n${weights}${chain}`, mouse.x, mouse.y);
  }
}
