// Opt-in event loop trace: every callback the loop runs, with type, name, iteration and duration.
// Hook callbacks are the hottest code in the repo: they only write numbers into preallocated
// columns. Strings are interned once per resource in `init`.
//
// There is no `destroy` hook: with one, Node tracks the destruction of every promise (a weak
// callback each), which costs several times more than the rest of the trace. What `destroy`
// told us comes from elsewhere (see `settled` below), and per-resource state lives in a
// WeakMap keyed by the resource, so nothing needs removing when a resource goes away.

import { createHook, executionAsyncResource, type AsyncHook } from 'node:async_hooks';
import type { WireLoopTrace, WireLoopTraceCounter } from '@node-xray/core';
import { SelfWork } from './self.js';

export interface TraceLimits {
  readonly flushMs: number;
  readonly maxEventsPerFlush: number;
  readonly durationMs: number;
}

export interface TracerDeps {
  readonly self: SelfWork;
  /** False when the link dropped the batch: its counters and window go into the next one. */
  readonly send: (batch: WireLoopTrace) => boolean;
  /** `performance.now()`. */
  readonly now: () => number;
  readonly timeOrigin: number;
  /** `uvMetricsInfo.loopCount`, or -1 when this Node cannot tell (see `loopCountReader`). */
  readonly loopCount: () => number;
}

const MAX_DEPTH = 256;
const MAX_TYPES = 4096;
const MAX_NAMES = 4096;
const NO_NAME = -1;
/** Type of a resource once the type dictionary is full. */
const OVERFLOW_TYPE = 'Unknown';

// Per-resource info, one small integer (a Smi: no allocation when stored):
// bits 0-11 type index, bits 12-24 name index + 1, then flags.
const TYPE_MASK = 0xfff;
const NAME_SHIFT = 12;
const NAME_MASK = 0x1fff;
/** Created while tracing: counts as settled once (resources older than the trace never do). */
const CREATED = 1 << 25;
const SETTLED = 1 << 26;
/** A Timeout or Immediate on the armed list: settles when Node destroys it (fired or cleared). */
const ARMED = 1 << 27;
/** The agent's own resource: its callbacks are not traced. */
const OWN = -1;
/** Timers and immediates watched for destruction at once; beyond this they settle when they first run. */
const MAX_ARMED = 65_536;
/** Other resources watched for collection at once (see `#collected`); beyond this only a callback settles them. */
const MAX_WATCHED = 262_144;

/** Hook cost calibration: rounds of the workload without and with a scratch trace (after warm-up ones). */
const CALIBRATION_WARMUP = 2;
const CALIBRATION_ROUNDS = 5;
const CALIBRATION_AWAITS = 400;
const CALIBRATION_IMMEDIATES = 32;
/** Room for every event of a traced round, so the scratch trace stores each one like a real one. */
const CALIBRATION_EVENTS = 8192;
const MIN_HOOK_COST_US = 0.05;
const MAX_HOOK_COST_US = 20;

function functionName(resource: object, key: string): string {
  const fn: unknown = Reflect.get(resource, key);
  return typeof fn === 'function' ? fn.name : '';
}

/** Callback name for the resource types that carry one. */
export function callbackName(type: string, resource: object): string {
  switch (type) {
    case 'Timeout':
      return functionName(resource, '_onTimeout');
    case 'Immediate':
      return functionName(resource, '_onImmediate');
    case 'TickObject':
      return functionName(resource, 'callback');
    default:
      return '';
  }
}

/** Type of a resource whose `init` the trace did not see (created before tracing started). */
export function untrackedType(resource: object): string {
  if (resource instanceof Promise) return 'PROMISE';
  const ctor: unknown = Reflect.get(resource, 'constructor');
  const name = typeof ctor === 'function' ? ctor.name : '';
  return name === '' || name === 'Object' ? 'Unknown' : name;
}

/**
 * What the trace sees from a busy application, in small: promise reactions (`await`), nextTicks,
 * and immediates (one loop iteration). The immediates are not unref'd: an unref'd one lets an idle loop
 * sleep in poll until the next timer, which stretched the calibration to tens of seconds and let it
 * overlap whatever ran after it.
 */
async function calibrationWorkload(): Promise<void> {
  const immediates: Array<Promise<void>> = [];
  for (let i = 0; i < CALIBRATION_IMMEDIATES; i++) immediates.push(new Promise<void>((resolve) => void setImmediate(resolve)));
  for (let i = 0; i < CALIBRATION_AWAITS; i++) {
    await null;
    if (i % 4 === 0) await new Promise<void>((resolve) => process.nextTick(resolve));
  }
  await Promise.all(immediates);
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  return values[values.length >> 1] ?? 0;
}

