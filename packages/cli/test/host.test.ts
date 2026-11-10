import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HostProbe, parseIoreg, parseMeminfoSwap, parseNvidiaApps, parseNvidiaGpus, parseSwapusage, type Exec } from '../src/host.js';

const MiB = 1024 * 1024;

const IOREG = `+-o AGXAcceleratorG16X  <class AGXAcceleratorG16X, id 0x1000003f0, registered, matched, active, busy 0 (1 ms), retain 104>
    {
      "model" = "Apple M4 Pro"
      "PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=5966249984,"Tiler Utilization %"=8,"Renderer Utilization %"=25,"Device Utilization %"=56,"In use system memory"=1384710144}
      "IOClass" = "AGXAcceleratorG16X"
    }
`;

describe('swap parsers', () => {
  it('reads /proc/meminfo', () => {
    assert.deepEqual(parseMeminfoSwap('MemTotal:  16000000 kB\nSwapTotal:  2097148 kB\nSwapFree:   1048576 kB\n'), {
      total: 2097148 * 1024,
      used: (2097148 - 1048576) * 1024,
    });
    assert.equal(parseMeminfoSwap('MemTotal: 1 kB\n'), null);
  });

  it('reads macOS vm.swapusage', () => {
    assert.deepEqual(parseSwapusage('total = 2048.00M  used = 1024.25M  free = 1023.75M  (encrypted)'), { total: 2048 * MiB, used: 1024.25 * MiB });
    assert.deepEqual(parseSwapusage('total = 12.00G  used = 10.54G  free = 1.46G'), { total: 12 * 1024 * MiB, used: 10.54 * 1024 * MiB });
    assert.equal(parseSwapusage('nothing'), null);
  });
});

describe('GPU parsers', () => {
  it('reads nvidia-smi GPUs and per-process memory, N/A as null', () => {
    assert.deepEqual(parseNvidiaGpus('0, GPU-aaa, NVIDIA GeForce RTX 4090, 37, 2048, 24564\n1, GPU-bbb, Tesla T4, [N/A], 0, 15360\n'), [
      { index: 0, uuid: 'GPU-aaa', name: 'NVIDIA GeForce RTX 4090', utilization: 0.37, memoryUsed: 2048 * MiB, memoryTotal: 24564 * MiB },
      { index: 1, uuid: 'GPU-bbb', name: 'Tesla T4', utilization: null, memoryUsed: 0, memoryTotal: 15360 * MiB },
    ]);
    assert.deepEqual(parseNvidiaApps('GPU-aaa, 4242, 512\n'), [{ uuid: 'GPU-aaa', pid: 4242, memory: 512 * MiB }]);
  });

  it('reads ioreg accelerator statistics', () => {
    assert.deepEqual(parseIoreg(IOREG), [
      { index: 0, name: 'Apple M4 Pro', utilization: 0.56, memoryUsed: 1384710144, memoryTotal: null, processMemory: null },
    ]);
    assert.deepEqual(parseIoreg(''), []);
  });
});

describe('HostProbe', () => {
  it('attributes GPU memory to the target pids on NVIDIA', async () => {
    const exec: Exec = async (_file, args) =>
      args[0]?.startsWith('--query-gpu') ? '0, GPU-aaa, RTX, 50, 1000, 8000\n' : 'GPU-aaa, 4242, 300\nGPU-aaa, 9999, 200\n';
    const probe = new HostProbe({ exec, readText: async () => 'SwapTotal: 0 kB\nSwapFree: 0 kB\n', platform: 'linux', now: () => 7 });
    const sample = await probe.sample(new Set([4242]));
    assert.deepEqual(sample, {
      type: 'host',
      t: 7,
      swap: { total: 0, used: 0 },
      gpus: [{ index: 0, name: 'RTX', utilization: 0.5, memoryUsed: 1000 * MiB, memoryTotal: 8000 * MiB, processMemory: 300 * MiB }],
    });
  });

  it('stops asking for a tool that is not there', async () => {
    const calls: string[] = [];
    const exec: Exec = async (file) => {
      calls.push(file);
      throw new Error('spawn nvidia-smi ENOENT');
    };
    const probe = new HostProbe({ exec, readText: async () => '', platform: 'linux', now: () => 0 });
    assert.deepEqual((await probe.sample(new Set())).gpus, []);
    assert.deepEqual((await probe.sample(new Set())).gpus, []);
    assert.deepEqual(calls, ['nvidia-smi']);
  });

  it('reports no swap where there is no source for it', async () => {
    const probe = new HostProbe({ exec: async () => '', readText: async () => '', platform: 'win32', now: () => 0 });
    assert.equal((await probe.sample(new Set())).swap, null);
  });
});
