// Wire protocol between the agent (inside the target), the host probe (in the CLI) and
// every viewer. Agents send raw cumulative counters; all derivation lives in core.
// Transport: one JSON object per line (see ndjson.ts).

import { parseCpuProfile, parseHeapProfile, type CpuProfile, type HeapProfile } from './cdp.js';
import { Fields, ProtocolError, parseWith, readNumber, type Parsed } from './guard.js';
import { parseHttp, type HttpMessage } from './http.js';
import { parseIo, type IoMessage } from './io.js';

export const PROTOCOL_VERSION = 1;

/** One process thread: `pid:threadId`. */
export type SourceId = string & { readonly __brand: 'SourceId' };

export function toSourceId(pid: number, threadId: number): SourceId {
  return `${pid}:${threadId}` as SourceId;
}

// ---- hello ----------------------------------------------------------------------------------

export interface Hello {
  readonly type: 'hello';
  readonly protocol: number;
  readonly pid: number;
  readonly threadId: number;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly argv: readonly string[];
  readonly execArgv: readonly string[];
  /** `performance.timeOrigin`: epoch ms when the process (or worker) started. */
  readonly timeOrigin: number;
  readonly intervalMs: number;
  /** `os.availableParallelism()`. */
  readonly cpus: number;
  /** `os.totalmem()`, bytes. */
  readonly totalMemory: number;
  /** The agent bundle's script name as V8 reports it in profiles (the file path for CommonJS), so its own frames can be cut out; '' when unknown. */
  readonly agentScript: string;
}

// ---- sample ---------------------------------------------------------------------------------

/** `process.cpuUsage()`: cumulative microseconds. */
export interface CpuTimes {
  readonly user: number;
  readonly system: number;
}

/** `performance.eventLoopUtilization()`: cumulative milliseconds. */
export interface LoopTimes {
  readonly idle: number;
  readonly active: number;
}

/** `monitorEventLoopDelay()` since the previous sample, ms, minus the histogram's timer resolution: 0 = no delay. */
export interface LoopDelay {
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly stddev: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
}

/** `performance.nodeTiming.uvMetricsInfo` (Node >= 20.18 / 22.8): cumulative. */
export interface UvCounters {
  readonly loopCount: number;
  readonly events: number;
}

/** `process.memoryUsage()`, bytes. */
export interface Memory {
  readonly rss: number;
  readonly heapTotal: number;
  readonly heapUsed: number;
  readonly external: number;
  readonly arrayBuffers: number;
}

/** `v8.getHeapStatistics()`, bytes and counts. */
export interface HeapStats {
  readonly limit: number;
  readonly totalAvailable: number;
  readonly malloced: number;
  readonly peakMalloced: number;
  readonly nativeContexts: number;
  readonly detachedContexts: number;
}

/** `v8.getHeapSpaceStatistics()` entry, bytes. */
export interface HeapSpace {
  readonly name: string;
  readonly size: number;
  readonly used: number;
  readonly available: number;
}

export type GcKind = 'minor' | 'major' | 'incremental' | 'weakcb' | 'other';

export const GC_KINDS: readonly GcKind[] = ['minor', 'major', 'incremental', 'weakcb', 'other'];

export interface GcEvent {
  /** Epoch ms. */
  readonly start: number;
  readonly duration: number;
  readonly kind: GcKind;
}

/** `process.getActiveResourcesInfo()` grouped by type. */
export interface ResourceCount {
  readonly type: string;
  readonly count: number;
}

/** `process.resourceUsage()`: cumulative counters, except `maxRss`. */
export interface Rusage {
  /** Peak resident set, bytes. */
  readonly maxRss: number;
  readonly minorFaults: number;
  /** Page faults served from disk: swapping or cold mmap. */
  readonly majorFaults: number;
  readonly voluntarySwitches: number;
  readonly involuntarySwitches: number;
  readonly fsReads: number;
  readonly fsWrites: number;
}

/** Process view of the machine (or container). */
export interface SystemMemory {
  /** `os.freemem()`, bytes. */
  readonly free: number;
  /** `process.availableMemory()` (Node >= 22): honours cgroup limits. */
  readonly available: number | null;
  /** `process.constrainedMemory()`: cgroup memory limit, `null` when unlimited. */
  readonly limit: number | null;
  /** This process's swapped-out memory (`VmSwap`, Linux only). */
  readonly processSwap: number | null;
  /** `os.loadavg()[0]`; 0 on Windows. */
  readonly loadAvg1: number;
}

