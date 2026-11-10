import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Frame } from '../src/frame.js';
import { analyze, type Insight } from '../src/insights.js';
import { framesOf, MiB } from './fixtures.js';

function kinds(insights: readonly Insight[]): string[] {
  return insights.map((insight) => insight.kind);
}

/** A sawtooth: allocations climb for 10 s, a GC drops to the floor; the floor moves by `floorStep` per cycle. */
function sawtooth(seconds: number, floorStep: number): Array<{ heapUsed: number }> {
  return Array.from({ length: seconds }, (_, i) => {
    const cycle = Math.floor(i / 10);
    return { heapUsed: 50 * MiB + cycle * floorStep + (i % 10) * 3 * MiB };
  });
}

function withFrame(frames: Frame[], index: number, patch: (frame: Frame) => Frame): Frame[] {
  return frames.map((frame, i) => (i === index ? patch(frame) : frame));
}

describe('analyze', () => {
  it('reports nothing for a healthy process', () => {
    assert.deepEqual(analyze(framesOf(sawtooth(300, 0))), []);
  });

  it('blames a loop stall on GC when the pause covers it, otherwise leaves the cause open', () => {
    let frames = framesOf(sawtooth(3, 0));
    frames = withFrame(frames, 0, (f) => ({ ...f, loop: { ...f.loop, delay: { ...f.loop.delay, max: 180 } }, gc: { ...f.gc, maxPause: 150 } }));
    frames = withFrame(frames, 2, (f) => ({ ...f, loop: { ...f.loop, delay: { ...f.loop.delay, max: 400 } }, gc: { ...f.gc, maxPause: 20 } }));
    const stalls = analyze(frames).filter((i) => i.kind === 'loop-stall');
    assert.deepEqual(
      stalls.map((s) => s.kind === 'loop-stall' && [s.delay, s.cause]),
      [
        [180, 'gc'],
        [400, 'unknown'],
      ],
    );
  });

  it('finds heap growth in the post-GC floor, not in the sawtooth', () => {
    const leaking = analyze(framesOf(sawtooth(300, 2 * MiB)));
    const growth = leaking.find((i) => i.kind === 'heap-growth');
    assert.ok(growth && growth.kind === 'heap-growth');
    assert.ok(Math.abs(growth.trend.bytesPerMin - 12 * MiB) < MiB, `~12 MiB/min, got ${growth.trend.bytesPerMin / MiB}`);
    assert.ok(growth.trend.r2 > 0.9);
    assert.ok(!kinds(analyze(framesOf(sawtooth(300, 0)))).includes('heap-growth'));
  });

  it('needs enough complete buckets before calling a trend', () => {
    assert.ok(!kinds(analyze(framesOf(sawtooth(120, 2 * MiB)))).includes('heap-growth'));
  });

  it('separates native (off-heap) growth from heap growth', () => {
    const points = Array.from({ length: 300 }, (_, i) => ({ heapUsed: 50 * MiB, heapTotal: 80 * MiB, rss: 200 * MiB + i * 0.1 * MiB }));
    assert.deepEqual(kinds(analyze(framesOf(points))), ['native-growth']);
  });

  it('flags limits, swapping, GC pressure and detached contexts', () => {
    let frames = framesOf([{ heapUsed: 50 * MiB }, { heapUsed: 50 * MiB }]);
    frames = withFrame(frames, 0, (f) => ({ ...f, gc: { ...f.gc, pauseRatio: 0.25 }, os: { ...f.os, majorFaultsPerSec: 400, processSwap: 64 * MiB } }));
    frames = withFrame(frames, 1, (f) => ({
      ...f,
      memory: { ...f.memory, heapUsed: 3900 * MiB },
      heap: { ...f.heap, limit: 4096 * MiB, detachedContexts: 2 },
      os: { ...f.os, memoryShare: 0.95 },
    }));
    assert.deepEqual(kinds(analyze(frames)), ['gc-pressure', 'swapping', 'near-heap-limit', 'near-memory-limit', 'detached-contexts']);
    assert.deepEqual(analyze([], {}), []);
  });

  it('takes threshold overrides', () => {
    let frames = framesOf([{ heapUsed: MiB }]);
    frames = withFrame(frames, 0, (f) => ({ ...f, loop: { ...f.loop, delay: { ...f.loop.delay, max: 60 } } }));
    assert.deepEqual(kinds(analyze(frames)), []);
    assert.deepEqual(kinds(analyze(frames, { loopStallMs: 50 })), ['loop-stall']);
  });
});