export class LoopTracer {
  #hook: AsyncHook | null = null;
  #flushTimer: NodeJS.Timeout | null = null;
  #stopTimer: NodeJS.Timeout | null = null;
  #cap = 0;
  /** µs per hook callback, measured once, in the background of the first trace; -1 until then. */
  #hookCostUs = -1;
  #calibrating = false;
  /** Hook callbacks not counted as overhead yet (all of them until the cost is known). */
  #hookCalls = 0;

  // Dictionaries live for one trace; each batch sends the types in full (a few dozen) and only
  // the names its events use.
  readonly #typeIndex = new Map<string, number>();
  readonly #types: string[] = [];
  readonly #nameIndex = new Map<string, number>();
  readonly #names: string[] = [];
  /** Name index → index in the batch being built, -1 when not used yet. */
  readonly #nameRemap = new Int32Array(MAX_NAMES).fill(-1);
  #promiseType = 0;
  #timeoutType = 0;
  #immediateType = 0;

  /** Resource → info (see the bit layout above). Promises get no entry unless they are the agent's. */
  #info = new WeakMap<object, number>();
  /** Timers and immediates created while tracing and not destroyed yet; swept on every flush. */
  readonly #armed: object[] = [];
  /**
   * Requests and handles created while tracing whose callback has not run: one a synchronous API
   * made (`randomBytes(n)`, `pbkdf2Sync`) never runs one, so it settles when it is collected.
   * One registry per trace, so a late collection never counts into the next one.
   */
  #collected = this.#newRegistry();
  #watched = 0;

  // Per type index, for the current batch.
  readonly #created: number[] = [];
  readonly #executed: number[] = [];
  /**
   * Promises: resolved. Timeouts and immediates: destroyed (fired once, or cleared), seen on the
   * next flush. Everything else (requests, handles): its callback ran for the first time, or it was
   * collected without one, so `created - settled` is work still waiting for the loop.
   */
  readonly #settled: number[] = [];
  readonly #busyUs: number[] = [];

  // Call stack of running callbacks.
  readonly #stackId = new Float64Array(MAX_DEPTH);
  readonly #stackStart = new Float64Array(MAX_DEPTH);
  /** `SelfWork.spentUs` when the callback started. */
  readonly #stackSelf = new Float64Array(MAX_DEPTH);
  readonly #stackIteration = new Float64Array(MAX_DEPTH);
  readonly #stackInfo = new Int32Array(MAX_DEPTH);
  readonly #stackSkip = new Uint8Array(MAX_DEPTH);
  #depth = 0;

  // Events of the current batch, one column per field.
  #evType = new Uint16Array(0);
  #evIteration = new Float64Array(0);
  #evStart = new Float64Array(0);
  #evDuration = new Float64Array(0);
  #evDepth = new Uint8Array(0);
  #evName = new Int32Array(0);
  #count = 0;
  #dropped = 0;
  #windowStart = 0;

  constructor(private readonly deps: TracerDeps) {}

  get running(): boolean {
    return this.#hook !== null;
  }

