import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deriveFrame } from '../src/frame.js';
import { hello, MiB, sample } from './fixtures.js';

describe('deriveFrame', () => {
  const prev = sample(1000, {
    cpu: { user: 1_000_000, system: 200_000 },
    loop: { idle: 5000, active: 1000 },
    uv: { loopCount: 100, events: 1000 },
    rusage: { maxRss: 0, minorFaults: 100, majorFaults: 5, voluntarySwitches: 0, involuntarySwitches: 0, fsReads: 0, fsWrites: 0 },
  });

  it('derives CPU, loop utilization, rates and memory share', () => {
    const cur = sample(1500, {
      cpu: { user: 1_250_000, system: 250_000 },
      loop: { idle: 5100, active: 1400 },
      uv: { loopCount: 150, events: 1600 },
      rusage: { maxRss: 0, minorFaults: 300, majorFaults: 15, voluntarySwitches: 0, involuntarySwitches: 0, fsReads: 0, fsWrites: 0 },
      system: { free: 0, available: null, limit: 1024 * MiB, processSwap: 4 * MiB, loadAvg1: 2 },
      overheadUs: 2500,
    });
    const frame = deriveFrame({ prev, cur, facts: hello });
    assert.ok(frame);
    assert.equal(frame.dt, 500);
    assert.deepEqual(frame.cpu, { user: 50, system: 10, total: 60, ofMachine: 15 });
    assert.equal(frame.loop.utilization, 0.8);
    assert.equal(frame.loop.iterationsPerSec, 100);
    assert.equal(frame.loop.eventsPerSec, 1200);
    assert.equal(frame.os.minorFaultsPerSec, 400);
    assert.equal(frame.os.majorFaultsPerSec, 20);
    assert.equal(frame.os.memoryLimit, 1024 * MiB, 'cgroup limit wins over machine RAM');
    assert.equal(frame.os.memoryShare, 100 / 1024);
    assert.equal(frame.os.processSwap, 4 * MiB);
    assert.equal(frame.overhead, 0.5);
  });

  it('aggregates GC pauses of the frame by kind', () => {
    const cur = sample(2000, {
      gc: [
        { start: 1100, duration: 2, kind: 'minor' },
        { start: 1300, duration: 3, kind: 'minor' },
        { start: 1600, duration: 45, kind: 'major' },
      ],
    });
    const frame = deriveFrame({ prev, cur, facts: hello });
    assert.ok(frame);
    assert.equal(frame.gc.count, 3);
    assert.equal(frame.gc.pause, 50);
    assert.equal(frame.gc.maxPause, 45);
    assert.equal(frame.gc.pauseRatio, 0.05);
    assert.deepEqual(frame.gc.byKind.minor, { count: 2, pause: 5 });
    assert.deepEqual(frame.gc.byKind.major, { count: 1, pause: 45 });
    assert.deepEqual(frame.gc.byKind.incremental, { count: 0, pause: 0 });
  });

  it('falls back to machine RAM and reports unknown loop counts as null', () => {
    const frame = deriveFrame({ prev: sample(0), cur: sample(1000), facts: hello });
    assert.ok(frame);
    assert.equal(frame.os.memoryLimit, hello.totalMemory);
    assert.equal(frame.loop.iterationsPerSec, null);
    assert.equal(frame.loop.utilization, 0);
  });

  it('skips samples that do not move time forward', () => {
    assert.equal(deriveFrame({ prev: sample(1000), cur: sample(1000), facts: hello }), null);
  });
});
