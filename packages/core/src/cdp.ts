// Chrome DevTools Protocol payloads produced by `Profiler.stop` and
// `HeapProfiler.getSamplingProfile`, narrowed to the fields node-xray reads.

import { Fields } from './guard.js';

export interface CallFrame {
  readonly functionName: string;
  readonly scriptId: string;
  readonly url: string;
  /** 0-based, as CDP sends it. */
  readonly lineNumber: number;
  /** 0-based, as CDP sends it. */
  readonly columnNumber: number;
}

export interface PositionTick {
  /** 1-based source line. */
  readonly line: number;
  readonly ticks: number;
}

export interface CpuProfileNode {
  readonly id: number;
  readonly callFrame: CallFrame;
  readonly hitCount: number;
  readonly children: readonly number[];
  /** Samples per line inside this function; empty when V8 did not record positions. */
  readonly positionTicks: readonly PositionTick[];
}

export interface CpuProfile {
  readonly nodes: readonly CpuProfileNode[];
  /** Microseconds, profiler clock. */
  readonly startTime: number;
  readonly endTime: number;
  readonly samples: readonly number[];
}

export interface HeapProfileNode {
  readonly callFrame: CallFrame;
  /** Bytes sampled at exactly this frame. */
  readonly selfSize: number;
  readonly children: readonly HeapProfileNode[];
}

export interface HeapProfile {
  readonly head: HeapProfileNode;
}

function parseCallFrame(f: Fields): CallFrame {
  return {
    functionName: f.string('functionName'),
    scriptId: f.string('scriptId'),
    url: f.string('url'),
    lineNumber: f.number('lineNumber'),
    columnNumber: f.number('columnNumber'),
  };
}

function parseCpuNode(value: unknown, path: string): CpuProfileNode {
  const f = Fields.of(value, path);
  return {
    id: f.number('id'),
    callFrame: parseCallFrame(f.fields('callFrame')),
    hitCount: f.numberOr('hitCount', 0),
    children: f.has('children') ? f.numbers('children') : [],
    positionTicks: f.has('positionTicks')
      ? f.list('positionTicks', (v, p) => {
          const t = Fields.of(v, p);
          return { line: t.number('line'), ticks: t.number('ticks') };
        })
      : [],
  };
}

export function parseCpuProfile(value: unknown, path: string): CpuProfile {
  const f = Fields.of(value, path);
  return {
    nodes: f.list('nodes', parseCpuNode),
    startTime: f.number('startTime'),
    endTime: f.number('endTime'),
    samples: f.has('samples') ? f.numbers('samples') : [],
  };
}

function parseHeapNode(value: unknown, path: string): HeapProfileNode {
  const f = Fields.of(value, path);
  return {
    callFrame: parseCallFrame(f.fields('callFrame')),
    selfSize: f.number('selfSize'),
    children: f.has('children') ? f.list('children', parseHeapNode) : [],
  };
}

export function parseHeapProfile(value: unknown, path: string): HeapProfile {
  const f = Fields.of(value, path);
  return { head: f.read('head', parseHeapNode) };
}
