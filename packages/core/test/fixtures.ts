import type { CallFrame } from '../src/cdp.js';
import type { Frame } from '../src/frame.js';
import type { Hello, Sample } from '../src/protocol.js';
import type { WireSample } from '../src/wire.js';

export const MiB = 1024 * 1024;

export const hello: Hello = {
  type: 'hello',
  protocol: 1,
  pid: 4242,
  threadId: 0,
  nodeVersion: 'v24.15.0',
  platform: 'linux',
  arch: 'x64',
  argv: ['node', 'server.js'],
  execArgv: [],
  timeOrigin: 1_700_000_000_000,
  intervalMs: 1000,
  cpus: 4,
  totalMemory: 8 * 1024 * MiB,
  agentScript: '/opt/xray/agent.cjs',
};

/** A quiet process at `t`; tests override only what they assert on. */
export function sample(t: number, overrides: Partial<Omit<Sample, 'type' | 't'>> = {}): Sample {
  return {
    type: 'sample',
    t,
    cpu: { user: 0, system: 0 },
    loop: { idle: 0, active: 0 },
    loopDelay: { min: 0, max: 1, mean: 0.2, stddev: 0.1, p50: 0.1, p90: 0.5, p99: 0.9 },
    uv: null,
    memory: { rss: 100 * MiB, heapTotal: 60 * MiB, heapUsed: 40 * MiB, external: 2 * MiB, arrayBuffers: MiB },
    heap: { limit: 4096 * MiB, totalAvailable: 4000 * MiB, malloced: MiB, peakMalloced: 2 * MiB, nativeContexts: 1, detachedContexts: 0 },
    heapSpaces: [],
    gc: [],
    resources: [],
    rusage: { maxRss: 120 * MiB, minorFaults: 0, majorFaults: 0, voluntarySwitches: 0, involuntarySwitches: 0, fsReads: 0, fsWrites: 0 },
    system: { free: 4096 * MiB, available: null, limit: null, processSwap: null, loadAvg1: 0.5 },
    overheadUs: 0,
    ...overrides,
  };
}

/** The same quiet process as the agent puts it on the wire. */
export function wireSample(t: number): WireSample {
  return {
    type: 'sample',
    t,
    cpu: { user: 1500, system: 500 },
    loop: { idle: 900, active: 100 },
    loopDelay: { min: 0, max: 2, mean: 0.2, stddev: 0.1, p50: 0.1, p90: 0.5, p99: 1 },
    uv: { loopCount: 120, events: 300 },
    memory: { rss: 100, heapTotal: 60, heapUsed: 40, external: 2, arrayBuffers: 1 },
    heap: { limit: 4096, totalAvailable: 4000, malloced: 1, peakMalloced: 2, nativeContexts: 1, detachedContexts: 0 },
    heapSpaces: [{ name: 'new_space', size: 16, used: 3, available: 13 }],
    gc: [
      { start: t - 500, duration: 1.5, kind: 1 },
      { start: t - 300, duration: 12, kind: 4 },
      { start: t - 200, duration: 0.5, kind: 2 },
      { start: t - 100, duration: 0.2, kind: 99 },
    ],
    resources: { Timeout: 2, TCPSocketWrap: 5, FSReqCallback: 2 },
    rusage: { maxRssKb: 2048, minorFaults: 10, majorFaults: 0, voluntarySwitches: 5, involuntarySwitches: 1, fsReads: 0, fsWrites: 3 },
    system: { free: 4096, available: null, limit: null, processSwap: null, loadAvg1: 0.5 },
    overheadUs: 200,
  };
}

export function callFrame(functionName: string, lineNumber = 0, url = 'file:///app/server.js'): CallFrame {
  return { functionName, scriptId: '1', url, lineNumber, columnNumber: 0 };
}

/** Frames one second apart with a given heapUsed / rss series. */
export function framesOf(points: ReadonlyArray<{ heapUsed: number; rss?: number; heapTotal?: number }>, start = 0): Frame[] {
  return points.map((point, i) => {
    const base = sample(start + (i + 1) * 1000);
    return {
      t: base.t,
      dt: 1000,
      cpu: { user: 0, system: 0, total: 0, ofMachine: 0 },
      loop: { utilization: 0, delay: base.loopDelay, iterationsPerSec: null, eventsPerSec: null },
      memory: { ...base.memory, heapUsed: point.heapUsed, rss: point.rss ?? base.memory.rss, heapTotal: point.heapTotal ?? base.memory.heapTotal },
      heap: base.heap,
      heapSpaces: [],
      gc: {
        count: 0,
        pause: 0,
        maxPause: 0,
        pauseRatio: 0,
        byKind: {
          minor: { count: 0, pause: 0 },
          major: { count: 0, pause: 0 },
          incremental: { count: 0, pause: 0 },
          weakcb: { count: 0, pause: 0 },
          other: { count: 0, pause: 0 },
        },
      },
      resources: [],
      os: {
        rss: point.rss ?? base.memory.rss,
        maxRss: base.rusage.maxRss,
        memoryLimit: 8 * 1024 * MiB,
        memoryShare: 0.01,
        processSwap: null,
        systemFree: base.system.free,
        systemAvailable: null,
        majorFaultsPerSec: 0,
        minorFaultsPerSec: 0,
        voluntarySwitchesPerSec: 0,
        involuntarySwitchesPerSec: 0,
        fsReadsPerSec: 0,
        fsWritesPerSec: 0,
        loadAvg1: 0.5,
      },
      overhead: 0,
    };
  });
}
