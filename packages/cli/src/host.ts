// Machine-level facts the agent cannot see from inside the process: system swap and GPUs.
// Each tool is tried once; a missing one (no NVIDIA driver, no ioreg) is never retried.

import type { Gpu, HostSample } from '@node-xray/core';

export type Exec = (file: string, args: readonly string[]) => Promise<string>;
export type ReadText = (path: string) => Promise<string>;

export interface Swap {
  readonly total: number;
  readonly used: number;
}

const KIB = 1024;
const MIB = 1024 * 1024;

/** `/proc/meminfo` → swap in bytes. */
export function parseMeminfoSwap(text: string): Swap | null {
  const total = /^SwapTotal:\s+(\d+)\s+kB$/m.exec(text)?.[1];
  const free = /^SwapFree:\s+(\d+)\s+kB$/m.exec(text)?.[1];
  if (total === undefined || free === undefined) return null;
  return { total: Number(total) * KIB, used: (Number(total) - Number(free)) * KIB };
}

const SIZE_UNITS: Readonly<Record<string, number>> = { K: KIB, M: MIB, G: 1024 * MIB };

/** macOS `sysctl -n vm.swapusage`: `total = 2048.00M  used = 1024.25M  free = 1023.75M  (encrypted)`. */
export function parseSwapusage(text: string): Swap | null {
  const size = (key: string): number | null => {
    const match = new RegExp(`${key} = (\\d+(?:\\.\\d+)?)([KMG])`).exec(text);
    if (match?.[1] === undefined || match[2] === undefined) return null;
    return Number(match[1]) * (SIZE_UNITS[match[2]] ?? 1);
  };
  const total = size('total');
  const used = size('used');
  return total === null || used === null ? null : { total, used };
}

function csvRows(text: string): string[][] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(',').map((cell) => cell.trim()));
}

/** A number, or `null` for `[N/A]` / `[Not Supported]`. */
function cell(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return value === '' || Number.isNaN(n) ? null : n;
}

export interface NvidiaGpu {
  readonly index: number;
  readonly uuid: string;
  readonly name: string;
  readonly utilization: number | null;
  readonly memoryUsed: number;
  readonly memoryTotal: number | null;
}

/** `nvidia-smi --query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits` */
export function parseNvidiaGpus(text: string): NvidiaGpu[] {
  const out: NvidiaGpu[] = [];
  for (const [index, uuid, name, utilization, used, total] of csvRows(text)) {
    const i = cell(index);
    if (i === null || uuid === undefined || name === undefined) continue;
    const util = cell(utilization);
    const memoryTotal = cell(total);
    out.push({
      index: i,
      uuid,
      name,
      utilization: util === null ? null : util / 100,
      memoryUsed: (cell(used) ?? 0) * MIB,
      memoryTotal: memoryTotal === null ? null : memoryTotal * MIB,
    });
  }
  return out;
}

export interface NvidiaApp {
  readonly uuid: string;
  readonly pid: number;
  readonly memory: number;
}

/** `nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory --format=csv,noheader,nounits` */
export function parseNvidiaApps(text: string): NvidiaApp[] {
  const out: NvidiaApp[] = [];
  for (const [uuid, pid, memory] of csvRows(text)) {
    const p = cell(pid);
    if (uuid === undefined || p === null) continue;
    out.push({ uuid, pid: p, memory: (cell(memory) ?? 0) * MIB });
  }
  return out;
}

/** macOS `ioreg -r -d 1 -w 0 -c IOAccelerator`: one block per GPU. Unified memory: no total. */
export function parseIoreg(text: string): Gpu[] {
  const out: Gpu[] = [];
  for (const block of text.split(/^\+-o /m)) {
    const stats = /"PerformanceStatistics" = \{([^}]*)\}/.exec(block)?.[1];
    if (stats === undefined) continue;
    const utilization = cell(/"Device Utilization %"=(\d+)/.exec(stats)?.[1]);
    out.push({
      index: out.length,
      name: /"model" = "([^"]+)"/.exec(block)?.[1] ?? 'GPU',
      utilization: utilization === null ? null : utilization / 100,
      memoryUsed: cell(/"In use system memory"=(\d+)/.exec(stats)?.[1]) ?? 0,
      memoryTotal: null,
      processMemory: null,
    });
  }
  return out;
}

export interface HostProbeDeps {
  readonly exec: Exec;
  readonly readText: ReadText;
  readonly platform: NodeJS.Platform;
  readonly now: () => number;
}

type GpuTool = 'nvidia' | 'ioreg' | 'none';

export class HostProbe {
  #gpuTool: GpuTool;
  #swapWorks = true;

  constructor(private readonly deps: HostProbeDeps) {
    this.#gpuTool = deps.platform === 'darwin' ? 'ioreg' : 'nvidia';
  }

  /** `pids`: the target processes, for per-process GPU memory. */
  async sample(pids: ReadonlySet<number>): Promise<HostSample> {
    const [swap, gpus] = await Promise.all([this.#swap(), this.#gpus(pids)]);
    return { type: 'host', t: this.deps.now(), swap, gpus };
  }

  async #swap(): Promise<Swap | null> {
    if (!this.#swapWorks) return null;
    try {
      switch (this.deps.platform) {
        case 'linux':
          return parseMeminfoSwap(await this.deps.readText('/proc/meminfo'));
        case 'darwin':
          return parseSwapusage(await this.deps.exec('sysctl', ['-n', 'vm.swapusage']));
        default:
          this.#swapWorks = false;
          return null;
      }
    } catch {
      this.#swapWorks = false;
      return null;
    }
  }

  async #gpus(pids: ReadonlySet<number>): Promise<Gpu[]> {
    try {
      switch (this.#gpuTool) {
        case 'nvidia':
          return await this.#nvidia(pids);
        case 'ioreg':
          return parseIoreg(await this.deps.exec('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']));
        case 'none':
          return [];
        default: {
          const unreachable: never = this.#gpuTool;
          return unreachable;
        }
      }
    } catch {
      this.#gpuTool = 'none';
      return [];
    }
  }

  async #nvidia(pids: ReadonlySet<number>): Promise<Gpu[]> {
    const gpus = parseNvidiaGpus(
      await this.deps.exec('nvidia-smi', ['--query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits']),
    );
    let apps: NvidiaApp[] | null = null;
    try {
      apps = parseNvidiaApps(await this.deps.exec('nvidia-smi', ['--query-compute-apps=gpu_uuid,pid,used_memory', '--format=csv,noheader,nounits']));
    } catch {
      apps = null;
    }
    return gpus.map((gpu) => {
      let processMemory: number | null = null;
      if (apps !== null) {
        processMemory = 0;
        for (const app of apps) if (app.uuid === gpu.uuid && pids.has(app.pid)) processMemory += app.memory;
      }
      return { index: gpu.index, name: gpu.name, utilization: gpu.utilization, memoryUsed: gpu.memoryUsed, memoryTotal: gpu.memoryTotal, processMemory };
    });
  }
}
