// CPU profiles and heap sampling profiles → one flame tree shape, mergeable across windows.

import type { CallFrame, CpuProfile, CpuProfileNode, HeapProfile, HeapProfileNode } from './cdp.js';

/** CPU trees count samples; allocation trees count bytes. */
export type FlameUnit = 'samples' | 'bytes';

export interface FlameFrame {
  /** Function name; '(anonymous)' for unnamed functions; '(root)', '(program)', '(idle)', '(garbage collector)' from V8. */
  readonly name: string;
  readonly url: string;
  /** 1-based; 0 when V8 has no position (native, root). */
  readonly line: number;
  readonly column: number;
}

export interface FlameNode extends FlameFrame {
  /** Weight at exactly this frame. */
  readonly self: number;
  /** self + all descendants. */
  readonly total: number;
  /** Heaviest first. */
  readonly children: readonly FlameNode[];
}

export interface FlameTree {
  readonly unit: FlameUnit;
  readonly root: FlameNode;
  /** Epoch ms covered by the tree (union of merged windows). */
  readonly start: number;
  readonly end: number;
}

interface Draft {
  readonly frame: FlameFrame;
  self: number;
  readonly children: Map<string, Draft>;
}

function toFrame(callFrame: CallFrame): FlameFrame {
  const known = callFrame.lineNumber >= 0;
  return {
    name: callFrame.functionName === '' ? '(anonymous)' : callFrame.functionName,
    url: callFrame.url,
    line: known ? callFrame.lineNumber + 1 : 0,
    column: known ? callFrame.columnNumber + 1 : 0,
  };
}

/** Only the identity fields, so a node's weights never leak into a new tree. */
function frameOf(node: FlameFrame): FlameFrame {
  return { name: node.name, url: node.url, line: node.line, column: node.column };
}

function frameKey(frame: FlameFrame): string {
  return `${frame.name}\u0000${frame.url}\u0000${frame.line}\u0000${frame.column}`;
}

function draft(frame: FlameFrame): Draft {
  return { frame, self: 0, children: new Map() };
}

/** Same function under the same parent is one node, even across scripts reloads or windows. */
function child(parent: Draft, frame: FlameFrame): Draft {
  const key = frameKey(frame);
  let node = parent.children.get(key);
  if (node === undefined) {
    node = draft(frame);
    parent.children.set(key, node);
  }
  return node;
}

function finish(node: Draft): FlameNode {
  const children: FlameNode[] = [];
  let total = node.self;
  for (const c of node.children.values()) {
    const done = finish(c);
    total += done.total;
    if (done.total > 0) children.push(done);
  }
  children.sort((a, b) => b.total - a.total);
  return { ...node.frame, self: node.self, total, children };
}

export interface Window {
  readonly start: number;
  readonly end: number;
}

export function cpuFlame(profile: CpuProfile, window: Window): FlameTree {
  const byId = new Map<number, CpuProfileNode>();
  const referenced = new Set<number>();
  for (const node of profile.nodes) {
    byId.set(node.id, node);
    for (const id of node.children) referenced.add(id);
  }

  // `Profiler.stop` fills hitCount; older payloads only have the samples array.
  const hits = new Map<number, number>();
  let anyHitCount = false;
  for (const node of profile.nodes) {
    if (node.hitCount > 0) anyHitCount = true;
    hits.set(node.id, node.hitCount);
  }
  if (!anyHitCount) {
    for (const id of profile.samples) hits.set(id, (hits.get(id) ?? 0) + 1);
  }

  const rootNode = profile.nodes.find((node) => !referenced.has(node.id));
  const root = draft(rootNode ? toFrame(rootNode.callFrame) : { name: '(root)', url: '', line: 0, column: 0 });
  if (rootNode) {
    root.self = hits.get(rootNode.id) ?? 0;
    const stack: Array<[CpuProfileNode, Draft]> = [[rootNode, root]];
    for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
      const [source, target] = item;
      for (const id of source.children) {
        const next = byId.get(id);
        if (next === undefined) continue;
        const node = child(target, toFrame(next.callFrame));
        node.self += hits.get(id) ?? 0;
        stack.push([next, node]);
      }
    }
  }
  return { unit: 'samples', root: finish(root), start: window.start, end: window.end };
}