  start(limits: TraceLimits): void {
    this.stop();
    const { self } = this.deps;
    this.#arm(limits.maxEventsPerFlush);
    this.#flushTimer = self.own(setInterval(() => self.run(() => this.flush()), limits.flushMs).unref());
    this.#stopTimer = self.own(setTimeout(() => self.run(() => this.stop()), limits.durationMs).unref());
    if (this.#hookCostUs < 0 && !this.#calibrating) this.#calibrate();
  }

  /**
   * Main-thread cost of one hook callback, µs, as a difference: the same workload timed with a
   * scratch trace off and on (the trace's own hooks, same clock and loop counter), several rounds
   * each, medians, divided by the hook callbacks the scratch trace counted. Hook callbacks are
   * too frequent to time one by one, so the trace's overhead is this cost times their number.
   * A few ms of the agent's own async work, run once; whatever trace is on skips it.
   */
  static async measureHookCost(deps: TracerDeps): Promise<number> {
    const { now } = deps;
    const scratch = new LoopTracer({ ...deps, self: new SelfWork(() => undefined), send: () => true });
    scratch.#arm(CALIBRATION_EVENTS);
    const hook = scratch.#hook;
    if (hook === null) return MAX_HOOK_COST_US;
    hook.disable();
    const plain: number[] = [];
    const traced: number[] = [];
    const calls: number[] = [];
    let spentMs = 0;
    try {
      for (let round = 0; round < CALIBRATION_WARMUP + CALIBRATION_ROUNDS; round++) {
        let started = now();
        await calibrationWorkload();
        const plainMs = now() - started;
        // Failed (and torn down) in a hook: no number to give.
        if (scratch.#hook === null) throw new Error('hook cost calibration failed');
        scratch.#count = 0;
        const calls0 = scratch.#hookCalls;
        started = now();
        hook.enable();
        await calibrationWorkload();
        hook.disable();
        const tracedMs = now() - started;
        spentMs += plainMs + tracedMs;
        if (round < CALIBRATION_WARMUP) continue;
        plain.push(plainMs);
        traced.push(tracedMs);
        calls.push(scratch.#hookCalls - calls0);
      }
    } finally {
      scratch.#teardown();
      deps.self.addOverhead(spentMs * 1000);
    }
    const perRound = median(calls);
    if (perRound === 0) return MAX_HOOK_COST_US;
    const us = ((median(traced) - median(plain)) * 1000) / perRound;
    return Math.min(MAX_HOOK_COST_US, Math.max(MIN_HOOK_COST_US, us));
  }

  #calibrate(): void {
    const { self } = this.deps;
    this.#calibrating = true;
    LoopTracer.measureHookCost(this.deps).then(
      (us) =>
        self.run(() => {
          this.#calibrating = false;
          this.#hookCostUs = us;
          this.#chargeHooks();
        }),
      (error: unknown) =>
        self.run(() => {
          // Tried again on the next start; until then the hook callbacks are only counted.
          this.#calibrating = false;
          self.report(error);
        }),
    );
  }

  /** The hook callbacks so far, as the agent's overhead (once their cost is known). */
  #chargeHooks(): void {
    if (this.#hookCostUs < 0) return;
    this.deps.self.addOverhead(this.#hookCalls * this.#hookCostUs);
    this.#hookCalls = 0;
  }

  /** A fresh trace with room for `maxEvents` per batch, hook enabled; no timers. */
  #arm(maxEvents: number): void {
    const { now } = this.deps;
    this.#cap = Math.max(1, Math.floor(maxEvents));
    this.#evType = new Uint16Array(this.#cap);
    this.#evIteration = new Float64Array(this.#cap);
    this.#evStart = new Float64Array(this.#cap);
    this.#evDuration = new Float64Array(this.#cap);
    this.#evDepth = new Uint8Array(this.#cap);
    this.#evName = new Int32Array(this.#cap);
    this.#reset();
    this.#promiseType = this.#intern('PROMISE');
    this.#timeoutType = this.#intern('Timeout');
    this.#immediateType = this.#intern('Immediate');
    this.#windowStart = now();

    // An exception inside an async hook kills the process: none may escape. Inline try/catch,
    // not a wrapper closure, so a hook call allocates nothing.
    this.#hook = createHook({
      init: (_asyncId, type, _trigger, resource) => {
        try {
          this.#hookCalls++;
          this.#init(type, resource);
        } catch (error) {
          this.#fail(error);
        }
      },
      before: (asyncId) => {
        try {
          this.#hookCalls++;
          this.#before(asyncId);
        } catch (error) {
          this.#fail(error);
        }
      },
      after: (asyncId) => {
        try {
          this.#hookCalls++;
          this.#after(asyncId);
        } catch (error) {
          this.#fail(error);
        }
      },
      promiseResolve: () => {
        try {
          this.#hookCalls++;
          if (!this.deps.self.active && !this.#inOwnCallback()) this.#bump(this.#settled, this.#promiseType, 1);
        } catch (error) {
          this.#fail(error);
        }
      },
    });
    this.#hook.enable();
  }

  /** Sends what was collected and keeps tracing. */
  flush(): void {
    if (this.#hook === null) return;
    const started = this.deps.now();
    this.#sweepArmed();
    const events = new Array<number>(this.#count * 6);
    const names: string[] = [];
    const remap = this.#nameRemap;
    for (let i = 0, o = 0; i < this.#count; i++, o += 6) {
      events[o] = this.#evType[i] as number;
      events[o + 1] = this.#evIteration[i] as number;
      events[o + 2] = Math.round(((this.#evStart[i] as number) - this.#windowStart) * 1000);
      events[o + 3] = Math.round((this.#evDuration[i] as number) * 1000);
      events[o + 4] = this.#evDepth[i] as number;
      const name = this.#evName[i] as number;
      let local = NO_NAME;
      if (name !== NO_NAME) {
        local = remap[name] as number;
        if (local === -1) {
          local = names.length;
          remap[name] = local;
          names.push(this.#names[name] as string);
        }
      }
      events[o + 5] = local;
    }
    for (const name of names) remap[this.#nameIndex.get(name) as number] = -1;
    const counters: WireLoopTraceCounter[] = [];
    for (let t = 0; t < this.#types.length; t++) {
      const created = this.#created[t] ?? 0;
      const executed = this.#executed[t] ?? 0;
      const settled = this.#settled[t] ?? 0;
      if (created === 0 && executed === 0 && settled === 0) continue;
      counters.push({ resource: this.#types[t] as string, created, executed, settled, busyUs: Math.round(this.#busyUs[t] ?? 0) });
    }
    const accepted = this.deps.send({
      type: 'loop-trace',
      start: this.deps.timeOrigin + this.#windowStart,
      end: this.deps.timeOrigin + started,
      types: this.#types,
      names,
      events,
      counters,
      dropped: this.#dropped,
    });
    if (accepted) {
      this.#clearBatch();
      this.#windowStart = started;
    } else {
      // Lost on the way (the CLI is behind): its events count as dropped, and its counters and
      // window start carry over into the next batch, so counters stay exact and batches contiguous.
      this.#dropped += this.#count;
      this.#count = 0;
    }
    // The flush itself runs inside `SelfWork.run` and is counted there.
    this.#chargeHooks();
  }

  stop(): void {
    if (this.#hook === null) return;
    this.flush();
    this.#teardown();
  }

  #teardown(): void {
    this.#hook?.disable();
    this.#hook = null;
    if (this.#flushTimer) clearInterval(this.#flushTimer);
    if (this.#stopTimer) clearTimeout(this.#stopTimer);
    this.#flushTimer = null;
    this.#stopTimer = null;
    this.#armed.length = 0;
    this.#info = new WeakMap();
    this.#collected = this.#newRegistry();
    this.#watched = 0;
    this.#depth = 0;
  }

  #newRegistry(): FinalizationRegistry<number> {
    const registry: FinalizationRegistry<number> = new FinalizationRegistry((typeIndex) => {
      // Runs as its own task, after any hook: it must not throw either.
      try {
        if (registry !== this.#collected) return;
        this.#watched--;
        this.#bump(this.#settled, typeIndex, 1);
      } catch (error) {
        this.deps.self.report(error);
      }
    });
    return registry;
  }

  #fail(error: unknown): void {
    this.#teardown();
    this.deps.self.report(error);
  }

  /** A fresh trace: nothing from an earlier one (also one that failed without flushing) leaks in. */
  #reset(): void {
    this.#typeIndex.clear();
    this.#types.length = 0;
    this.#nameIndex.clear();
    this.#names.length = 0;
    this.#created.length = 0;
    this.#executed.length = 0;
    this.#settled.length = 0;
    this.#busyUs.length = 0;
    this.#armed.length = 0;
    this.#info = new WeakMap();
    this.#collected = this.#newRegistry();
    this.#watched = 0;
    this.#depth = 0;
    this.#clearBatch();
  }

  #clearBatch(): void {
    this.#created.fill(0);
    this.#executed.fill(0);
    this.#settled.fill(0);
    this.#busyUs.fill(0);
    this.#count = 0;
    this.#dropped = 0;
  }

  #intern(type: string): number {
    let index = this.#typeIndex.get(type);
    if (index === undefined) {
      if (this.#types.length >= MAX_TYPES - 1 && type !== OVERFLOW_TYPE) return this.#intern(OVERFLOW_TYPE);
      index = this.#types.length;
      this.#types.push(type);
      this.#typeIndex.set(type, index);
      this.#created.push(0);
      this.#executed.push(0);
      this.#settled.push(0);
      this.#busyUs.push(0);
    }
    return index;
  }

  #internName(name: string): number {
    if (name === '') return NO_NAME;
    let index = this.#nameIndex.get(name);
    if (index === undefined) {
      if (this.#names.length >= MAX_NAMES) return NO_NAME;
      index = this.#names.length;
      this.#names.push(name);
      this.#nameIndex.set(name, index);
    }
    return index;
  }

  #bump(column: number[], index: number, by: number): void {
    column[index] = (column[index] ?? 0) + by;
  }

  /** The innermost running callback is the agent's: whatever it creates or resolves is too. */
  #inOwnCallback(): boolean {
    const d = this.#depth - 1;
    return d >= 0 && d < MAX_DEPTH && this.#stackSkip[d] === 1;
  }

  #init(type: string, resource: object): void {
    // Created by agent code, or by the agent's async work after its first await (a promise
    // continuation runs outside `SelfWork.run`, but inside a callback the trace skips).
    if (this.deps.self.active || this.#inOwnCallback() || this.deps.self.resources.has(resource)) {
      this.#info.set(resource, OWN);
      return;
    }
    const typeIndex = this.#intern(type);
    this.#bump(this.#created, typeIndex, 1);
    // Promises are the bulk of async resources: no entry, `before` recognises them.
    if (typeIndex === this.#promiseType) return;
    let info = typeIndex | ((this.#internName(callbackName(type, resource)) + 1) << NAME_SHIFT) | CREATED;
    if (
      (typeIndex === this.#timeoutType || typeIndex === this.#immediateType) &&
      this.#armed.length < MAX_ARMED &&
      typeof Reflect.get(resource, '_destroyed') === 'boolean'
    ) {
      info |= ARMED;
      this.#armed.push(resource);
    } else if (this.#watched < MAX_WATCHED) {
      this.#watched++;
      this.#collected.register(resource, typeIndex, resource);
    }
    this.#info.set(resource, info);
  }

  /** Timers and immediates Node destroyed since the last flush (fired, or cleared) are settled. */
  #sweepArmed(): void {
    const armed = this.#armed;
    let kept = 0;
    for (let i = 0; i < armed.length; i++) {
      const resource = armed[i] as object;
      if (Reflect.get(resource, '_destroyed') === true) {
        const info = this.#info.get(resource);
        if (info !== undefined && info !== OWN) this.#bump(this.#settled, info & TYPE_MASK, 1);
      } else {
        armed[kept++] = resource;
      }
    }
    armed.length = kept;
  }

  #before(asyncId: number): void {
    const d = this.#depth++;
    if (d >= MAX_DEPTH) return;
    this.#stackId[d] = asyncId;
    const resource = executionAsyncResource();
    let info = this.#info.get(resource);
    if (info === undefined) {
      if (resource instanceof Promise) {
        info = this.#promiseType;
      } else if (this.deps.self.resources.has(resource)) {
        info = OWN;
        this.#info.set(resource, info);
      } else {
        // Created before tracing started (a `setInterval` keeps its resource across runs, so a
        // long-lived interval never passes through `init`).
        const type = untrackedType(resource);
        const typeIndex = this.#intern(type);
        info = typeIndex | ((this.#internName(callbackName(type, resource)) + 1) << NAME_SHIFT);
        this.#info.set(resource, info);
      }
    }
    if (info === OWN) {
      this.#stackSkip[d] = 1;
      return;
    }
    if ((info & (CREATED | SETTLED | ARMED)) === CREATED) {
      this.#bump(this.#settled, info & TYPE_MASK, 1);
      this.#info.set(resource, info | SETTLED);
      if (this.#collected.unregister(resource)) this.#watched--;
    }
    this.#stackSkip[d] = 0;
    this.#stackInfo[d] = info;
    this.#stackIteration[d] = d === 0 ? this.deps.loopCount() : (this.#stackIteration[d - 1] as number);
    this.#stackSelf[d] = this.deps.self.spentUs;
    this.#stackStart[d] = this.deps.now();
  }

  #after(asyncId: number): void {
    if (this.#depth === 0) return;
    if (this.#depth > MAX_DEPTH) {
      this.#depth--;
      return;
    }
    // An exception can skip `after` hooks: unwind to the matching frame.
    let d = this.#depth - 1;
    while (d >= 0 && this.#stackId[d] !== asyncId) d--;
    if (d < 0) return;
    this.#depth = d;
    if (this.#stackSkip[d] === 1) return;

    const start = this.#stackStart[d] as number;
    // Agent work inside the callback is not the application's: Node runs the agent's GC and DNS
    // observers from an immediate of its own, HTTP subscribers run inside request callbacks.
    const agentMs = (this.deps.self.spentUs - (this.#stackSelf[d] as number)) / 1000;
    const duration = Math.max(0, this.deps.now() - start - agentMs);
    const info = this.#stackInfo[d] as number;
    const typeIndex = info & TYPE_MASK;
    this.#bump(this.#executed, typeIndex, 1);
    this.#bump(this.#busyUs, typeIndex, duration * 1000);
    if (this.#count >= this.#cap) {
      this.#dropped++;
      return;
    }
    const i = this.#count++;
    this.#evType[i] = typeIndex;
    this.#evIteration[i] = this.#stackIteration[d] as number;
    this.#evStart[i] = start;
    this.#evDuration[i] = duration;
    this.#evDepth[i] = d;
    this.#evName[i] = ((info >>> NAME_SHIFT) & NAME_MASK) - 1;
  }
}