export interface Sample {
  readonly type: 'sample';
  /** Epoch ms (`timeOrigin + performance.now()`). */
  readonly t: number;
  readonly cpu: CpuTimes;
  readonly loop: LoopTimes;
  readonly loopDelay: LoopDelay;
  readonly uv: UvCounters | null;
  readonly memory: Memory;
  readonly heap: HeapStats;
  readonly heapSpaces: readonly HeapSpace[];
  readonly gc: readonly GcEvent[];
  readonly resources: readonly ResourceCount[];
  readonly rusage: Rusage;
  readonly system: SystemMemory;
  /** Main-thread time the agent itself took since the previous sample, microseconds. */
  readonly overheadUs: number;
}

// ---- profiles -------------------------------------------------------------------------------

export interface CpuProfileMessage {
  readonly type: 'cpu-profile';
  /** Epoch ms of the profiling window. */
  readonly start: number;
  readonly end: number;
  readonly profile: CpuProfile;
}

export interface HeapProfileMessage {
  readonly type: 'heap-profile';
  readonly start: number;
  readonly end: number;
  readonly profile: HeapProfile;
}

// ---- loop trace -----------------------------------------------------------------------------

/**
 * One callback run by the event loop, as recorded by the agent's async hook.
 * On the wire events are flat (`LOOP_EVENT_STRIDE` numbers each) to keep high-rate batches small.
 */
export interface LoopTraceEvent {
  /** async_hooks resource type: `Timeout`, `Immediate`, `TickObject`, `PROMISE`, `TCPWRAP`, ... */
  readonly resource: string;
  /** Callback name when the agent could read it (`setTimeout(function poll() {})`), else ''. */
  readonly name: string;
  /** `uvMetricsInfo.loopCount` when the callback started; -1 when unknown. */
  readonly iteration: number;
  /** Epoch ms. */
  readonly start: number;
  readonly duration: number;
  /** Nesting under another traced callback (0 = called by the loop itself). */
  readonly depth: number;
}

/** Per resource type, within one trace batch. */
export interface LoopTraceCounter {
  readonly resource: string;
  readonly created: number;
  readonly executed: number;
  /** Destroyed, or resolved for promises. */
  readonly settled: number;
  /** Time spent in callbacks of this type, ms (exact even when events were dropped). */
  readonly busy: number;
}

export interface LoopTraceMessage {
  readonly type: 'loop-trace';
  readonly start: number;
  readonly end: number;
  readonly events: readonly LoopTraceEvent[];
  readonly counters: readonly LoopTraceCounter[];
  /** Events not sent because the batch hit its cap; counters still include them. */
  readonly dropped: number;
}

/** Wire layout of one event: type index, iteration, start µs from batch start, duration µs, depth, name index. */
export const LOOP_EVENT_STRIDE = 6;

// ---- host probe (CLI side, outside the target) ----------------------------------------------

export interface Gpu {
  readonly index: number;
  readonly name: string;
  /** 0..1, `null` when the driver does not report it. */
  readonly utilization: number | null;
  readonly memoryUsed: number;
  /** `null` for unified memory (Apple Silicon): the GPU shares RAM. */
  readonly memoryTotal: number | null;
  /** GPU memory held by the target process, `null` when not attributable. */
  readonly processMemory: number | null;
}

export interface HostSample {
  readonly type: 'host';
  readonly t: number;
  /** Machine-wide swap; `null` when the probe cannot read it. */
  readonly swap: { readonly total: number; readonly used: number } | null;
  /** Empty when there is no GPU or no tool to read it. */
  readonly gpus: readonly Gpu[];
}

// ---- errors ---------------------------------------------------------------------------------

export interface AgentError {
  readonly type: 'agent-error';
  readonly message: string;
}

export type StreamMessage =
  | Hello
  | Sample
  | CpuProfileMessage
  | HeapProfileMessage
  | LoopTraceMessage
  | HttpMessage
  | IoMessage
  | HostSample
  | AgentError;

// ---- commands (viewer → CLI → agent) --------------------------------------------------------

export type AgentCommand =
  | { readonly type: 'cpu-profile-start'; readonly samplingIntervalUs: number; readonly windowMs: number }
  | { readonly type: 'cpu-profile-stop' }
  | { readonly type: 'heap-sampling-start'; readonly samplingIntervalBytes: number; readonly windowMs: number }
  | { readonly type: 'heap-sampling-stop' }
  /** Tracing costs real CPU (async_hooks + promise hooks), so it always has a time limit. */
  | { readonly type: 'loop-trace-start'; readonly flushMs: number; readonly maxEventsPerFlush: number; readonly durationMs: number }
  | { readonly type: 'loop-trace-stop' }
  /** Times file system calls by wrapping the `fs` functions: opt-in, it changes the module's functions. */
  | { readonly type: 'fs-timing-start' }
  | { readonly type: 'fs-timing-stop' };

// ---- parsing --------------------------------------------------------------------------------

