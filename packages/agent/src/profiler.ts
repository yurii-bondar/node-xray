// CPU profiling and allocation sampling through an in-process inspector session:
// no `--inspect`, no open port. One CDP call at a time, in order.

import { Session } from 'node:inspector';
import type { WireProfile } from '@node-xray/core';
import type { SelfWork } from './self.js';

export interface ProfilerDeps {
  readonly self: SelfWork;
  readonly send: (message: WireProfile) => void;
  /** `performance.now()`. */
  readonly now: () => number;
  readonly timeOrigin: number;
  readonly addOverhead: (us: number) => void;
}

export interface CpuOptions {
  readonly samplingIntervalUs: number;
  readonly windowMs: number;
}

export interface HeapOptions {
  readonly samplingIntervalBytes: number;
  readonly windowMs: number;
}

/** `{ profile: ... }` result of `Profiler.stop` / `HeapProfiler.getSamplingProfile`. */
function profileOf(result: unknown): unknown {
  return typeof result === 'object' && result !== null ? Reflect.get(result, 'profile') : undefined;
}

export class InspectorProfiler {
  #session: Session | null = null;
  #queue: Promise<void> = Promise.resolve();
  #cpuTimer: NodeJS.Timeout | null = null;
  #cpuWindowStart = 0;
  #heapTimer: NodeJS.Timeout | null = null;
  #heapStart = 0;

  constructor(private readonly deps: ProfilerDeps) {}

  startCpu(options: CpuOptions): void {
    this.stopCpu();
    this.#enqueue(async () => {
      await this.#post('Profiler.enable');
      await this.#post('Profiler.setSamplingInterval', { interval: options.samplingIntervalUs });
      await this.#post('Profiler.start');
      this.#cpuWindowStart = this.deps.now();
    });
    const { self } = this.deps;
    this.#cpuTimer = self.own(setInterval(() => self.run(() => this.#enqueue(() => this.#cpuWindow(true))), options.windowMs).unref());
  }

  stopCpu(): void {
    if (this.#cpuTimer === null) return;
    clearInterval(this.#cpuTimer);
    this.#cpuTimer = null;
    this.#enqueue(async () => {
      await this.#cpuWindow(false);
      await this.#post('Profiler.disable');
    });
  }

  startHeap(options: HeapOptions): void {
    this.stopHeap();
    this.#enqueue(async () => {
      await this.#post('HeapProfiler.enable');
      await this.#post('HeapProfiler.startSampling', { samplingInterval: options.samplingIntervalBytes });
      this.#heapStart = this.deps.now();
    });
    const { self } = this.deps;
    this.#heapTimer = self.own(setInterval(() => self.run(() => this.#enqueue(() => this.#heapWindow())), options.windowMs).unref());
  }

  stopHeap(): void {
    if (this.#heapTimer === null) return;
    clearInterval(this.#heapTimer);
    this.#heapTimer = null;
    this.#enqueue(async () => {
      await this.#heapWindow();
      await this.#post('HeapProfiler.stopSampling');
    });
  }

  stopAll(): void {
    this.stopCpu();
    this.stopHeap();
    this.#enqueue(async () => {
      this.#session?.disconnect();
      this.#session = null;
    });
  }

  /**
   * On process exit: send the window in progress, or a program shorter than one window
   * would leave no profile at all. An in-process session answers synchronously, so the
   * callbacks run before `exit` returns.
   */
  flushOnExit(): void {
    const session = this.#session;
    if (session === null) return;
    const now = this.deps.now();
    // Marked stopped first, so the shutdown that follows does not queue a second stop.
    if (this.#cpuTimer !== null) {
      clearInterval(this.#cpuTimer);
      this.#cpuTimer = null;
      session.post('Profiler.stop', (error: Error | null, result?: object) => {
        if (error === null) this.deps.send({ type: 'cpu-profile', start: this.deps.timeOrigin + this.#cpuWindowStart, end: this.deps.timeOrigin + now, profile: profileOf(result) });
      });
    }
    if (this.#heapTimer !== null) {
      clearInterval(this.#heapTimer);
      this.#heapTimer = null;
      session.post('HeapProfiler.getSamplingProfile', (error: Error | null, result?: object) => {
        if (error === null) this.deps.send({ type: 'heap-profile', start: this.deps.timeOrigin + this.#heapStart, end: this.deps.timeOrigin + now, profile: profileOf(result) });
      });
    }
  }

  /** Stop + send + restart: one window of the live flame graph. */
  async #cpuWindow(restart: boolean): Promise<void> {
    const started = this.deps.now();
    const profile = profileOf(await this.#post('Profiler.stop'));
    if (restart) await this.#post('Profiler.start');
    const end = this.deps.now();
    this.deps.send({ type: 'cpu-profile', start: this.deps.timeOrigin + this.#cpuWindowStart, end: this.deps.timeOrigin + started, profile });
    this.#cpuWindowStart = end;
    this.deps.addOverhead((this.deps.now() - started) * 1000);
  }

  /** The sampling profile is cumulative since `startSampling`. */
  async #heapWindow(): Promise<void> {
    const started = this.deps.now();
    const profile = profileOf(await this.#post('HeapProfiler.getSamplingProfile'));
    this.deps.send({ type: 'heap-profile', start: this.deps.timeOrigin + this.#heapStart, end: this.deps.timeOrigin + started, profile });
    this.deps.addOverhead((this.deps.now() - started) * 1000);
  }

  #enqueue(step: () => Promise<void>): void {
    this.#queue = this.#queue.then(step).catch((error: unknown) => this.deps.self.report(error));
  }

  #post(method: string, params: object = {}): Promise<unknown> {
    if (this.#session === null) {
      this.#session = new Session();
      this.#session.connect();
    }
    const session = this.#session;
    return new Promise((resolve, reject) => {
      session.post(method, params, (error: Error | null, result?: object) => (error ? reject(error) : resolve(result)));
    });
  }
}
