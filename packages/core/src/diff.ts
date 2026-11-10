// What changed between two CPU trees ("baseline" vs "now"). Windows differ in length and in
// idle time, so everything is compared as a share of the work in its own tree.

import { hotFunctions, type FlameFrame, type FlameNode, type FlameTree } from './flame.js';

/** A node of the current tree, with shares of work in both trees. */
export interface DiffNode extends FlameNode {
  /** Share of the current tree's work, 0..1 (also `self`/`total`, so it lays out like a FlameNode). */
  readonly total: number;
  readonly self: number;
  /** Same stack in the baseline, 0 when it did not run there. */
  readonly baseTotal: number;
  readonly baseSelf: number;
  readonly children: readonly DiffNode[];
}

const IDLE: ReadonlySet<string> = new Set(['(idle)', '(program)']);

function frameKey(frame: FlameFrame): string {
  return `${frame.name}\u0000${frame.url}\u0000${frame.line}\u0000${frame.column}`;
}

/** Samples that were work: everything but idle and program time. */
export function workOf(node: FlameNode): number {
  let idle = 0;
  const stack: FlameNode[] = [node];
  for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
    if (IDLE.has(n.name)) idle += n.total;
    else stack.push(...n.children);
  }
  return node.total - idle;
}

function diffNode(current: FlameNode, base: FlameNode | undefined, scale: number, baseScale: number): DiffNode {
  const baseChildren = new Map<string, FlameNode>();
  for (const child of base?.children ?? []) baseChildren.set(frameKey(child), child);
  const children = current.children.filter((c) => !IDLE.has(c.name)).map((c) => diffNode(c, baseChildren.get(frameKey(c)), scale, baseScale));
  return {
    name: current.name,
    url: current.url,
    line: current.line,
    column: current.column,
    self: current.self * scale,
    total: IDLE.has(current.name) ? 0 : children.reduce((sum, c) => sum + c.total, current.self * scale),
    baseSelf: (base?.self ?? 0) * baseScale,
    baseTotal: (base?.total ?? 0) * baseScale,
    children,
  };
}

/** The current tree (idle left out), each node annotated with its baseline share. */
export function diffFlames(base: FlameTree, current: FlameTree): DiffNode {
  const work = workOf(current.root);
  const baseWork = workOf(base.root);
  return diffNode(current.root, base.root, work > 0 ? 1 / work : 0, baseWork > 0 ? 1 / baseWork : 0);
}

export interface FunctionChange extends FlameFrame {
  /** Self share of work now and in the baseline, 0..1. */
  readonly now: number;
  readonly before: number;
  readonly delta: number;
}

/** Functions whose self share of CPU work moved the most, either way. */
export function changedFunctions(base: FlameTree, current: FlameTree, limit: number): FunctionChange[] {
  const before = new Map<string, number>();
  for (const fn of hotFunctions(base, Number.POSITIVE_INFINITY)) before.set(frameKey(fn), fn.selfShare);
  const out: FunctionChange[] = [];
  const seen = new Set<string>();
  for (const fn of hotFunctions(current, Number.POSITIVE_INFINITY)) {
    const key = frameKey(fn);
    seen.add(key);
    const was = before.get(key) ?? 0;
    out.push({ name: fn.name, url: fn.url, line: fn.line, column: fn.column, now: fn.selfShare, before: was, delta: fn.selfShare - was });
  }
  for (const fn of hotFunctions(base, Number.POSITIVE_INFINITY)) {
    if (seen.has(frameKey(fn))) continue;
    out.push({ name: fn.name, url: fn.url, line: fn.line, column: fn.column, now: 0, before: fn.selfShare, delta: -fn.selfShare });
  }
  out.sort((a, b) => {
    const bigger = Math.abs(b.delta) - Math.abs(a.delta);
    // Equal moves (within float noise): what got heavier first.
    return Math.abs(bigger) > 1e-9 ? bigger : b.delta - a.delta;
  });
  return out.slice(0, limit);
}
