// Process-level memory facts that differ by platform.

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import type { SystemMemory } from '@node-xray/core';

/** `VmSwap:     1234 kB` from `/proc/<pid>/status` → bytes; `null` when absent. */
export function parseVmSwap(status: string): number | null {
  const match = /^VmSwap:\s+(\d+)\s+kB$/m.exec(status);
  return match?.[1] === undefined ? null : Number(match[1]) * 1024;
}

/**
 * `process.constrainedMemory()` returns 0 (or, on some versions, a huge number) when no
 * cgroup limit applies; a limit at or above physical RAM constrains nothing either.
 */
export function memoryLimit(constrained: number | undefined, totalMemory: number): number | null {
  if (constrained === undefined || constrained <= 0 || constrained >= totalMemory) return null;
  return constrained;
}

/** Linux only: refreshed in the background, so a tick never waits on the file system. */
export class SwapReader {
  #latest: number | null = null;
  #reading = false;

  constructor(private readonly onError: (error: unknown) => void) {}

  get latest(): number | null {
    return this.#latest;
  }

  refresh(): void {
    if (process.platform !== 'linux' || this.#reading) return;
    this.#reading = true;
    readFile('/proc/self/status', 'utf8').then(
      (status) => {
        this.#latest = parseVmSwap(status);
        this.#reading = false;
      },
      (error: unknown) => {
        this.#reading = false;
        this.onError(error);
      },
    );
  }
}

export function systemMemory(swap: SwapReader): SystemMemory {
  const total = os.totalmem();
  return {
    free: os.freemem(),
    available: typeof process.availableMemory === 'function' ? process.availableMemory() : null,
    limit: memoryLimit(typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : undefined, total),
    processSwap: swap.latest,
    loadAvg1: os.loadavg()[0] ?? 0,
  };
}

export function cpuCount(): number {
  return typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
}
