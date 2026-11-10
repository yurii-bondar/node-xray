import assert from 'node:assert/strict';
import { readFile } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'node:test';
import { parseStreamMessage, toLoopEvents, type LoopEvent, type LoopTraceMessage, type WireLoopTrace } from '@node-xray/core';
import { uvCounters } from '../src/sampler.js';
import { SelfWork } from '../src/self.js';
import { callbackName, LoopTracer, untrackedType } from '../src/tracer.js';

function tracer(batches: WireLoopTrace[], errors: unknown[] = []): { tracer: LoopTracer; self: SelfWork } {
  const self = new SelfWork((error) => errors.push(error));
  const t = new LoopTracer({
    self,
    send: (batch) => batches.push(structuredClone(batch)),
    now: () => performance.now(),
    timeOrigin: performance.timeOrigin,
    loopCount: () => uvCounters()?.loopCount ?? -1,
    addOverhead: () => undefined,
  });
  return { tracer: t, self };
}

function parse(batch: WireLoopTrace): LoopTraceMessage {
  const parsed = parseStreamMessage(batch);
  if (!parsed.ok) assert.fail(parsed.error);
  assert.equal(parsed.value.type, 'loop-trace');
  return parsed.value as LoopTraceMessage;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('LoopTracer', () => {
  it('records timers, immediates, I/O, nextTicks and promises with names and iterations', async () => {
    const batches: WireLoopTrace[] = [];
    const errors: unknown[] = [];
    const { tracer: t, self } = tracer(batches, errors);
    self.run(() => t.start({ flushMs: 10_000, maxEventsPerFlush: 10_000, durationMs: 10_000 }));

    await new Promise<void>((resolve) => {
      setTimeout(function pollJobs() {
        process.nextTick(function afterPoll() {});
        void Promise.resolve().then(function onResolved() {});
      }, 1);
      setImmediate(function checkPhase() {});
      readFile(import.meta.filename, function onRead() {
        resolve();
      });
    });
    await pause(20);
    self.run(() => t.stop());

    assert.deepEqual(errors, []);
    assert.equal(batches.length, 1);
    const events: LoopEvent[] = toLoopEvents(parse(batches[0] as WireLoopTrace));
    const named = (name: string): LoopEvent | undefined => events.find((e) => e.name === name);
    assert.equal(named('pollJobs')?.category, 'timer');
    assert.equal(named('afterPoll')?.category, 'nextTick');
    assert.equal(named('checkPhase')?.category, 'immediate');
    assert.ok(events.some((e) => e.category === 'promise'), 'promise reactions');
    assert.ok(events.some((e) => e.category === 'io' && e.resource === 'FSREQCALLBACK'), 'fs callback');
    if (uvCounters() !== null) assert.ok(events.every((e) => e.iteration >= 0), 'iterations from uvMetricsInfo');
    assert.ok(events.every((e) => e.duration >= 0 && e.start > performance.timeOrigin));
  });

  it("skips the agent's own timers", async () => {
    const batches: WireLoopTrace[] = [];
    const { tracer: t, self } = tracer(batches);
    self.run(() => t.start({ flushMs: 10_000, maxEventsPerFlush: 10_000, durationMs: 10_000 }));
    self.run(() => {
      setTimeout(function agentOwnTimer() {}, 1);
    });
    await pause(15);
    self.run(() => t.stop());
    const events = toLoopEvents(parse(batches[0] as WireLoopTrace));
    assert.equal(events.find((e) => e.name === 'agentOwnTimer'), undefined);
  });

  it('keeps counters exact when events are dropped', async () => {
    const batches: WireLoopTrace[] = [];
    const { tracer: t, self } = tracer(batches);
    self.run(() => t.start({ flushMs: 10_000, maxEventsPerFlush: 3, durationMs: 10_000 }));
    await new Promise<void>((resolve) => {
      let left = 10;
      const next = (): void => {
        if (--left === 0) resolve();
        else setImmediate(next);
      };
      setImmediate(next);
    });
    self.run(() => t.stop());
    const batch = parse(batches[0] as WireLoopTrace);
    assert.equal(batch.events.length, 3);
    assert.ok(batch.dropped > 0);
    const immediates = batch.counters.find((c) => c.resource === 'Immediate');
    assert.ok(immediates && immediates.executed >= 10, `executed ${immediates?.executed}`);
  });

  it('stops by itself after durationMs', async () => {
    const batches: WireLoopTrace[] = [];
    const { tracer: t, self } = tracer(batches);
    self.run(() => t.start({ flushMs: 10_000, maxEventsPerFlush: 100, durationMs: 30 }));
    assert.equal(t.running, true);
    await pause(60);
    assert.equal(t.running, false);
    assert.equal(batches.length, 1);
  });
});

describe('resource helpers', () => {
  it('reads callback names and classifies untracked resources', () => {
    function work(): void {}
    assert.equal(callbackName('Timeout', { _onTimeout: work }), 'work');
    assert.equal(callbackName('TickObject', { callback: work }), 'work');
    assert.equal(callbackName('TCPWRAP', { callback: work }), '');
    assert.equal(untrackedType(Promise.resolve()), 'PROMISE');
    assert.equal(untrackedType({}), 'Unknown');
    class Immediate {}
    assert.equal(untrackedType(new Immediate()), 'Immediate');
  });
});
