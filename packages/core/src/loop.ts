// Event loop trace: what ran, in which phase, in which iteration, and what is still queued.

import type { LoopTraceCounter, LoopTraceEvent, LoopTraceMessage } from './protocol.js';

export type TaskCategory = 'timer' | 'io' | 'immediate' | 'nextTick' | 'microtask' | 'promise';

export const TASK_CATEGORIES: readonly TaskCategory[] = ['timer', 'io', 'immediate', 'nextTick', 'microtask', 'promise'];

/**
 * libuv phases a callback runs in. `microtasks` is not a libuv phase: Node drains
 * `process.nextTick` and then the V8 microtask queue after every macrotask callback.
 */
export type LoopPhase = 'timers' | 'poll' | 'check' | 'microtasks';

export const LOOP_PHASES: readonly LoopPhase[] = ['timers', 'poll', 'check', 'microtasks'];

export function categorize(resource: string): TaskCategory {
  switch (resource) {
    case 'Timeout':
      return 'timer';
    case 'Immediate':
      return 'immediate';
    case 'TickObject':
      return 'nextTick';
    case 'Microtask':
      return 'microtask';
    case 'PROMISE':
      return 'promise';
    default:
      // TCPWRAP, FSREQCALLBACK, GETADDRINFOREQWRAP, HTTPINCOMINGMESSAGE, ...: libuv-backed work.
      return 'io';
  }
}

export function phaseOf(category: TaskCategory): LoopPhase {
  switch (category) {
    case 'timer':
      return 'timers';
    case 'io':
      return 'poll';
    case 'immediate':
      return 'check';
    case 'nextTick':
    case 'microtask':
    case 'promise':
      return 'microtasks';
    default: {
      const unreachable: never = category;
      return unreachable;
    }
  }
}

export interface LoopEvent extends LoopTraceEvent {
  readonly category: TaskCategory;
  readonly phase: LoopPhase;
}

export function toLoopEvents(trace: LoopTraceMessage): LoopEvent[] {
  const out = new Array<LoopEvent>(trace.events.length);
  for (let i = 0; i < trace.events.length; i++) {
    const event = trace.events[i] as LoopTraceEvent;
    const category = categorize(event.resource);
    out[i] = {
      resource: event.resource,
      name: event.name,
      iteration: event.iteration,
      start: event.start,
      duration: event.duration,
      depth: event.depth,
      category,
      phase: phaseOf(category),
    };
  }
  return out;
}

function emptyByCategory(): Record<TaskCategory, number> {
  return { timer: 0, io: 0, immediate: 0, nextTick: 0, microtask: 0, promise: 0 };
}

function emptyByPhase(): Record<LoopPhase, number> {
  return { timers: 0, poll: 0, check: 0, microtasks: 0 };
}

export interface Iteration {
  /** `uvMetricsInfo.loopCount`, or a running number when inferred. */
  readonly index: number;
  /** True when the agent could not read loop counts and boundaries come from phase order. */
  readonly inferred: boolean;
  readonly start: number;
  readonly end: number;
  /** Time in callbacks the loop called directly (depth 0), ms. */
  readonly busy: number;
  /** Callbacks per category, all depths: "4 timers, 2 I/O, 12 promises". */
  readonly counts: Readonly<Record<TaskCategory, number>>;
  /** Busy time per phase (depth 0), ms. */
  readonly phaseBusy: Readonly<Record<LoopPhase, number>>;
}

interface IterationDraft {
  index: number;
  inferred: boolean;
  start: number;
  end: number;
  busy: number;
  counts: Record<TaskCategory, number>;
  phaseBusy: Record<LoopPhase, number>;
}

const PHASE_ORDER: Readonly<Record<LoopPhase, number>> = { timers: 0, poll: 1, check: 2, microtasks: -1 };

/**
 * Groups events (oldest first) into loop iterations. Without loop counts, a new iteration
 * starts when a macrotask runs in an earlier phase than the previous one (check → timers).
 */
export function groupIterations(events: readonly LoopEvent[]): Iteration[] {
  const out: IterationDraft[] = [];
  let current: IterationDraft | null = null;
  let inferredIndex = 0;
  let lastRank = -1;

  for (const event of events) {
    const inferred = event.iteration < 0;
    let index = event.iteration;
    if (inferred) {
      const rank = PHASE_ORDER[event.phase];
      if (rank >= 0) {
        if (rank < lastRank) inferredIndex++;
        lastRank = rank;
      }
      index = inferredIndex;
    }
    if (current === null || current.index !== index || current.inferred !== inferred) {
      current = {
        index,
        inferred,
        start: event.start,
        end: event.start + event.duration,
        busy: 0,
        counts: emptyByCategory(),
        phaseBusy: emptyByPhase(),
      };
      out.push(current);
    }
    current.counts[event.category]++;
    current.end = Math.max(current.end, event.start + event.duration);
    if (event.depth === 0) {
      current.busy += event.duration;
      current.phaseBusy[event.phase] += event.duration;
    }
  }
  return out;
}

export interface CategoryWindow {
  readonly created: number;
  readonly executed: number;
  /** ms */
  readonly busy: number;
}

export interface TraceWindow {
  readonly start: number;
  readonly end: number;
  readonly byCategory: Readonly<Record<TaskCategory, CategoryWindow>>;
  readonly dropped: number;
}

/** Exact per-category totals of one batch (counters are exact even when events were dropped). */
export function summarizeTrace(trace: LoopTraceMessage): TraceWindow {
  const created = emptyByCategory();
  const executed = emptyByCategory();
  const busy = emptyByCategory();
  for (const counter of trace.counters) {
    const category = categorize(counter.resource);
    created[category] += counter.created;
    executed[category] += counter.executed;
    busy[category] += counter.busy;
  }
  const byCategory = {} as Record<TaskCategory, CategoryWindow>;
  for (const category of TASK_CATEGORIES) {
    byCategory[category] = { created: created[category], executed: executed[category], busy: busy[category] };
  }
  return { start: trace.start, end: trace.end, byCategory, dropped: trace.dropped };
}

export interface QueueState {
  readonly resource: string;
  readonly category: TaskCategory;
  /** Created and not yet settled since tracing started; resources older than the trace are not counted. */
  readonly pending: number;
  readonly created: number;
  readonly executed: number;
  readonly busy: number;
}

/** Running totals per resource type across trace batches. */
export class TaskLedger {
  readonly #byResource = new Map<string, { created: number; executed: number; settled: number; busy: number }>();

  apply(counters: readonly LoopTraceCounter[]): void {
    for (const counter of counters) {
      let entry = this.#byResource.get(counter.resource);
      if (entry === undefined) {
        entry = { created: 0, executed: 0, settled: 0, busy: 0 };
        this.#byResource.set(counter.resource, entry);
      }
      entry.created += counter.created;
      entry.executed += counter.executed;
      entry.settled += counter.settled;
      entry.busy += counter.busy;
    }
  }

  /** Most pending first. */
  snapshot(): QueueState[] {
    const out: QueueState[] = [];
    for (const [resource, entry] of this.#byResource) {
      out.push({
        resource,
        category: categorize(resource),
        pending: Math.max(0, entry.created - entry.settled),
        created: entry.created,
        executed: entry.executed,
        busy: entry.busy,
      });
    }
    out.sort((a, b) => b.pending - a.pending || b.executed - a.executed || a.resource.localeCompare(b.resource));
    return out;
  }

  clear(): void {
    this.#byResource.clear();
  }
}
