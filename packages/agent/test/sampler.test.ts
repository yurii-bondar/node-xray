import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Worker } from 'node:worker_threads';
import { loopCountReader, threadCpu, uvCounters } from '../src/sampler.js';

describe('threadCpu', () => {
  it("counts a worker's own CPU, not the main thread's", async () => {
    const sampler = new URL('../src/sampler.js', import.meta.url).href;
    const worker = new Worker(
      `const { parentPort } = require('node:worker_threads');
      import(${JSON.stringify(sampler)}).then(async ({ threadCpu }) => {
        const before = threadCpu();
        parentPort.postMessage('ready');
        await new Promise((resolve) => setTimeout(resolve, 300));
        const after = threadCpu();
        parentPort.postMessage(after.user + after.system - before.user - before.system);
      });`,
      { eval: true },
    );
    const mainBefore = threadCpu();
    const workerUs = await new Promise<number>((resolve, reject) => {
      worker.on('error', reject);
      worker.on('message', (message: unknown) => {
        if (message === 'ready') {
          const end = Date.now() + 250;
          while (Date.now() < end);
        } else resolve(message as number);
      });
    });
    await worker.terminate();
    const mainAfter = threadCpu();
    assert.ok(mainAfter.user + mainAfter.system - mainBefore.user - mainBefore.system >= 200_000, 'the main thread was busy');
    assert.ok(workerUs < 100_000, `the idle worker reported ${workerUs} µs`);
  });
});

describe('loopCountReader', () => {
  it('reads the loop count when this Node has it, -1 otherwise', () => {
    const read = loopCountReader();
    if (uvCounters() === null) assert.equal(read(), -1);
    else assert.ok(read() >= 0);
  });
});