/** `NODE_PERFORMANCE_GC_*` from `perf_hooks.constants`; 2 is V8's minor mark-sweep. */
function gcKind(code: number): GcKind {
  switch (code) {
    case 1:
    case 2:
      return 'minor';
    case 4:
      return 'major';
    case 8:
      return 'incremental';
    case 16:
      return 'weakcb';
    default:
      return 'other';
  }
}

function parseHello(f: Fields): Hello {
  const protocol = f.number('protocol');
  if (protocol !== PROTOCOL_VERSION) throw new ProtocolError(f.at('protocol'), `protocol ${PROTOCOL_VERSION}`);
  return {
    type: 'hello',
    protocol,
    pid: f.number('pid'),
    threadId: f.number('threadId'),
    nodeVersion: f.string('nodeVersion'),
    platform: f.string('platform'),
    arch: f.string('arch'),
    argv: f.strings('argv'),
    execArgv: f.strings('execArgv'),
    timeOrigin: f.number('timeOrigin'),
    intervalMs: f.number('intervalMs'),
    cpus: f.number('cpus'),
    totalMemory: f.number('totalMemory'),
    agentScript: f.has('agentScript') ? f.string('agentScript') : '',
  };
}

function parseGcEvent(value: unknown, path: string): GcEvent {
  const f = Fields.of(value, path);
  return { start: f.number('start'), duration: f.number('duration'), kind: gcKind(f.number('kind')) };
}

function parseHeapSpace(value: unknown, path: string): HeapSpace {
  const f = Fields.of(value, path);
  return { name: f.string('name'), size: f.number('size'), used: f.number('used'), available: f.number('available') };
}

function parseUv(value: unknown, path: string): UvCounters | null {
  if (value === null || value === undefined) return null;
  const f = Fields.of(value, path);
  return { loopCount: f.number('loopCount'), events: f.number('events') };
}

/** The agent sends `{ Timeout: 3, TCPWrap: 2 }`; viewers get a stable sorted list. */
function parseResources(f: Fields): ResourceCount[] {
  const out: ResourceCount[] = [];
  for (const [type, count] of f.entries()) out.push({ type, count: readNumber(count, f.at(type)) });
  out.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  return out;
}

function parseSample(f: Fields): Sample {
  const cpu = f.fields('cpu');
  const loop = f.fields('loop');
  const delay = f.fields('loopDelay');
  const memory = f.fields('memory');
  const heap = f.fields('heap');
  const rusage = f.fields('rusage');
  const system = f.fields('system');
  return {
    type: 'sample',
    t: f.number('t'),
    cpu: { user: cpu.number('user'), system: cpu.number('system') },
    loop: { idle: loop.number('idle'), active: loop.number('active') },
    loopDelay: {
      min: delay.number('min'),
      max: delay.number('max'),
      mean: delay.number('mean'),
      stddev: delay.number('stddev'),
      p50: delay.number('p50'),
      p90: delay.number('p90'),
      p99: delay.number('p99'),
    },
    uv: f.read('uv', parseUv),
    memory: {
      rss: memory.number('rss'),
      heapTotal: memory.number('heapTotal'),
      heapUsed: memory.number('heapUsed'),
      external: memory.number('external'),
      arrayBuffers: memory.number('arrayBuffers'),
    },
    heap: {
      limit: heap.number('limit'),
      totalAvailable: heap.number('totalAvailable'),
      malloced: heap.number('malloced'),
      peakMalloced: heap.number('peakMalloced'),
      nativeContexts: heap.number('nativeContexts'),
      detachedContexts: heap.number('detachedContexts'),
    },
    heapSpaces: f.list('heapSpaces', parseHeapSpace),
    gc: f.list('gc', parseGcEvent),
    resources: parseResources(f.fields('resources')),
    rusage: {
      maxRss: rusage.number('maxRssKb') * 1024,
      minorFaults: rusage.number('minorFaults'),
      majorFaults: rusage.number('majorFaults'),
      voluntarySwitches: rusage.number('voluntarySwitches'),
      involuntarySwitches: rusage.number('involuntarySwitches'),
      fsReads: rusage.number('fsReads'),
      fsWrites: rusage.number('fsWrites'),
    },
    system: {
      free: system.number('free'),
      available: system.numberOrNull('available'),
      limit: system.numberOrNull('limit'),
      processSwap: system.numberOrNull('processSwap'),
      loadAvg1: system.number('loadAvg1'),
    },
    overheadUs: f.number('overheadUs'),
  };
}

function dictionaryEntry(dictionary: readonly string[], index: number, path: string): string {
  if (index === -1) return '';
  const value = dictionary[index];
  if (value === undefined) throw new ProtocolError(path, `index into a dictionary of ${dictionary.length}`);
  return value;
}

