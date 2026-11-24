// What a page draws from: one source's data up to a moment (everything when live, up to the
// moment of the pause when paused), each part derived once per timeline version or once per
// pause. No DOM here.

import {
  groupIterations,
  insightTime,
  type FlameTree,
  type Frame,
  type GcEvent,
  type HostSample,
  type HttpMessage,
  type Insight,
  type InsightSummary,
  type IoMessage,
  type Iteration,
  type LoopEvent,
  type QueueState,
  type Timeline,
  type TraceWindow,
} from '@node-xray/core';

/** `until` of a live view: nothing is cut. */
export const LIVE = Number.POSITIVE_INFINITY;

function upTo<T>(items: T[], until: number, time: (item: T) => number): T[] {
  return until === LIVE ? items : items.filter((item) => time(item) <= until);
}

export class Snapshot {
  /** The timeline version it was made at. */
  readonly version: number;
  /** These keep only their latest state, so they are taken when the snapshot is made. */
  readonly queues: readonly QueueState[];
  readonly allocations: FlameTree | null;
  readonly errors: readonly string[];
  #frames: Frame[] | null = null;
  #gc: GcEvent[] | null = null;
  #loop: LoopEvent[] | null = null;
  #iterations: Iteration[] | null = null;
  #trace: TraceWindow[] | null = null;
  #cpu: FlameTree[] | null = null;
  #http: HttpMessage[] | null = null;
  #io: IoMessage[] | null = null;
  #host: HostSample[] | null = null;
  #insights: readonly Insight[] | null = null;

  constructor(
    readonly timeline: Timeline,
    /** Epoch ms; `LIVE` keeps everything. */
    readonly until: number,
  ) {
    this.version = timeline.version;
    this.queues = timeline.queues();
    this.allocations = timeline.allocations();
    this.errors = timeline.errors();
  }

  get frames(): readonly Frame[] {
    return (this.#frames ??= upTo(this.timeline.frames(), this.until, (f) => f.t));
  }

  get latest(): Frame | undefined {
    return this.frames[this.frames.length - 1];
  }

  get gcEvents(): readonly GcEvent[] {
    return (this.#gc ??= upTo(this.timeline.gcEvents(), this.until, (e) => e.start));
  }

  get loopEvents(): readonly LoopEvent[] {
    return (this.#loop ??= upTo(this.timeline.loopEvents(), this.until, (e) => e.start));
  }

  get iterations(): readonly Iteration[] {
    return (this.#iterations ??= groupIterations(this.loopEvents));
  }

  get traceWindows(): readonly TraceWindow[] {
    return (this.#trace ??= upTo(this.timeline.traceWindows(), this.until, (w) => w.end));
  }

  get cpuWindows(): readonly FlameTree[] {
    return (this.#cpu ??= upTo(this.timeline.cpuWindows(), this.until, (w) => w.end));
  }

  get httpWindows(): readonly HttpMessage[] {
    return (this.#http ??= upTo(this.timeline.httpWindows(), this.until, (w) => w.end));
  }

  get ioWindows(): readonly IoMessage[] {
    return (this.#io ??= upTo(this.timeline.ioWindows(), this.until, (w) => w.end));
  }

  get hostSamples(): readonly HostSample[] {
    return (this.#host ??= upTo(this.timeline.hostSamples(), this.until, (s) => s.t));
  }

  /** Every finding kept, oldest first (for chart markers). */
  get insights(): readonly Insight[] {
    return (this.#insights ??= this.until === LIVE ? this.timeline.insights() : this.timeline.insights().filter((i) => insightTime(i) <= this.until));
  }

  /** Findings since `since` (epoch ms, 0 = everything kept), summarised per kind. */
  findings(since: number): readonly InsightSummary[] {
    return this.timeline.findings({}, this.until === LIVE ? { since } : { since, until: this.until });
  }
}

const snapshots = new WeakMap<Timeline, Snapshot>();

/** The snapshot of `timeline` up to `until`, reused while it would show the same: a live one until the next message, a paused one for the whole pause. */
export function snapshotOf(timeline: Timeline, until: number): Snapshot {
  const cached = snapshots.get(timeline);
  if (cached !== undefined && cached.until === until && (until !== LIVE || cached.version === timeline.version)) return cached;
  const snapshot = new Snapshot(timeline, until);
  snapshots.set(timeline, snapshot);
  return snapshot;
}

/** The newest time anything in `timeline` carries, epoch ms (-∞ when empty): where a pause cuts. */
export function latestTime(timeline: Timeline): number {
  const lastLoop = timeline.loopEvents().at(-1);
  const lastGc = timeline.gcEvents().at(-1);
  return Math.max(
    Number.NEGATIVE_INFINITY,
    timeline.latestFrame()?.t ?? Number.NEGATIVE_INFINITY,
    lastGc === undefined ? Number.NEGATIVE_INFINITY : lastGc.start + lastGc.duration,
    lastLoop === undefined ? Number.NEGATIVE_INFINITY : lastLoop.start + lastLoop.duration,
    timeline.traceWindows().at(-1)?.end ?? Number.NEGATIVE_INFINITY,
    timeline.cpuWindows().at(-1)?.end ?? Number.NEGATIVE_INFINITY,
    timeline.httpWindows().at(-1)?.end ?? Number.NEGATIVE_INFINITY,
    timeline.ioWindows().at(-1)?.end ?? Number.NEGATIVE_INFINITY,
    timeline.hostSamples().at(-1)?.t ?? Number.NEGATIVE_INFINITY,
  );
}

/**
 * `compute` remembering its last result: called again with the same arguments (`Object.is`), it
 * returns that result instead of recomputing (merged flame graphs, hot functions).
 */
export function lastResult<A extends readonly unknown[], R>(compute: (...args: A) => R): (...args: A) => R {
  let last: { readonly args: A; readonly value: R } | null = null;
  return (...args: A): R => {
    if (last !== null && last.args.length === args.length && last.args.every((arg, i) => Object.is(arg, args[i]))) return last.value;
    const value = compute(...args);
    last = { args, value };
    return value;
  };
}
