import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeLine, LineDecoder, LineTooLongError } from '../src/ndjson.js';

describe('LineDecoder', () => {
  it('returns lines split across chunks, several per chunk, CRLF and blanks handled', () => {
    const decoder = new LineDecoder();
    assert.deepEqual(decoder.push('{"a":'), []);
    assert.deepEqual(decoder.push('1}\n{"b":2}\r\n\n{"c"'), ['{"a":1}', '{"b":2}']);
    assert.equal(decoder.pending, '{"c"');
    assert.deepEqual(decoder.push(':3}\n'), ['{"c":3}']);
    assert.equal(decoder.pending, '');
  });

  it('round-trips encodeLine', () => {
    const decoder = new LineDecoder();
    const message = { type: 'agent-error', message: 'line\nbreak' };
    assert.deepEqual(decoder.push(encodeLine(message)).map((line) => JSON.parse(line) as unknown), [message]);
  });

  it('throws when a line outgrows the cap, complete or not', () => {
    assert.throws(() => new LineDecoder(4).push('12345\n'), LineTooLongError);
    const decoder = new LineDecoder(4);
    decoder.push('123');
    assert.throws(() => decoder.push('45'), LineTooLongError);
  });
});