export function allocationFlame(profile: HeapProfile, window: Window): FlameTree {
  const root = draft(toFrame(profile.head.callFrame));
  root.self = profile.head.selfSize;
  const stack: Array<[HeapProfileNode, Draft]> = [[profile.head, root]];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const [source, target] = item;
    for (const next of source.children) {
      const node = child(target, toFrame(next.callFrame));
      node.self += next.selfSize;
      stack.push([next, node]);
    }
  }
  return { unit: 'bytes', root: finish(root), start: window.start, end: window.end };
}

function addInto(target: Draft, source: FlameNode): void {
  target.self += source.self;
  for (const c of source.children) addInto(child(target, frameOf(c)), c);
}

/** Sum of trees of one unit (the last N CPU windows → "last 30 s"). `null` for an empty list. */
export function mergeFlames(trees: readonly FlameTree[]): FlameTree | null {
  const first = trees[0];
  if (first === undefined) return null;
  const root = draft(frameOf(first.root));
  let start = first.start;
  let end = first.end;
  for (const tree of trees) {
    if (tree.unit !== first.unit) throw new Error(`cannot merge ${tree.unit} into ${first.unit}`);
    addInto(root, tree.root);
    start = Math.min(start, tree.start);
    end = Math.max(end, tree.end);
  }
  return { unit: first.unit, root: finish(root), start, end };
}

/**
 * V8 names one script differently by profile: CPU profiles use a `file://` URL
 * (`file:///My%20Dir/a.cjs`), heap sampling profiles the path (`/My Dir/a.cjs`).
 * This maps both, and Windows forms, to one comparable path.
 */
export function scriptPath(url: string): string {
  let path = url;
  if (path.startsWith('file://')) {
    path = path.slice('file://'.length);
    try {
      path = decodeURIComponent(path);
    } catch {
      // not percent-encoded after all
    }
    if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  }
  return path.replace(/\\/g, '/');
}

function pruneNode(node: FlameNode, script: string): FlameNode | null {
  if (node.url !== '' && scriptPath(node.url) === script) return null;
  const children: FlameNode[] = [];
  let total = node.self;
  for (const c of node.children) {
    const kept = pruneNode(c, script);
    if (kept === null) continue;
    children.push(kept);
    total += kept.total;
  }
  return { ...frameOf(node), self: node.self, total, children };
}

/** The tree without frames of one script and everything they called (the agent's own work). */
export function withoutScript(tree: FlameTree, url: string): FlameTree {
  if (url === '') return tree;
  const root = pruneNode(tree.root, scriptPath(url)) ?? { ...frameOf(tree.root), self: 0, total: 0, children: [] };
  return { unit: tree.unit, root, start: tree.start, end: tree.end };
}

/** V8 pseudo-frames that are not work: excluded from hot lists and from their shares. */
const NOT_WORK: ReadonlySet<string> = new Set(['(root)', '(idle)', '(program)']);

export interface HotFunction extends FlameFrame {
  readonly self: number;
  /** Weight of stacks containing the function, counted once per stack even when recursive. */
  readonly total: number;
  /** self / all work in the tree (idle excluded), 0..1. */
  readonly selfShare: number;
}

/** Functions by self weight across the whole tree, '(idle)', '(program)' and '(root)' left out. */
export function hotFunctions(tree: FlameTree, limit: number): HotFunction[] {
  const byKey = new Map<string, { frame: FlameFrame; self: number; total: number }>();
  const onStack = new Map<string, number>();

  const visit = (node: FlameNode): void => {
    const key = frameKey(node);
    let entry = byKey.get(key);
    if (entry === undefined) {
      entry = { frame: frameOf(node), self: 0, total: 0 };
      byKey.set(key, entry);
    }
    entry.self += node.self;
    const depth = onStack.get(key) ?? 0;
    if (depth === 0) entry.total += node.total;
    onStack.set(key, depth + 1);
    for (const c of node.children) visit(c);
    onStack.set(key, depth);
  };
  visit(tree.root);

  let work = 0;
  for (const entry of byKey.values()) if (!NOT_WORK.has(entry.frame.name)) work += entry.self;
  const out: HotFunction[] = [];
  for (const entry of byKey.values()) {
    if (entry.self === 0 || NOT_WORK.has(entry.frame.name)) continue;
    out.push({ ...entry.frame, self: entry.self, total: entry.total, selfShare: work > 0 ? entry.self / work : 0 });
  }
  out.sort((a, b) => b.self - a.self);
  return out.slice(0, limit);
}
