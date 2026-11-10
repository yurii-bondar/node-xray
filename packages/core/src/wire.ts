// What producers put on the wire, before `parseStreamMessage` normalises it. The agent builds
// these shapes, so the compiler checks its output against what the parser reads.

import type { HttpMessage } from './http.js';
import type { IoMessage } from './io.js';
import type { AgentError, CpuTimes, Hello, HeapSpace, HeapStats, HostSample, LoopDelay, LoopTimes, Memory, SystemMemory, UvCounters } from './protocol.js';

export interface WireGcEvent {
  readonly start: number;
  readonly duration: number;
  /** `NODE_PERFORMANCE_GC_*` code. */
  readonly kind: number;
}

export interface WireRusage {
  /** `process.resourceUsage().maxRSS`, kilobytes. */
  readonly maxRssKb: number;
  readonly minorFaults: number;
  readonly majorFaults: number;
  readonly voluntarySwitches: number;
  readonly involuntarySwitches: number;
  readonly fsReads: number;
  readonly fsWrites: number;
}

export interface WireSample {
  readonly type: 'sample';
  readonly t: number;
  readonly cpu: CpuTimes;
  readonly loop: LoopTimes;
  readonly loopDelay: LoopDelay;
  readonly uv: UvCounters | null;
  readonly memory: Memory;
  readonly heap: HeapStats;
  readonly heapSpaces: readonly HeapSpace[];
  readonly gc: readonly WireGcEvent[];
  /** Active resources by type: `{ Timeout: 3, TCPSocketWrap: 2 }`. */
  readonly resources: Readonly<Record<string, number>>;
  readonly rusage: WireRusage;
  readonly system: SystemMemory;
  readonly overheadUs: number;
}

export interface WireLoopTraceCounter {
  readonly resource: string;
  readonly created: number;
  readonly executed: number;
  readonly settled: number;
  readonly busyUs: number;
}

export interface WireLoopTrace {
  readonly type: 'loop-trace';
  readonly start: number;
  readonly end: number;
  readonly types: readonly string[];
  readonly names: readonly string[];
  /** `LOOP_EVENT_STRIDE` numbers per event. */
  readonly events: readonly number[];
  readonly counters: readonly WireLoopTraceCounter[];
  readonly dropped: number;
}

/** CDP payloads pass through as the inspector returned them. */
export interface WireProfile {
  readonly type: 'cpu-profile' | 'heap-profile';
  readonly start: number;
  readonly end: number;
  readonly profile: unknown;
}

/** HTTP and I/O ticks go on the wire as they are parsed. */
export type WireMessage = Hello | WireSample | WireLoopTrace | WireProfile | HttpMessage | IoMessage | HostSample | AgentError;
