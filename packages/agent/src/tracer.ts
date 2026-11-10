// Opt-in event loop trace: every callback the loop runs, with type, name, iteration and duration.
// Hook callbacks are the hottest code in the repo: they only write numbers into preallocated
// columns. Strings are interned once per resource in `init`.

import { createHook, executionAsyncResource, type AsyncHook } from 'node:async_hooks';
import type { WireLoopTrace, WireLoopTraceCounter } from '@node-xray/core';
import type { SelfWork } from './self.js';

export interface TraceLimits {
  readonly flushMs: number;
  readonly maxEventsPerFlush: number;
  readonly durationMs: number;
}

export interface TracerDeps {
  readonly self: SelfWork;
  readonly send: (batch: WireLoopTrace) => void;
  /** `performance.now()`. */
  readonly now: () => number;
  readonly timeOrigin: number;
  /** `uvMetricsInfo.loopCount`, or -1 when this Node cannot tell. */
  readonly loopCount: () => number;
  /** Main-thread time spent flushing, µs. */
  readonly addOverhead: (us: number) => void;
}

const MAX_DEPTH = 256;
const MAX_NAMES = 4096;
const NO_NAME = -1;

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

export class LoopTracer {
  #hook: AsyncHook | null = null;
  #flushTimer: NodeJS.Timeout | null = null;
  #stopTimer: NodeJS.Timeout | null = null;
  #cap = 0;

  // Dictionaries live for the whole trace; each batch sends them in full (they stay small).
  readonly #typeIndex = new Map<string, number>();
  readonly #types: string[] = [];
  readonly #nameIndex = new Map<string, number>();
  readonly #names: string[] = [];
  #promiseType = 0;

  /** asyncId → type index | (name index + 1) << 16. Promises are not stored (see `before`). */
  readonly #resources = new Map<number, number>();
  readonly #own = new Set<number>();

  // Per type index, for the current batch.
  readonly #created: number[] = [];
  readonly #executed: number[] = [];
  readonly #settled: number[] = [];
  readonly #busyUs: number[] = [];

  // Call stack of running callbacks.
  readonly #stackId = new Float64Array(MAX_DEPTH);
  readonly #stackStart = new Float64Array(MAX_DEPTH);
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
    this.#cap = Math.max(1, Math.floor(limits.maxEventsPerFlush));
    this.#evType = new Uint16Array(this.#cap);
    this.#evIteration = new Float64Array(this.#cap);
    this.#evStart = new Float64Array(this.#cap);
    this.#evDuration = new Float64Array(this.#cap);
    this.#evDepth = new Uint8Array(this.#cap);
    this.#evName = new Int32Array(this.#cap);
    this.#promiseType = this.#intern('PROMISE');
    this.#windowStart = this.deps.now();
    this.#depth = 0;