function parseLoopTrace(f: Fields): LoopTraceMessage {
  const start = f.number('start');
  const types = f.strings('types');
  const names = f.strings('names');
  const flat = f.numbers('events');
  if (flat.length % LOOP_EVENT_STRIDE !== 0) throw new ProtocolError(f.at('events'), `a multiple of ${LOOP_EVENT_STRIDE} numbers`);
  const events: LoopTraceEvent[] = new Array<LoopTraceEvent>(flat.length / LOOP_EVENT_STRIDE);
  for (let i = 0, e = 0; i < flat.length; i += LOOP_EVENT_STRIDE, e++) {
    const path = `${f.at('events')}[${i}]`;
    // Length is a multiple of the stride, so every slot below exists.
    const at = (offset: number): number => flat[i + offset] as number;
    events[e] = {
      resource: dictionaryEntry(types, at(0), path),
      iteration: at(1),
      start: start + at(2) / 1000,
      duration: at(3) / 1000,
      depth: at(4),
      name: dictionaryEntry(names, at(5), path),
    };
  }
  return {
    type: 'loop-trace',
    start,
    end: f.number('end'),
    events,
    counters: f.list('counters', (value, path) => {
      const c = Fields.of(value, path);
      return {
        resource: c.string('resource'),
        created: c.number('created'),
        executed: c.number('executed'),
        settled: c.number('settled'),
        busy: c.number('busyUs') / 1000,
      };
    }),
    dropped: f.number('dropped'),
  };
}

function parseGpu(value: unknown, path: string): Gpu {
  const f = Fields.of(value, path);
  return {
    index: f.number('index'),
    name: f.string('name'),
    utilization: f.numberOrNull('utilization'),
    memoryUsed: f.number('memoryUsed'),
    memoryTotal: f.numberOrNull('memoryTotal'),
    processMemory: f.numberOrNull('processMemory'),
  };
}

function parseHost(f: Fields): HostSample {
  const swap = f.read('swap', (value, path) => {
    if (value === null || value === undefined) return null;
    const s = Fields.of(value, path);
    return { total: s.number('total'), used: s.number('used') };
  });
  return { type: 'host', t: f.number('t'), swap, gpus: f.list('gpus', parseGpu) };
}

function readMessage(value: unknown): StreamMessage {
  const f = Fields.of(value, '$');
  const type = f.string('type');
  switch (type) {
    case 'hello':
      return parseHello(f);
    case 'sample':
      return parseSample(f);
    case 'cpu-profile':
      return { type, start: f.number('start'), end: f.number('end'), profile: f.read('profile', parseCpuProfile) };
    case 'heap-profile':
      return { type, start: f.number('start'), end: f.number('end'), profile: f.read('profile', parseHeapProfile) };
    case 'loop-trace':
      return parseLoopTrace(f);
    case 'http':
      return parseHttp(f);
    case 'io':
      return parseIo(f);
    case 'host':
      return parseHost(f);
    case 'agent-error':
      return { type, message: f.string('message') };
    default:
      throw new ProtocolError(f.at('type'), 'a known message type');
  }
}

export function parseStreamMessage(value: unknown): Parsed<StreamMessage> {
  return parseWith(() => readMessage(value));
}

/** One NDJSON line → message. */
export function decodeStreamMessage(line: string): Parsed<StreamMessage> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  return parseStreamMessage(value);
}

function positive(f: Fields, key: string): number {
  const value = f.number(key);
  if (value <= 0) throw new ProtocolError(f.at(key), 'positive number');
  return value;
}

function readCommand(value: unknown): AgentCommand {
  const f = Fields.of(value, '$');
  const type = f.string('type');
  switch (type) {
    case 'cpu-profile-start':
      return { type, samplingIntervalUs: positive(f, 'samplingIntervalUs'), windowMs: positive(f, 'windowMs') };
    case 'heap-sampling-start':
      return { type, samplingIntervalBytes: positive(f, 'samplingIntervalBytes'), windowMs: positive(f, 'windowMs') };
    case 'loop-trace-start':
      return {
        type,
        flushMs: positive(f, 'flushMs'),
        maxEventsPerFlush: positive(f, 'maxEventsPerFlush'),
        durationMs: positive(f, 'durationMs'),
      };
    case 'cpu-profile-stop':
    case 'heap-sampling-stop':
    case 'loop-trace-stop':
    case 'fs-timing-start':
    case 'fs-timing-stop':
      return { type };
    default:
      throw new ProtocolError(f.at('type'), 'a known command');
  }
}

export function parseAgentCommand(value: unknown): Parsed<AgentCommand> {
  return parseWith(() => readCommand(value));
}
