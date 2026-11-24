// File system and DNS timings. DNS: Node's own `dns` performance entries (no patching, always on).
// Node writes an entry only for a lookup that succeeded, so failed lookups are not seen at all
// (`dns.errors` stays 0; nothing compatible publishes them without patching `dns`).
// File system: Node publishes nothing, so `fs` timing wraps the module's functions; it is opt-in
// (a command) and every wrapper hands the call through unchanged except for the timing.

import fsModule from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { performance, PerformanceObserver, type PerformanceEntry } from 'node:perf_hooks';
import { bucketOf, HTTP_BUCKET_COUNT, type IoExample, type IoMessage, type IoOperation, type IoSide } from '@node-xray/core';
import { SelfWork } from './self.js';

const MAX_OPERATIONS = 100;
const EXAMPLES = 5;
const CALIBRATION_CALLS = 500;
const MAX_WRAPPER_COST_US = 20;

/** One kind of call (async fs, sync fs, DNS) for one tick. */
export class IoAggregator {
  #calls = 0;
  #errors = 0;
  #totalMs = 0;
  #maxMs = 0;
  #histogram = new Array<number>(HTTP_BUCKET_COUNT).fill(0);
  #operations = new Map<string, { count: number; errors: number; totalMs: number; maxMs: number }>();
  #slowest: IoExample[] = [];