    // An exception inside an async hook kills the process: none may escape. Inline try/catch,
    // not a wrapper closure, so a hook call allocates nothing.
    this.#hook = createHook({
      init: (asyncId, type, _trigger, resource) => {
        try {
          this.#init(asyncId, type, resource);
        } catch (error) {
          this.#fail(error);
        }
      },
      before: (asyncId) => {
        try {
          this.#before(asyncId);
        } catch (error) {
          this.#fail(error);
        }
      },
      after: (asyncId) => {
        try {
          this.#after(asyncId);
        } catch (error) {
          this.#fail(error);
        }
      },
      destroy: (asyncId) => {
        try {
          this.#destroy(asyncId);
        } catch (error) {
          this.#fail(error);
        }
      },
      promiseResolve: () => {
        try {
          this.#bump(this.#settled, this.#promiseType, 1);
        } catch (error) {
          this.#fail(error);
        }
      },
    });
    this.#hook.enable();
    this.#flushTimer = self.own(setInterval(() => self.run(() => this.flush()), limits.flushMs).unref());
    this.#stopTimer = self.own(setTimeout(() => self.run(() => this.stop()), limits.durationMs).unref());
  }

  /** Sends what was collected and keeps tracing. */
  flush(): void {
    if (this.#hook === null) return;
    const started = this.deps.now();
    const events = new Array<number>(this.#count * 6);
    for (let i = 0, o = 0; i < this.#count; i++, o += 6) {
      events[o] = this.#evType[i] as number;
      events[o + 1] = this.#evIteration[i] as number;
      events[o + 2] = Math.round(((this.#evStart[i] as number) - this.#windowStart) * 1000);
      events[o + 3] = Math.round((this.#evDuration[i] as number) * 1000);
      events[o + 4] = this.#evDepth[i] as number;
      events[o + 5] = this.#evName[i] as number;
    }
    const counters: WireLoopTraceCounter[] = [];
    for (let t = 0; t < this.#types.length; t++) {
      const created = this.#created[t] ?? 0;
      const executed = this.#executed[t] ?? 0;
      const settled = this.#settled[t] ?? 0;
      if (created === 0 && executed === 0 && settled === 0) continue;
      counters.push({ resource: this.#types[t] as string, created, executed, settled, busyUs: Math.round(this.#busyUs[t] ?? 0) });
    }
    this.deps.send({
      type: 'loop-trace',
      start: this.deps.timeOrigin + this.#windowStart,
      end: this.deps.timeOrigin + started,
      types: this.#types,
      names: this.#names,
      events,
      counters,
      dropped: this.#dropped,
    });
    this.#created.fill(0);
    this.#executed.fill(0);
    this.#settled.fill(0);
    this.#busyUs.fill(0);
    this.#count = 0;
    this.#dropped = 0;
    this.#windowStart = started;
    this.deps.addOverhead((this.deps.now() - started) * 1000);
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
    this.#resources.clear();
    this.#own.clear();
    this.#depth = 0;
  }

  #fail(error: unknown): void {
    this.#teardown();
    this.deps.self.report(error);
  }

  #intern(type: string): number {
    let index = this.#typeIndex.get(type);
    if (index === undefined) {
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

  #init(asyncId: number, type: string, resource: object): void {
    if (this.deps.self.active || this.deps.self.resources.has(resource)) {
      this.#own.add(asyncId);
      return;
    }
    const typeIndex = this.#intern(type);
    this.#bump(this.#created, typeIndex, 1);
    // Promises are the bulk of async resources: no per-id entry, `before` recognises them.
    if (typeIndex === this.#promiseType) return;
    const nameIndex = this.#internName(callbackName(type, resource));
    this.#resources.set(asyncId, typeIndex | ((nameIndex + 1) << 16));
  }

  #before(asyncId: number): void {
    const d = this.#depth++;
    if (d >= MAX_DEPTH) return;
    this.#stackId[d] = asyncId;
    if (this.#own.has(asyncId)) {
      this.#stackSkip[d] = 1;
      return;
    }
    let info = this.#resources.get(asyncId);
    if (info === undefined) {
      // A promise, or a resource created before tracing started (a `setInterval` keeps its
      // async id across runs, so a long-lived interval never passes through `init`).
      const resource = executionAsyncResource();
      if (this.deps.self.resources.has(resource)) {
        this.#stackSkip[d] = 1;
        return;
      }
      const type = untrackedType(resource);
      const typeIndex = this.#intern(type);
      info = typeIndex | ((this.#internName(callbackName(type, resource)) + 1) << 16);
      if (typeIndex !== this.#promiseType) this.#resources.set(asyncId, info);
    }
    this.#stackSkip[d] = 0;
    this.#stackInfo[d] = info;
    this.#stackIteration[d] = d === 0 ? this.deps.loopCount() : (this.#stackIteration[d - 1] as number);
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
    const duration = this.deps.now() - start;
    const info = this.#stackInfo[d] as number;
    const typeIndex = info & 0xffff;
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
    this.#evName[i] = (info >>> 16) - 1;
  }

  #destroy(asyncId: number): void {
    if (this.#own.delete(asyncId)) return;
    const info = this.#resources.get(asyncId);
    if (info === undefined) return;
    this.#resources.delete(asyncId);
    this.#bump(this.#settled, info & 0xffff, 1);
  }
}
