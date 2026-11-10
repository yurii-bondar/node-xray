import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CpuProfile } from '../src/cdp.js';
import { decodeStreamMessage } from '../src/protocol.js';
import { encodeLine, LineDecoder } from '../src/ndjson.js';
import { Timeline } from '../src/timeline.js';
import { callFrame, hello, sample, wireSample } from './fixtures.js';

const profile: CpuProfile = {
  startTime: 0,
  endTime: 1,
  samples: [],
  nodes: [
    { id: 1, callFrame: callFrame('(root)'), hitCount: 0, children: [2], positionTicks: [] },
    { id: 2, callFrame: callFrame('work'), hitCount: 3, children: [], positionTicks: [] },
  ],
};

describe('Timeline', () => {
  it('derives frames only once hello and a previous sample exist', () => {
    const timeline = new Timeline();
    timeline.apply(sample(1000));
    timeline.apply(sample(2000, { gc: [{ start: 1500, duration: 3, kind: 'minor' }] }));
    assert.equal(timeline.frames().length, 0, 'no facts before hello');
    assert.equal(timeline.gcEvents().length, 1, 'GC events are kept regardless');

    timeline.apply(hello);
    timeline.apply(sample(3000));
    timeline.apply(sample(4000));
    assert.equal(timeline.frames().length, 1, 'hello resets the counter baseline');
    assert.equal(timeline.latestFrame()?.t, 4000);
  });

  it('keeps bounded history', () => {
    const timeline = new Timeline({ frames: 2 });
    timeline.apply(hello);
    for (let t = 1000; t <= 5000; t += 1000) timeline.apply(sample(t));
    assert.deepEqual(timeline.frames().map((f) => f.t), [4000, 5000]);
  });

  it('merges the last CPU windows and keeps the latest allocation profile', () => {
    const timeline = new Timeline({ cpuWindows: 2 });
    for (let i = 0; i < 3; i++) timeline.apply({ type: 'cpu-profile', start: i * 1000, end: (i + 1) * 1000, profile });
    assert.equal(timeline.cpuFlame()?.root.total, 6, 'only the kept windows');
    assert.equal(timeline.cpuFlame(1)?.root.total, 3);
    assert.equal(timeline.allocations(), null);
  });

  it('turns loop traces into iterations, windows and queues', () => {
    const timeline = new Timeline();
    timeline.apply({
      type: 'loop-trace',
      start: 0,
      end: 250,
      events: [
        { resource: 'Timeout', name: 'tick', iteration: 3, start: 1, duration: 2, depth: 0 },
        { resource: 'PROMISE', name: '', iteration: 3, start: 3, duration: 1, depth: 0 },
        { resource: 'TCPWRAP', name: '', iteration: 4, start: 10, duration: 5, depth: 0 },
      ],
      counters: [{ resource: 'PROMISE', created: 5, executed: 1, settled: 1, busy: 1 }],
      dropped: 0,
    });
    assert.deepEqual(timeline.iterations().map((it) => it.index), [3, 4]);
    assert.equal(timeline.loopEvents()[0]?.phase, 'timers');
    assert.equal(timeline.traceWindows()[0]?.byCategory.promise.created, 5);
    assert.equal(timeline.queues()[0]?.pending, 4);
  });

  it('runs the wire path end to end: NDJSON → parse → frames', () => {
    const timeline = new Timeline();
    const decoder = new LineDecoder();
    const wire = encodeLine(hello) + encodeLine(wireSample(1000)) + encodeLine(wireSample(2000)) + encodeLine({ type: 'agent-error', message: 'inspector busy' });
    for (const line of decoder.push(wire)) {
      const parsed = decodeStreamMessage(line);
      if (!parsed.ok) assert.fail(parsed.error);
      timeline.apply(parsed.value);
    }
    assert.equal(timeline.frames().length, 1);
    assert.equal(timeline.errors()[0], 'inspector busy');
    assert.equal(timeline.insights().length, 0);
  });
});
