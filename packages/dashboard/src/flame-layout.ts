// Flame graph (icicle: root on top) → rectangles. Pure geometry; flame-view.ts draws it.

import type { FlameFrame, FlameNode } from '@node-xray/core';

export interface FlameRect {
  readonly x: number;
  readonly w: number;
  readonly depth: number;
  readonly node: FlameNode;
  /** Keys from the laid-out root down to this node: survives tree rebuilds, for zoom. */
  readonly path: readonly string[];
}

export function nodeKey(frame: FlameFrame): string {
  return `${frame.name}\u0000${frame.url}\u0000${frame.line}`;
}

/** Nodes narrower than `minWidth` px are skipped; their parents' widths still include them. */
export function layoutFlame(root: FlameNode, width: number, minWidth = 0.5): FlameRect[] {
  const out: FlameRect[] = [];
  if (root.total <= 0) return out;
  const scale = width / root.total;
  const stack: Array<{ node: FlameNode; x: number; depth: number; path: readonly string[] }> = [{ node: root, x: 0, depth: 0, path: [] }];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const w = item.node.total * scale;
    if (w < minWidth) continue;
    out.push({ x: item.x, w, depth: item.depth, node: item.node, path: item.path });
    // Children are left-aligned under the parent; its self time is the gap on the right.
    let x = item.x;
    for (const child of item.node.children) {
      // Children are sorted heaviest first: once one is too narrow, the rest are too.
      if (child.total * scale < minWidth) break;
      stack.push({ node: child, x, depth: item.depth + 1, path: [...item.path, nodeKey(child)] });
      x += child.total * scale;
    }
  }
  return out;
}

/** Follows `path` (from `nodeKey`) down from `root`; null when the tree no longer has it. */
export function findByPath(root: FlameNode, path: readonly string[]): FlameNode | null {
  let node: FlameNode = root;
  for (const key of path) {
    const next = node.children.find((child) => nodeKey(child) === key);
    if (next === undefined) return null;
    node = next;
  }
  return node;
}

export type FrameKind = 'app' | 'deps' | 'node' | 'native';

/** Colour family of a frame: your code, dependencies, Node internals, V8/native. */
export function frameKind(frame: FlameFrame): FrameKind {
  if (frame.url === '') return 'native';
  if (frame.url.startsWith('node:')) return 'node';
  if (frame.url.includes('/node_modules/') || frame.url.includes('\\node_modules\\')) return 'deps';
  return 'app';
}

export function hitFlame(rects: readonly FlameRect[], x: number, depth: number): FlameRect | null {
  for (const rect of rects) if (rect.depth === depth && x >= rect.x && x <= rect.x + rect.w) return rect;
  return null;
}
