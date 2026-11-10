// Flame trees back to the files DevTools and speedscope open: `.cpuprofile` and `.heapprofile`.
// The order of samples within a window is not kept, so these load in every aggregate view
// (call tree, bottom-up, flame chart by weight), not as an exact timeline.

import type { FlameFrame, FlameNode, FlameTree } from './flame.js';

export interface ExportedCallFrame {
  readonly functionName: string;
  readonly scriptId: string;
  readonly url: string;
  /** 0-based; -1 when unknown. */
  readonly lineNumber: number;
  readonly columnNumber: number;
}

export interface ExportedCpuNode {
  readonly id: number;
  readonly callFrame: ExportedCallFrame;
  readonly hitCount: number;
  readonly children: readonly number[];
}

/** Chrome DevTools `.cpuprofile` (CDP `Profiler.Profile`). */
export interface ExportedCpuProfile {
  readonly nodes: readonly ExportedCpuNode[];
  /** Microseconds. */
  readonly startTime: number;
  readonly endTime: number;
  readonly samples: readonly number[];
  readonly timeDeltas: readonly number[];
}

export interface ExportedHeapNode {
  readonly id: number;
  readonly callFrame: ExportedCallFrame;
  readonly selfSize: number;
  readonly children: readonly ExportedHeapNode[];
}

/** Chrome DevTools `.heapprofile` (CDP `HeapProfiler.SamplingHeapProfile`). */
export interface ExportedHeapProfile {
  readonly head: ExportedHeapNode;
  readonly samples: readonly never[];
}

function callFrame(frame: FlameFrame): ExportedCallFrame {
  return {
    functionName: frame.name,
    scriptId: '0',
    url: frame.url,
    lineNumber: frame.line > 0 ? frame.line - 1 : -1,
    columnNumber: frame.column > 0 ? frame.column - 1 : -1,
  };
}

export function toCpuProfile(tree: FlameTree): ExportedCpuProfile {
  if (tree.unit !== 'samples') throw new Error('a .cpuprofile needs a CPU tree');
  const nodes: ExportedCpuNode[] = [];
  const samples: number[] = [];
  let nextId = 1;
  const visit = (node: FlameNode): number => {
    const id = nextId++;
    const slot = nodes.length;
    nodes.push({ id, callFrame: callFrame(node), hitCount: node.self, children: [] });
    const children = node.children.map(visit);
    nodes[slot] = { id, callFrame: callFrame(node), hitCount: node.self, children };
    for (let i = 0; i < node.self; i++) samples.push(id);
    return id;
  };
  visit(tree.root);

  const startTime = Math.round(tree.start * 1000);
  const endTime = Math.max(startTime, Math.round(tree.end * 1000));
  // Spread the samples evenly over the window: the true order is not kept.
  const step = samples.length > 0 ? (endTime - startTime) / samples.length : 0;
  const timeDeltas = samples.map((_, i) => Math.round(step * (i + 1)) - Math.round(step * i));
  return { nodes, startTime, endTime, samples, timeDeltas };
}

export function toHeapProfile(tree: FlameTree): ExportedHeapProfile {
  if (tree.unit !== 'bytes') throw new Error('a .heapprofile needs an allocation tree');
  let nextId = 1;
  const visit = (node: FlameNode): ExportedHeapNode => ({
    id: nextId++,
    callFrame: callFrame(node),
    selfSize: node.self,
    children: node.children.map(visit),
  });
  return { head: visit(tree.root), samples: [] };
}
