import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { parseStreamMessage, toLoopEvents, type LoopEvent, type LoopTraceMessage, type WireLoopTrace } from '@node-xray/core';
import { loopCountReader, uvCounters } from '../src/sampler.js';
import { SelfWork } from '../src/self.js';
import { callbackName, LoopTracer, untrackedType } from '../src/tracer.js';

function tracer(
  batches: WireLoopTrace[],
  errors: unknown[] = [],
  now = (): number => performance.now(),
  accept = (): boolean => true,
): { tracer: LoopTracer; self: SelfWork } {
  const self = new SelfWork((error) => errors.push(error));
  const t = new LoopTracer({
    self,
    send: (batch) => {
      if (!accept()) return false;
      batches.push(structuredClone(batch));
      return true;
    },
    now,
    timeOrigin: performance.timeOrigin,
    loopCount: loopCountReader(),
  });
  return { tracer: t, self };
}

function parse(batch: WireLoopTrace): LoopTraceMessage {
  const parsed = parseStreamMessage(batch);
  if (!parsed.ok) assert.fail(parsed.error);
  assert.equal(parsed.value.type, 'loop-trace');
  return parsed.value as LoopTraceMessage;
}

function counter(batches: readonly WireLoopTrace[], resource: string): { created: number; settled: number; executed: number } {
  const out = { created: 0, settled: 0, executed: 0 };
  for (const batch of batches) {
    for (const c of parse(batch).counters) {
      if (c.resource !== resource) continue;
      out.created += c.created;
      out.settled += c.settled;
      out.executed += c.executed;
    }
  }
  return out;
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

describe('LoopTracer settled counts', () => {
  it('settles timers when they fire or are cleared, immediates and requests when they run', async () => {
    const batches: WireLoopTrace[] = [];
    const { tracer: t, self } = tracer(batches);
    self.run(() => t.start({ flushMs: 10_000, maxEventsPerFlush: 10_000, durationMs: 10_000 }));
    const cleared = setTimeout(() => undefined, 60_000);
    clearTimeout(cleared);
    const armed = setTimeout(() => undefined, 60_000);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => readFile(import.meta.filename, () => resolve()));
    self.run(() => t.stop());
    clearTimeout(armed);

    const timers = counter(batches, 'Timeout');
    assert.ok(timers.created >= 3, `created ${timers.created}`);
    assert.equal(timers.created - timers.settled, 1, 'only the armed timer is still pending');
    const immediates = counter(batches, 'Immediate');
    assert.ok(immediates.created >= 1 && immediates.settled === immediates.created);
    const reads = counter(batches, 'FSREQCALLBACK');
    assert.ok(reads.created >= 1 && reads.settled === reads.created);
  });

  it('settles requests a synchronous API made once they are collected', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const batches: WireLoopTrace[] = [];
    const { tracer: t, self } = tracer(batches);
    self.run(() => t.start({ flushMs: 10_000, maxEventsPerFlush: 10_000, durationMs: 10_000 }));
    for (let i = 0; i < 20; i++) randomBytes(16);
    // Finalization callbacks run as their own tasks after a collection.
    for (let i = 0; i < 5; i++) {
      gc();
      await pause(5);
    }
    self.run(() => t.stop());
    const requests = counter(batches, 'RANDOMBYTESREQUEST');
    assert.ok(requests.created >= 20, `created ${requests.created}`);
    assert.equal(requests.executed, 0, 'a synchronous API runs no callback');
    assert.equal(requests.settled, requests.created, 'none is left looking like queued work');
  });

  it("leaves out the agent's async work after its first await, and its promises", async () => {
    const batches: WireLoopTrace[] = [];
    const { tracer: t, self } = tracer(batches);
    self.run(() => t.start({ flushMs: 10_000, maxEventsPerFlush: 10_000, durationMs: 10_000 }));
    let done = (): void => undefined;
    const finished = new Promise<void>((resolve) => (done = resolve));
    self.run(() => {
      void (async () => {
        await null;
        // Out of `SelfWork.run` by now, like the profiler between two CDP calls.
        for (let i = 0; i < 1000; i++) await new Promise<void>((resolve) => resolve());
        setImmediate(function agentLater() {
          done();
        });
      })();
    });
    await finished;
    self.run(() => t.stop());
    const events = toLoopEvents(parse(batches[0] as WireLoopTrace));
    assert.equal(events.find((e) => e.name === 'agentLater'), undefined);
    const promises = counter(batches, 'PROMISE');
    assert.ok(promises.created < 100 && promises.settled < 100, `created ${promises.created}, settled ${promises.settled}`);
  });
});

