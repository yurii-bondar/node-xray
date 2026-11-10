import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeStreamMessage, parseAgentCommand, parseStreamMessage, type StreamMessage } from '../src/protocol.js';
import { hello, wireSample } from './fixtures.js';

function ok(value: unknown): StreamMessage {
  const parsed = parseStreamMessage(value);
  if (!parsed.ok) assert.fail(parsed.error);
  return parsed.value;
}

function error(value: unknown): string {
  const parsed = parseStreamMessage(value);
  if (parsed.ok) assert.fail('expected a parse error');
  return parsed.error;
}

describe('parseStreamMessage', () => {
  it('accepts a hello of the current protocol', () => {
    assert.deepEqual(ok(JSON.parse(JSON.stringify(hello))), hello);
  });

  it('rejects another protocol version', () => {
    assert.match(error({ ...hello, protocol: 2 }), /\$\.protocol: expected protocol 1/);
  });

  it('normalises a sample: GC kinds, maxRss in bytes, sorted resources', () => {
    const message = ok(wireSample(10_000));
    assert.equal(message.type, 'sample');
    if (message.type !== 'sample') return;
    assert.deepEqual(message.gc.map((event) => event.kind), ['minor', 'major', 'minor', 'other']);
    assert.equal(message.rusage.maxRss, 2048 * 1024);
    assert.deepEqual(message.resources, [
      { type: 'TCPSocketWrap', count: 5 },
      { type: 'FSReqCallback', count: 2 },
      { type: 'Timeout', count: 2 },
    ]);
    assert.deepEqual(message.uv, { loopCount: 120, events: 300 });
    assert.equal(message.system.processSwap, null);
  });

  it('treats a missing uv block as unavailable', () => {
    const { uv: _uv, ...rest } = wireSample(1);
    const message = ok(rest);
    assert.equal(message.type === 'sample' && message.uv, null);
  });

  it('names the first bad field', () => {
    const bad: Record<string, unknown> = { ...wireSample(1), memory: { rss: 'a lot' } };
    assert.equal(error(bad), '$.memory.rss: expected finite number');
    assert.equal(error({ type: 'nope' }), '$.type: expected a known message type');
    assert.equal(error([]), '$: expected object');
  });

  it('decodes a flat loop trace against its dictionaries', () => {
    const message = ok({
      type: 'loop-trace',
      start: 1000,
      end: 1250,
      types: ['Timeout', 'PROMISE'],
      names: ['poll'],
      // type, iteration, start µs, duration µs, depth, name
      events: [0, 7, 1500, 2000, 0, 0, 1, 7, 3600, 100, 1, -1],
      counters: [{ resource: 'Timeout', created: 1, executed: 1, settled: 1, busyUs: 2000 }],
      dropped: 0,
    });
    assert.equal(message.type, 'loop-trace');
    if (message.type !== 'loop-trace') return;
    assert.deepEqual(message.events, [
      { resource: 'Timeout', iteration: 7, start: 1001.5, duration: 2, depth: 0, name: 'poll' },
      { resource: 'PROMISE', iteration: 7, start: 1003.6, duration: 0.1, depth: 1, name: '' },
    ]);
    assert.equal(message.counters[0]?.busy, 2);
  });

  it('rejects a trace with a broken layout or dictionary index', () => {
    const base = { type: 'loop-trace', start: 0, end: 1, types: ['Timeout'], names: [], counters: [], dropped: 0 };
    assert.match(error({ ...base, events: [0, 1, 2] }), /multiple of 6/);
    assert.match(error({ ...base, events: [3, 0, 0, 0, 0, -1] }), /index into a dictionary of 1/);
  });

  it('parses a host sample with and without swap', () => {
    const gpu = { index: 0, name: 'RTX', utilization: 0.4, memoryUsed: 10, memoryTotal: 20, processMemory: null };
    const message = ok({ type: 'host', t: 1, swap: null, gpus: [gpu] });
    assert.deepEqual(message, { type: 'host', t: 1, swap: null, gpus: [gpu] });
    const withSwap = ok({ type: 'host', t: 1, swap: { total: 8, used: 2 }, gpus: [] });
    assert.deepEqual(withSwap.type === 'host' && withSwap.swap, { total: 8, used: 2 });
  });
});

describe('decodeStreamMessage', () => {
  it('reports invalid JSON instead of throwing', () => {
    const parsed = decodeStreamMessage('{"type":');
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? '' : parsed.error, /^invalid JSON/);
  });
});

describe('parseAgentCommand', () => {
  it('accepts known commands and rejects non-positive limits', () => {
    assert.deepEqual(parseAgentCommand({ type: 'loop-trace-start', flushMs: 250, maxEventsPerFlush: 5000, durationMs: 10_000 }), {
      ok: true,
      value: { type: 'loop-trace-start', flushMs: 250, maxEventsPerFlush: 5000, durationMs: 10_000 },
    });
    assert.deepEqual(parseAgentCommand({ type: 'cpu-profile-stop', extra: 1 }), { ok: true, value: { type: 'cpu-profile-stop' } });
    assert.deepEqual(parseAgentCommand({ type: 'cpu-profile-start', samplingIntervalUs: 0, windowMs: 5000 }), {
      ok: false,
      error: '$.samplingIntervalUs: expected positive number',
    });
  });
});
