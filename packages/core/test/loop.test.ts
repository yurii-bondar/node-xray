import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { categorize, groupIterations, phaseOf, summarizeTrace, TaskLedger, toLoopEvents } from '../src/loop.js';
import type { LoopTraceEvent, LoopTraceMessage } from '../src/protocol.js';

function trace(events: LoopTraceEvent[], counters: LoopTraceMessage['counters'] = []): LoopTraceMessage {
  return { type: 'loop-trace', start: 0, end: 250, events, counters, dropped: 0 };
}

function ev(resource: string, iteration: number, start: number, duration: number, depth = 0): LoopTraceEvent {
  return { resource, name: '', iteration, start, duration, depth };
}

describe('categorize / phaseOf', () => {
  it('maps async resource types to categories and loop phases', () => {
    const cases: Array<[string, string, string]> = [
      ['Timeout', 'timer', 'timers'],
      ['FSREQCALLBACK', 'io', 'poll'],
      ['TCPWRAP', 'io', 'poll'],
      ['Immediate', 'immediate', 'check'],
      ['TickObject', 'nextTick', 'microtasks'],
      ['Microtask', 'microtask', 'microtasks'],
      ['PROMISE', 'promise', 'microtasks'],
    ];
    for (const [resource, category, phase] of cases) {
      const c = categorize(resource);
      assert.equal(c, category, resource);
      assert.equal(phaseOf(c), phase, resource);
    }
  });
});

describe('groupIterations', () => {
  it('counts what ran in each loop iteration (the probe run from the design notes)', () => {
    const events = toLoopEvents(
      trace([
        ev('Immediate', 1, 0, 1),
        ev('Microtask', 1, 1, 0.1),
        ev('FSREQCALLBACK', 2, 2, 0.5),
        ev('Timeout', 6, 10, 2),
        ev('TickObject', 6, 12, 0.1),
        ev('PROMISE', 6, 12.1, 0.2),
        ev('PROMISE', 6, 12.2, 0.1, 1),
        ev('Timeout', 6, 13, 1),
      ]),
    );
    const iterations = groupIterations(events);
    assert.deepEqual(
      iterations.map((it) => [it.index, it.counts.timer, it.counts.io, it.counts.immediate, it.counts.nextTick, it.counts.microtask, it.counts.promise]),
      [
        [1, 0, 0, 1, 0, 1, 0],
        [2, 0, 1, 0, 0, 0, 0],
        [6, 2, 0, 0, 1, 0, 2],
      ],
    );
    const last = iterations[2];
    assert.ok(last);
    assert.ok(Math.abs(last.busy - 3.3) < 1e-9, 'depth-0 callbacks only');
    assert.equal(last.phaseBusy.timers, 3);
    assert.ok(Math.abs(last.phaseBusy.microtasks - 0.3) < 1e-9);
    assert.equal(last.start, 10);
    assert.equal(last.end, 14);
  });

  it('infers iterations from phase order when loop counts are unknown', () => {
    const events = toLoopEvents(
      trace([ev('Timeout', -1, 0, 1), ev('PROMISE', -1, 1, 1), ev('TCPWRAP', -1, 2, 1), ev('Immediate', -1, 3, 1), ev('Timeout', -1, 4, 1), ev('Immediate', -1, 5, 1)]),
    );
    const iterations = groupIterations(events);
    assert.deepEqual(
      iterations.map((it) => [it.index, it.inferred, it.counts.timer, it.counts.promise, it.counts.io, it.counts.immediate]),
      [
        [0, true, 1, 1, 1, 1],
        [1, true, 1, 0, 0, 1],
      ],
    );
  });
});

describe('summarizeTrace / TaskLedger', () => {
  const counters = [
    { resource: 'Timeout', created: 4, executed: 3, settled: 3, busy: 6 },
    { resource: 'PROMISE', created: 10, executed: 8, settled: 7, busy: 2 },
    { resource: 'TCPWRAP', created: 1, executed: 5, settled: 0, busy: 4 },
    { resource: 'FSREQCALLBACK', created: 2, executed: 2, settled: 2, busy: 1 },
  ];

  it('sums exact counters per category', () => {
    const window = summarizeTrace(trace([], counters));
    assert.deepEqual(window.byCategory.io, { created: 3, executed: 7, busy: 5 });
    assert.deepEqual(window.byCategory.timer, { created: 4, executed: 3, busy: 6 });
    assert.deepEqual(window.byCategory.immediate, { created: 0, executed: 0, busy: 0 });
  });

  it('accumulates pending work across batches, never below zero', () => {
    const ledger = new TaskLedger();
    ledger.apply(counters);
    ledger.apply([{ resource: 'Timeout', created: 0, executed: 1, settled: 6, busy: 1 }]);
    const byResource = new Map(ledger.snapshot().map((q) => [q.resource, q]));
    assert.equal(byResource.get('PROMISE')?.pending, 3);
    assert.equal(byResource.get('TCPWRAP')?.pending, 1);
    assert.equal(byResource.get('Timeout')?.pending, 0, 'timers older than the trace settle without being counted');
    assert.equal(byResource.get('Timeout')?.executed, 4);
    assert.equal(ledger.snapshot()[0]?.resource, 'PROMISE');
  });
});
