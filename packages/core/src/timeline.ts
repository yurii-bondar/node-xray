// Everything known about one source (process thread), fed by stream messages in arrival order.
// The CLI keeps one per connected source; the dashboard keeps its own from the same stream.

import { culpritWindow, insightTime, stallCulprit, summarizeInsights, type CulpritWindow, type InsightSummary } from './findings.js';
import { allocationFlame, cpuFlame, FlameSum, mergeFlames, withoutScript, type FlameTree } from './flame.js';
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
  /** Per-window stall culprits (one small summary per CPU window): as many as frames, the whole run at 1 window/s. */
  readonly culpritWindows: number;
  readonly hostSamples: number;
  readonly errors: number;
}

export const DEFAULT_TIMELINE_OPTIONS: TimelineOptions = {
  frames: 3600,
  gcEvents: 10_000,
  loopEvents: 50_000,
  traceWindows: 600,
  cpuWindows: 12,
  culpritWindows: 3600,
  hostSamples: 3600,
  errors: 50,
};

/** Which findings count: those that happened in `[since, until]`, epoch ms (everything kept by default). */
export interface FindingsSpan {
  readonly since?: number;
  readonly until?: number;
}

/** A derived value and the version (and options) it was computed for. */
interface Memo<T> {
  readonly version: number;
  readonly key: string;
  readonly value: T;
}

export class Timeline {
  #version = 0;
  #hello: Hello | null = null;
  #lastSample: Sample | null = null;
  #allocations: FlameTree | null = null;
  /** Every CPU window since the start, summed as they arrive (the ring keeps only the last few). */
  readonly #cpuTotal = new FlameSum();
  readonly #culprits: Ring<CulpritWindow>;
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
  #insights: Memo<readonly Insight[]> | null = null;
  #findings: Memo<readonly InsightSummary[]> | null = null;

  constructor(overrides: Partial<TimelineOptions> = {}) {
    const options: TimelineOptions = { ...DEFAULT_TIMELINE_OPTIONS, ...overrides };
    this.#frames = new Ring(options.frames);
    this.#gc = new Ring(options.gcEvents);
    this.#loopEvents = new Ring(options.loopEvents);
    this.#traceWindows = new Ring(options.traceWindows);
    this.#cpu = new Ring(options.cpuWindows);
    this.#culprits = new Ring(options.culpritWindows);
    this.#host = new Ring(options.hostSamples);
    this.#http = new Ring(options.frames);
    this.#io = new Ring(options.frames);
    this.#errors = new Ring(options.errors);
  }

  apply(message: StreamMessage): void {
    this.#version++;
    switch (message.type) {
      case 'hello':
        // A new hello means a (re)started agent: its cumulative counters and trace sessions start over.
        this.#hello = message;
        this.#lastSample = null;
        this.#ledger.clear();
        break;
      case 'sample':
        this.#applySample(message);
        break;
      case 'cpu-profile': {
        const window = cpuFlame(message.profile, message);
        const agentScript = this.#hello?.agentScript ?? '';
        this.#cpu.push(window);
        this.#cpuTotal.add(window);
        // The agent's own frames are not the application's work.
        this.#culprits.push(culpritWindow(withoutScript(window, agentScript)));
        this.#lines.add(message.profile, agentScript);
        break;
      }
      case 'heap-profile':
        this.#allocations = allocationFlame(message.profile, message);
        break;
      case 'loop-trace':
        for (const event of toLoopEvents(message)) this.#loopEvents.push(event);
        this.#traceWindows.push(summarizeTrace(message));
        this.#ledger.apply(message);
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

  /** Bumped by every `apply`: derived values computed for one version stay valid until the next. */
  get version(): number {
    return this.#version;
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
    return this.#cpuTotal.tree();
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

  /** Findings over everything kept, oldest first; computed once per version and options (callers share the array). */
  insights(options: Partial<InsightOptions> = {}): readonly Insight[] {
    const key = JSON.stringify(options);
    const memo = this.#insights;
    if (memo !== null && memo.version === this.#version && memo.key === key) return memo.value;
    const value = [...analyze(this.#frames.toArray(), options), ...analyzeHttp(this.#http.toArray(), options), ...analyzeIo(this.#io.toArray(), options)];
    this.#insights = { version: this.#version, key, value };
    return value;
  }

  /**
   * `insights` summarised per kind, a loop stall not caused by GC with the busiest function of the
   * CPU window it fell in (over the whole run, not only the windows kept for the flame graph).
   * Computed once per version, options and span. `span` keeps only the findings that happened in
   * it (a chart window, a paused view): counts and the worst occurrence are of those.
   */
  findings(options: Partial<InsightOptions> = {}, { since = Number.NEGATIVE_INFINITY, until = Number.POSITIVE_INFINITY }: FindingsSpan = {}): readonly InsightSummary[] {
    const key = `${JSON.stringify(options)}|${since}|${until}`;
    const memo = this.#findings;
    if (memo !== null && memo.version === this.#version && memo.key === key) return memo.value;
    const all = this.insights(options);
    const inSpan = Number.isFinite(since) || Number.isFinite(until) ? all.filter((insight) => insightTime(insight) >= since && insightTime(insight) <= until) : all;
    const value = summarizeInsights(inSpan).map((summary) => {
      const worst = summary.worst;
      if (worst.kind !== 'loop-stall' || worst.cause !== 'unknown') return summary;
      // The stall happened somewhere in its frame, which a stall stretches: look back over the whole frame.
      const frame = this.#frameAt(worst.t);
      return { ...summary, ...stallCulprit(this.#culprits.toArray(), { t: worst.t, spanMs: Math.max(frame?.dt ?? 0, worst.delay) }) };
    });
    this.#findings = { version: this.#version, key, value };
    return value;
  }

  #frameAt(t: number): Frame | undefined {
    const frames = this.#frames.toArray();
    for (let i = frames.length - 1; i >= 0; i--) if (frames[i]?.t === t) return frames[i];
    return undefined;
  }
}
