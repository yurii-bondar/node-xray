// File system and DNS timings. DNS: Node's own `dns` performance entries (no patching, always on).
// File system: Node publishes nothing, so `fs` timing wraps the module's functions; it is opt-in
// (a command) and every wrapper hands the call through unchanged except for the timing.

import fsModule from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { performance, PerformanceObserver, type PerformanceEntry } from 'node:perf_hooks';
import { bucketOf, HTTP_BUCKET_COUNT, type IoExample, type IoMessage, type IoOperation, type IoSide } from '@node-xray/core';
import type { SelfWork } from './self.js';

const MAX_OPERATIONS = 100;
const EXAMPLES = 5;

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
   * Sync calls in progress. `readFileSync` calls `openSync`, `readSync`, `closeSync` through the
   * module's exports: only the outermost call is timed, or the blocked time is counted twice.
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

export function wrapCallback(operation: string, original: AnyFunction, timer: Timer): AnyFunction {
  return lookAlike(function timed(this: unknown, ...args: unknown[]): unknown {
    const last = args.length - 1;
    const callback = args[last];
    if (!timer.enabled() || timer.self.active || typeof callback !== 'function') return original.apply(this, args);
    const key = operationKey(operation, args[0]);
    const start = performance.now();
    args[last] = function (this: unknown, error: unknown, ...rest: unknown[]): unknown {
      timer.record(key, performance.now() - start, error !== null && error !== undefined);
      return (callback as AnyFunction).call(this, error, ...rest);
    };
    return original.apply(this, args);
  }, original);
}

/**
 * Returns a promise derived from the original: subscribing to the original itself would mark it
 * handled and silence the application's own unhandled rejections.
 */
export function wrapPromise(operation: string, original: AnyFunction, timer: Timer): AnyFunction {
  return lookAlike(function timed(this: unknown, ...args: unknown[]): unknown {
    if (!timer.enabled() || timer.self.active) return original.apply(this, args);
    const key = operationKey(operation, args[0]);
    const start = performance.now();
    const result = original.apply(this, args);
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
    timer.nesting.depth++;
    try {
      const value = original.apply(this, args);
      failed = false;
      return value;
    } finally {
      timer.nesting.depth--;
      timer.record(key, performance.now() - start, failed);
    }
  }, original);
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
  readonly addOverhead: (us: number) => void;
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

  /** Wraps the `fs` functions once; later starts and stops only switch the timing on and off. */
  startFs(): void {
    this.#fsOn = true;
    if (this.#patches.length > 0) return;
    // The object `require('fs')` returns to the application: what it calls through.
    const fs = fsModule as unknown as Record<string, unknown>;
    const promises = fs['promises'] as Record<string, unknown>;
    const nesting = { depth: 0 };
    const timer = (aggregator: IoAggregator): Timer => ({
      self: this.deps.self,
      nesting,
      enabled: () => this.#fsOn,
      record: (key, ms, failed) => {
        this.#active = true;
        aggregator.record(key, ms, failed);
      },
    });
    const patch = (target: Record<string, unknown>, name: string, wrap: (original: AnyFunction) => AnyFunction): void => {
      const original = target[name];
      if (typeof original !== 'function') return;
      const wrapper = wrap(original as AnyFunction);
      target[name] = wrapper;
      this.#patches.push({ target, name, original, wrapper });
    };
    for (const operation of FS_OPERATIONS) {
      patch(fs, operation, (original) => wrapCallback(operation, original, timer(this.fs)));
      patch(promises, operation, (original) => wrapPromise(operation, original, timer(this.fs)));
      patch(fs, `${operation}Sync`, (original) => wrapSync(operation, original, timer(this.fsSync)));
    }
    patch(fs, 'existsSync', (original) => wrapSync('exists', original, timer(this.fsSync)));
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
    this.deps.addOverhead((this.deps.now() - started) * 1000);
  }

  #recordDns(entry: PerformanceEntry): void {
    const detail: unknown = Reflect.get(entry, 'detail');
    const host = typeof detail === 'object' && detail !== null ? Reflect.get(detail, 'hostname') ?? Reflect.get(detail, 'host') : undefined;
    const addresses = typeof detail === 'object' && detail !== null ? Reflect.get(detail, 'addresses') ?? Reflect.get(detail, 'result') : undefined;
    const failed = Array.isArray(addresses) ? addresses.length === 0 : false;
    this.#active = true;
    this.dns.record(`${entry.name}${typeof host === 'string' ? ` ${host}` : ''}`, entry.duration, failed);
  }
}