describe('LoopTracer agent time', () => {
  it('takes agent work out of the callback it ran in', async () => {
    const batches: WireLoopTrace[] = [];
    const { tracer: t, self } = tracer(batches);
    self.run(() => t.start({ flushMs: 10_000, maxEventsPerFlush: 10_000, durationMs: 10_000 }));
    const spin = (ms: number): void => {
      const end = performance.now() + ms;
      while (performance.now() < end);
    };
    await new Promise<void>((resolve) =>
      setImmediate(function hostsObserver() {
        spin(5);
        self.run(() => spin(30));
        resolve();
      }),
    );
    self.run(() => t.stop());
    const event = toLoopEvents(parse(batches[0] as WireLoopTrace)).find((e) => e.name === 'hostsObserver');
    assert.ok(event && event.duration >= 4 && event.duration < 20, `${event?.duration} ms`);
  });
});

describe('LoopTracer batches', () => {
  it('sends only the names a batch uses', async () => {
    const batches: WireLoopTrace[] = [];
    const { tracer: t, self } = tracer(batches);
    self.run(() => t.start({ flushMs: 10_000, maxEventsPerFlush: 10_000, durationMs: 10_000 }));
    await new Promise<void>((resolve) => setImmediate(function first() { resolve(); }));
    self.run(() => t.flush());
    await new Promise<void>((resolve) => setImmediate(function second() { resolve(); }));
    self.run(() => t.stop());
    assert.equal(batches.length, 2);
    const [a, b] = batches as [WireLoopTrace, WireLoopTrace];
    assert.ok(a.names.includes('first') && !a.names.includes('second'), a.names.join(', '));
    assert.ok(b.names.includes('second') && !b.names.includes('first'), b.names.join(', '));
    assert.ok(toLoopEvents(parse(b)).some((e) => e.name === 'second'));
  });

  it('starts clean after a trace that failed without flushing', async () => {
    const batches: WireLoopTrace[] = [];
    const errors: unknown[] = [];
    let broken = false;
    const { tracer: t, self } = tracer(batches, errors, () => {
      if (broken) throw new Error('clock broke');
      return performance.now();
    });
    self.run(() => t.start({ flushMs: 10_000, maxEventsPerFlush: 1000, durationMs: 10_000 }));
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    broken = true;
    await new Promise<void>((resolve) => setImmediate(resolve));
    broken = false;
    assert.equal(t.running, false, 'the failure stopped the trace');
    assert.equal(errors.length, 1);

    self.run(() => t.start({ flushMs: 10_000, maxEventsPerFlush: 2, durationMs: 10_000 }));
    self.run(() => t.stop());
    const batch = parse(batches[batches.length - 1] as WireLoopTrace);
    assert.ok(batch.events.length <= 2, `${batch.events.length} events`);
    assert.equal(batch.dropped, 0, 'nothing carried over from the failed trace');
    assert.equal(counter(batches.slice(-1), 'Immediate').executed, 0);
  });

  it('carries a lost batch over into the next one: counters exact, batches contiguous', async () => {
    const batches: WireLoopTrace[] = [];
    let accepting = false;
    const { tracer: t, self } = tracer(batches, [], undefined, () => accepting);
    self.run(() => t.start({ flushMs: 10_000, maxEventsPerFlush: 10_000, durationMs: 10_000 }));
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    self.run(() => t.flush());
    assert.equal(batches.length, 0, 'the link dropped it');
    accepting = true;
    for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    self.run(() => t.flush());
    for (let i = 0; i < 2; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    self.run(() => t.stop());

    const [merged, next] = batches.map(parse) as [LoopTraceMessage, LoopTraceMessage];
    assert.equal(merged.end, next.start, 'contiguous');
    assert.ok(merged.dropped >= 5, `${merged.dropped} dropped: the lost batch's events`);
    assert.equal(next.dropped, 0);
    const immediates = counter(batches.slice(0, 1), 'Immediate');
    assert.ok(immediates.executed >= 8 && immediates.created >= 8, `executed ${immediates.executed}, created ${immediates.created}`);
    const events = toLoopEvents(merged);
    assert.ok(events.every((e) => e.start >= merged.start), 'events placed in the merged window');
  });
});

describe('LoopTracer hook cost', () => {
  it('measures a plausible cost per hook call, cheaply', async () => {
    const self = new SelfWork(() => undefined);
    const started = performance.now();
    const us = await LoopTracer.measureHookCost({ self, send: () => true, now: () => performance.now(), timeOrigin: performance.timeOrigin, loopCount: loopCountReader() });
    const ms = performance.now() - started;
    assert.ok(us >= 0.05 && us <= 20, `${us} µs`);
    assert.ok(ms < 100, `${ms} ms`);
    assert.ok(self.takeOverhead() > 0, 'the calibration counts as overhead');
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
