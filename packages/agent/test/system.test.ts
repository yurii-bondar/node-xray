import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { memoryLimit, parseVmSwap } from '../src/system.js';

describe('parseVmSwap', () => {
  it('reads VmSwap in bytes', () => {
    assert.equal(parseVmSwap('Name:\tnode\nVmRSS:\t  51200 kB\nVmSwap:\t    2048 kB\nThreads:\t7\n'), 2048 * 1024);
    assert.equal(parseVmSwap('Name:\tnode\n'), null);
  });
});

describe('memoryLimit', () => {
  it('keeps only real cgroup limits', () => {
    const ram = 16 * 1024 ** 3;
    assert.equal(memoryLimit(512 * 1024 ** 2, ram), 512 * 1024 ** 2);
    assert.equal(memoryLimit(0, ram), null);
    assert.equal(memoryLimit(undefined, ram), null);
    assert.equal(memoryLimit(2 ** 63, ram), null);
  });
});
