// Everything known about one source (process thread), fed by stream messages in arrival order.
// The CLI keeps one per connected source; the dashboard keeps its own from the same stream.

import { allocationFlame, cpuFlame, mergeFlames, type FlameTree } from './flame.js';
import { deriveFrame, type Frame } from './frame.js';
import type { HttpMessage } from './http.js';
import type { IoMessage } from './io.js';
import { analyze, analyzeHttp, analyzeIo, type Insight, type InsightOptions } from './insights.js';
import { LineTicks, type HotLines } from './lines.js';
import { groupIterations, summarizeTrace, TaskLedger, toLoopEvents, type Iteration, type LoopEvent, type QueueState, type TraceWindow } from './loop.js';
import type { GcEvent, Hello, HostSample, Sample, StreamMessage } from './protocol.js';
import { Ring } from './ring.js';

export interface TimelineOptions {
  /** At 1 sample/s, 3600 is one hour. */
  readonly frames: number;
  readonly gcEvents: number;
  /** Individual traced callbacks kept for the live lane. */
  readonly loopEvents: number;
  readonly traceWindows: number;
  /** CPU profile windows kept for the merged flame graph. */
  readonly cpuWindows: number;
  readonly hostSamples: number;
  readonly errors: number;
}

export const DEFAULT_TIMELINE_OPTIONS: TimelineOptions = {
  frames: 3600,
  gcEvents: 10_000,
  loopEvents: 50_000,
  traceWindows: 600,
  cpuWindows: 12,
  hostSamples: 3600,
  errors: 50,
};

export class Timeline {
  #hello: Hello | null = null;
  #lastSample: Sample | null = null;
  #allocations: FlameTree | null = null;
  /** Every CPU window since the start, merged as they arrive (the ring keeps only the last few). */
  #cpuTotal: FlameTree | null = null;
  readonly #frames: Ring<Frame>;
  readonly #gc: Ring<GcEvent>;
  readonly #loopEvents: Ring<LoopEvent>;
  readonly #traceWindows: Ring<TraceWindow>;
  readonly #cpu: Ring<FlameTree>;
  readonly #host: Ring<HostSample>;
  readonly #http: Ring<HttpMessage>;
  readonly #io: Ring<IoMessage>;
  readonly #errors: Ring<string>;
  readonly #ledger = new TaskLedger();
  readonly #lines = new LineTicks();

  constructor(overrides: Partial<TimelineOptions> = {}) {
    const options: TimelineOptions = { ...DEFAULT_TIMELINE_OPTIONS, ...overrides };
    this.#frames = new Ring(options.frames);
    this.#gc = new Ring(options.gcEvents);
    this.#loopEvents = new Ring(options.loopEvents);
    this.#traceWindows = new Ring(options.traceWindows);
    this.#cpu = new Ring(options.cpuWindows);
    this.#host = new Ring(options.hostSamples);
    this.#http = new Ring(options.frames);
    this.#io = new Ring(options.frames);
    this.#errors = new Ring(options.errors);
  }

  apply(message: StreamMessage): void {
    switch (message.type) {
      case 'hello':
        // A new hello means a (re)started agent: its cumulative counters start over.
        this.#hello = message;
        this.#lastSample = null;
        break;
      case 'sample':
        this.#applySample(message);
        break;
      case 'cpu-profile': {
        const window = cpuFlame(message.profile, message);
        this.#cpu.push(window);
        this.#cpuTotal = this.#cpuTotal === null ? window : mergeFlames([this.#cpuTotal, window]);
        this.#lines.add(message.profile, this.#hello?.agentScript ?? '');
        break;
      }
      case 'heap-profile':
        this.#allocations = allocationFlame(message.profile, message);
        break;
      case 'loop-trace':
        for (const event of toLoopEvents(message)) this.#loopEvents.push(event);
        this.#traceWindows.push(summarizeTrace(message));
        this.#ledger.apply(message.counters);
        break;
      case 'host':
        this.#host.push(message);
        break;
      case 'http':
        this.#http.push(message);
        break;
      case 'io':
        this.#io.push(message);
        break;
      case 'agent-error':
        this.#errors.push(message.message);
        break;
      default: {
        const unreachable: never = message;
        throw new Error(`unhandled message ${JSON.stringify(unreachable)}`);
      }
    }
  }

  #applySample(sample: Sample): void {
    for (const event of sample.gc) this.#gc.push(event);
    const prev = this.#lastSample;
    this.#lastSample = sample;
    if (this.#hello === null || prev === null) return;
    const frame = deriveFrame({ prev, cur: sample, facts: this.#hello });
    if (frame !== null) this.#frames.push(frame);
  }

  get hello(): Hello | null {
    return this.#hello;
  }

  frames(): Frame[] {
    return this.#frames.toArray();
  }

  latestFrame(): Frame | undefined {
    return this.#frames.last();
  }

  gcEvents(): GcEvent[] {
    return this.#gc.toArray();
  }

  /** Traced callbacks, oldest first. */
  loopEvents(): LoopEvent[] {
    return this.#loopEvents.toArray();
  }

  iterations(): Iteration[] {
    return groupIterations(this.#loopEvents.toArray());
  }

  traceWindows(): TraceWindow[] {
    return this.#traceWindows.toArray();
  }

  /** What is waiting in the loop's queues right now, by resource type. */
  queues(): QueueState[] {
    return this.#ledger.snapshot();
  }

  /** Merged CPU flame graph of the last `windows` profile windows (all kept by default). */
  cpuFlame(windows = Number.POSITIVE_INFINITY): FlameTree | null {
    const all = this.#cpu.toArray();
    return mergeFlames(all.slice(Math.max(0, all.length - windows)));
  }

  /** All CPU profiling of this source merged: what an export of the whole run contains. */
  cpuFlameTotal(): FlameTree | null {
    return this.#cpuTotal;
  }

  /** CPU samples per source line over the whole run (the agent's own lines left out). */
  hotLines(): HotLines {
    return this.#lines.snapshot();
  }

  /** CPU profile windows, oldest first. */
  cpuWindows(): FlameTree[] {
    return this.#cpu.toArray();
  }

  /** Latest allocation sampling profile (cumulative since sampling started). */
  allocations(): FlameTree | null {
    return this.#allocations;
  }

  hostSamples(): HostSample[] {
    return this.#host.toArray();
  }

  errors(): string[] {
    return this.#errors.toArray();
  }

  /** File system and DNS ticks, oldest first. */
  ioWindows(): IoMessage[] {
    return this.#io.toArray();
  }

  /** HTTP ticks, oldest first (as many as frames are kept). */
  httpWindows(): HttpMessage[] {
    return this.#http.toArray();
  }

  insights(options: Partial<InsightOptions> = {}): Insight[] {
    return [...analyze(this.#frames.toArray(), options), ...analyzeHttp(this.#http.toArray(), options), ...analyzeIo(this.#io.toArray(), options)];
  }
}
