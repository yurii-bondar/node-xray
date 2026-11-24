import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ACK_INTERVAL_MS, ACK_MAX_CHARS, AckThrottle } from '../src/acks.js';

/** Timers run by hand: `fire()` runs every pending one. */
function fakeTimers() {
  const pending = new Set<() => void>();
  const delays: number[] = [];
  return {
    delays,
    pending,
    schedule: (callback: () => void, ms: number) => {
      delays.push(ms);
      pending.add(callback);
      return () => pending.delete(callback);
    },
    fire: () => {
      const due = [...pending];
      pending.clear();
      for (const callback of due) callback();
    },
  };
}

describe('AckThrottle', () => {
  it('sends the cumulative count once per interval, only when it changed', () => {
    const timers = fakeTimers();
    const sent: number[] = [];
    const acks = new AckThrottle({ send: (total) => sent.push(total), schedule: timers.schedule });

    timers.fire();
    assert.deepEqual(sent, [], 'nothing received, nothing sent');
    acks.received(100);
    acks.received(50);
    assert.deepEqual(sent, [], 'not on the message path');
    assert.equal(timers.pending.size, 1, 'one timer for the batch');
    assert.deepEqual(timers.delays, [ACK_INTERVAL_MS]);
    timers.fire();
    assert.deepEqual(sent, [150]);

    timers.fire();
    assert.equal(timers.pending.size, 0, 'idle: no timer');
    acks.received(0);
    assert.equal(timers.pending.size, 0, 'an empty payload changes nothing');
    acks.received(10);
    timers.fire();
    assert.deepEqual(sent, [150, 160], 'cumulative since injection');
  });

  it('acknowledges a burst of a million characters at once', () => {
    const timers = fakeTimers();
    const sent: number[] = [];
    const acks = new AckThrottle({ send: (total) => sent.push(total), schedule: timers.schedule });
    acks.received(ACK_MAX_CHARS - 1);
    assert.deepEqual(sent, []);
    acks.received(1);
    assert.deepEqual(sent, [ACK_MAX_CHARS]);
    assert.equal(timers.pending.size, 0, 'the pending timer is cancelled');
    acks.received(2 * ACK_MAX_CHARS);
    assert.deepEqual(sent, [ACK_MAX_CHARS, 3 * ACK_MAX_CHARS]);
    timers.fire();
    assert.equal(sent.length, 2, 'nothing new to acknowledge');
  });

  it('sends nothing after stop', () => {
    const timers = fakeTimers();
    const sent: number[] = [];
    const acks = new AckThrottle({ send: (total) => sent.push(total), schedule: timers.schedule });
    acks.received(10);
    acks.stop();
    assert.equal(timers.pending.size, 0);
    acks.received(ACK_MAX_CHARS);
    timers.fire();
    assert.deepEqual(sent, []);
  });
});
