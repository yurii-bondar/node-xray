import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeRecord, parseRecord } from '../src/record.js';
import { describeInsight, formatMs } from '../src/text.js';
import { hello } from './fixtures.js';

describe('records', () => {
  it('round-trips an agent line verbatim', () => {
    const line = encodeRecord(3, JSON.stringify(hello));
    assert.equal(line, `{"c":3,"m":${JSON.stringify(hello)}}`);
    assert.deepEqual(parseRecord(line), { ok: true, value: { connection: 3, message: hello } });
  });

  it('says what is wrong with a bad record', () => {
    assert.deepEqual(parseRecord('{"m":{}}'), { ok: false, error: '$.c: expected finite number' });
    assert.deepEqual(parseRecord('{"c":1,"m":{"type":"nope"}}'), { ok: false, error: 'message: $.type: expected a known message type' });
    assert.equal(parseRecord('{').ok, false);
  });
});

describe('text', () => {
  it('formats sub-millisecond durations in µs', () => {
    assert.equal(formatMs(0.04), '40 µs');
    assert.equal(formatMs(0), '0.0 ms');
    assert.equal(formatMs(2.5), '2.5 ms');
  });

  it('describes findings relative to an origin', () => {
    assert.equal(describeInsight({ kind: 'gc-pressure', t: 6000, pauseRatio: 0.2 }, 1000), 'GC took 20.0 % of the time at +5.00 s');
  });
});