  record(key: string, ms: number, failed: boolean): void {
    this.#calls++;
    if (failed) this.#errors++;
    this.#totalMs += ms;
    if (ms > this.#maxMs) this.#maxMs = ms;
    const bucket = bucketOf(ms);
    this.#histogram[bucket] = (this.#histogram[bucket] ?? 0) + 1;
    let op = this.#operations.get(key);
    if (op === undefined) {
      const slot = this.#operations.size < MAX_OPERATIONS ? key : '(other)';
      op = this.#operations.get(slot) ?? { count: 0, errors: 0, totalMs: 0, maxMs: 0 };
      this.#operations.set(slot, op);
    }
    op.count++;
    if (failed) op.errors++;
    op.totalMs += ms;
    if (ms > op.maxMs) op.maxMs = ms;
    if (this.#slowest.length < EXAMPLES || ms > (this.#slowest[this.#slowest.length - 1] as IoExample).ms) {
      this.#slowest.push({ key, ms, failed });
      this.#slowest.sort((a, b) => b.ms - a.ms);
      if (this.#slowest.length > EXAMPLES) this.#slowest.pop();
    }
  }

  get active(): boolean {
    return this.#calls > 0;
  }

  /** The tick's numbers; starts over. */
  snapshot(): IoSide {
    const operations: IoOperation[] = [];
    for (const [key, op] of this.#operations) operations.push({ key, ...op });
    const side: IoSide = { calls: this.#calls, errors: this.#errors, totalMs: this.#totalMs, maxMs: this.#maxMs, histogram: this.#histogram, operations, slowest: this.#slowest };
    this.#calls = 0;
    this.#errors = 0;
    this.#totalMs = 0;
    this.#maxMs = 0;
    this.#histogram = new Array<number>(HTTP_BUCKET_COUNT).fill(0);
    this.#operations = new Map();
    this.#slowest = [];
    return side;
  }
}

/** Callback/promise APIs with a path (or fd) first argument; `exists` is left out (its callback has no error). */
export const FS_OPERATIONS: readonly string[] = [
  'access', 'appendFile', 'chmod', 'chown', 'close', 'copyFile', 'cp', 'fstat', 'fsync', 'lstat', 'mkdir', 'mkdtemp', 'open', 'opendir',
  'read', 'readdir', 'readFile', 'readlink', 'realpath', 'rename', 'rm', 'rmdir', 'stat', 'statfs', 'symlink', 'truncate', 'unlink',
  'utimes', 'write', 'writeFile',
];

/** `readFile /srv/a.json`, `read (fd)`: what the call worked on. */
export function operationKey(operation: string, first: unknown): string {
  if (typeof first === 'number') return `${operation} (fd)`;
  if (typeof first === 'string') return `${operation} ${first}`;
  if (first instanceof URL) return `${operation} ${first.pathname}`;
  if (Buffer.isBuffer(first)) return `${operation} ${first.toString()}`;
  return operation;
}

type AnyFunction = (this: unknown, ...args: unknown[]) => unknown;

interface Timer {
  readonly self: SelfWork;
  readonly enabled: () => boolean;
  readonly record: (key: string, ms: number, failed: boolean) => void;
  /**
   * Above 0 while Node is working on a timed fs call. Node builds some calls from others through
   * the module's exports (`readFileSync` → `openSync`, `readSync`, `closeSync`; `appendFile` →
   * `writeFile` → `open`, `write`, `close`, each from the previous one's callback): only the
   * outermost call is timed, or the same time is counted several times. Set while the outer
   * call's original runs and while the callbacks of its inner calls run; 0 again while the
   * application's own callback runs, so its next fs calls are timed. A promise API's inner calls
   * after its first `await` cannot be told apart (`fs.promises.rm`, `cp`).
   */
  readonly nesting: { depth: number };
}

/** Same name, length and own properties (util.promisify.custom and friends) as the original. */
function lookAlike<F extends AnyFunction>(wrapper: F, original: AnyFunction): F {
  for (const key of Reflect.ownKeys(original)) {
    if (key === 'prototype') continue;
    const descriptor = Object.getOwnPropertyDescriptor(original, key);
    if (descriptor !== undefined) Object.defineProperty(wrapper, key, descriptor);
  }
  return wrapper;
}

/** `original.apply(self, args)` marked as part of a timed fs call. */
function nested(nesting: { depth: number }, original: AnyFunction, self: unknown, args: unknown[]): unknown {
  nesting.depth++;
  try {
    return original.apply(self, args);
  } finally {
    nesting.depth--;
  }
}

export function wrapCallback(operation: string, original: AnyFunction, timer: Timer): AnyFunction {
  const { nesting } = timer;
  return lookAlike(function timed(this: unknown, ...args: unknown[]): unknown {
    const last = args.length - 1;
    const callback = args[last];
    if (typeof callback !== 'function') return original.apply(this, args);
    if (nesting.depth > 0) {
      // A part of a timed call: its callback carries that call on, so it runs marked too.
      args[last] = function (this: unknown, ...results: unknown[]): unknown {
        return nested(nesting, callback as AnyFunction, this, results);
      };
      return original.apply(this, args);
    }
    if (!timer.enabled() || timer.self.active) return original.apply(this, args);
    const key = operationKey(operation, args[0]);
    const start = performance.now();
    args[last] = function (this: unknown, error: unknown, ...rest: unknown[]): unknown {
      timer.record(key, performance.now() - start, error !== null && error !== undefined);
      // The application's own callback: the fs calls it makes are timed on their own.
      const depth = nesting.depth;
      nesting.depth = 0;
      try {
        return (callback as AnyFunction).call(this, error, ...rest);
      } finally {
        nesting.depth = depth;
      }
    };
    return nested(nesting, original, this, args);
  }, original);
}

/**
 * Returns a promise derived from the original: subscribing to the original itself would mark it
 * handled and silence the application's own unhandled rejections.
 */
export function wrapPromise(operation: string, original: AnyFunction, timer: Timer): AnyFunction {
  const { nesting } = timer;
  return lookAlike(function timed(this: unknown, ...args: unknown[]): unknown {
    if (nesting.depth > 0 || !timer.enabled() || timer.self.active) return original.apply(this, args);
    const key = operationKey(operation, args[0]);
    const start = performance.now();
    const result = nested(nesting, original, this, args);
    if (!(result instanceof Promise)) return result;
    return result.then(
      (value: unknown) => {
        timer.record(key, performance.now() - start, false);
        return value;
      },
      (error: unknown) => {
        timer.record(key, performance.now() - start, true);
        throw error;
      },
    );
  }, original);
}

export function wrapSync(operation: string, original: AnyFunction, timer: Timer): AnyFunction {
  return lookAlike(function timed(this: unknown, ...args: unknown[]): unknown {
    if (!timer.enabled() || timer.self.active || timer.nesting.depth > 0) return original.apply(this, args);
    const key = operationKey(`${operation}Sync`, args[0]);
    const start = performance.now();
    let failed = true;
    try {
      const value = nested(timer.nesting, original, this, args);
      failed = false;
      return value;
    } finally {
      timer.record(key, performance.now() - start, failed);
    }
  }, original);
}

/**
 * Main-thread cost of one timed fs call, µs: a wrapped call of an instant function against the
 * function itself. Timing every call would add clock reads to each; this cost times the number
 * of calls is the wrappers' share of the agent's overhead.
 */
export function measureWrapperCost(now: () => number): number {
  const original: AnyFunction = (_path: unknown, callback: unknown) => (callback as AnyFunction)(null);
  const scratch = new IoAggregator();
  const wrapped = wrapCallback('stat', original, {
    self: new SelfWork(() => undefined),
    enabled: () => true,
    record: (key, ms, failed) => scratch.record(key, ms, failed),
    nesting: { depth: 0 },
  });
  const done = (): void => undefined;
  const burst = (fn: AnyFunction): number => {
    const started = now();
    for (let i = 0; i < CALIBRATION_CALLS; i++) fn('/calibrate', done);
    return now() - started;
  };
  burst(original);
  burst(wrapped);
  const plain = burst(original);
  const timed = burst(wrapped);
  return Math.min(MAX_WRAPPER_COST_US, Math.max(0, ((timed - plain) * 1000) / CALIBRATION_CALLS));
}

interface Patch {
  readonly target: object;
  readonly name: string;
  readonly original: unknown;
  readonly wrapper: unknown;
}

export interface IoMonitorDeps {
  readonly self: SelfWork;
  readonly send: (message: IoMessage) => void;
  readonly now: () => number;
  readonly timeOrigin: number;
  readonly intervalMs: number;
}

export class IoMonitor {
  readonly fs = new IoAggregator();
  readonly fsSync = new IoAggregator();
  readonly dns = new IoAggregator();
  #observer: PerformanceObserver | null = null;
  #timer: NodeJS.Timeout | null = null;
  #lastTick = 0;
  #fsOn = false;
  #patches: Patch[] = [];
  /** Shared by every wrapper: Node's inner calls cross callback, promise and sync APIs. */
  readonly #nesting = { depth: 0 };
  /** µs per timed fs call, measured when fs timing first starts. */
  #wrapperCostUs = -1;
  /** Nothing is sent until the process did any DNS or timed fs: no empty ticks. */
  #active = false;

  constructor(private readonly deps: IoMonitorDeps) {}

  start(): void {
    const { self } = this.deps;
    this.#observer = new PerformanceObserver((list) =>
      self.run(() => {
        for (const entry of list.getEntries()) this.#recordDns(entry);
      }),
    );
    this.#observer.observe({ entryTypes: ['dns'] });
    this.#lastTick = this.deps.now();
    this.#timer = self.own(setInterval(() => self.run(() => this.tick()), this.deps.intervalMs).unref());
  }

  /**
   * Wraps every `fs` function not wrapped yet. A wrapper someone else wrapped on top stays in
   * place across `stopFs` (only switched off), so a restart wraps just the ones put back.
   */
  startFs(): void {
    this.#fsOn = true;
    if (this.#wrapperCostUs < 0) this.#wrapperCostUs = measureWrapperCost(this.deps.now);
    // The object `require('fs')` returns to the application: what it calls through.
    const fs = fsModule as unknown as Record<string, unknown>;
    const promises = fs['promises'] as Record<string, unknown>;
    const timer = (aggregator: IoAggregator): Timer => ({
      self: this.deps.self,
      nesting: this.#nesting,
      enabled: () => this.#fsOn,
      record: (key, ms, failed) => {
        this.#active = true;
        aggregator.record(key, ms, failed);
        this.deps.self.addOverhead(this.#wrapperCostUs);
      },
    });
    const patch = (target: Record<string, unknown>, name: string, wrap: (original: AnyFunction) => AnyFunction): void => {
      if (this.#patches.some((p) => p.target === target && p.name === name)) return;
      const original = target[name];
      if (typeof original !== 'function') return;
      const wrapper = wrap(original as AnyFunction);
      target[name] = wrapper;
      this.#patches.push({ target, name, original, wrapper });
    };
    const asyncTimer = timer(this.fs);
    const syncTimer = timer(this.fsSync);
    for (const operation of FS_OPERATIONS) {
      patch(fs, operation, (original) => wrapCallback(operation, original, asyncTimer));
      patch(promises, operation, (original) => wrapPromise(operation, original, asyncTimer));
      patch(fs, `${operation}Sync`, (original) => wrapSync(operation, original, syncTimer));
    }
    patch(fs, 'existsSync', (original) => wrapSync('exists', original, syncTimer));
    // `import { readFile } from 'node:fs'` sees the wrappers too.
    syncBuiltinESMExports();
  }

  /** Puts the originals back where nobody wrapped on top of the wrappers; otherwise just stops timing. */
  stopFs(): void {
    this.#fsOn = false;
    const kept: Patch[] = [];
    for (const p of this.#patches) {
      if (Reflect.get(p.target, p.name) === p.wrapper) Reflect.set(p.target, p.name, p.original);
      else kept.push(p);
    }
    this.#patches = kept;
    syncBuiltinESMExports();
  }

  stop(): void {
    this.stopFs();
    this.#observer?.disconnect();
    this.#observer = null;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  tick(): void {
    if (!this.#active) return;
    const started = this.deps.now();
    this.deps.send({
      type: 'io',
      start: this.deps.timeOrigin + this.#lastTick,
      end: this.deps.timeOrigin + started,
      fs: this.fs.snapshot(),
      fsSync: this.fsSync.snapshot(),
      dns: this.dns.snapshot(),
    });
    this.#lastTick = started;
  }

  #recordDns(entry: PerformanceEntry): void {
    const detail: unknown = Reflect.get(entry, 'detail');
    const host = typeof detail === 'object' && detail !== null ? Reflect.get(detail, 'hostname') ?? Reflect.get(detail, 'host') : undefined;
    this.#active = true;
    // Only successful lookups have an entry (see the top of this file).
    this.dns.record(`${entry.name}${typeof host === 'string' ? ` ${host}` : ''}`, entry.duration, false);
  }
}
