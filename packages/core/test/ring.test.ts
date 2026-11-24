import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Ring } from '../src/ring.js';
import { linearFit, ratePerSecond } from '../src/stats.js';

describe('Ring', () => {
  it('keeps the newest items in order', () => {
    const ring = new Ring<number>(3);
    assert.equal(ring.last(), undefined);
    for (const n of [1, 2, 3, 4, 5]) ring.push(n);
    assert.deepEqual(ring.toArray(), [3, 4, 5]);
    assert.equal(ring.size, 3);
    assert.equal(ring.last(), 5);
    ring.clear();
    assert.deepEqual(ring.toArray(), []);
  });

  it('wraps around repeatedly and after a clear, oldest first', () => {
    const ring = new Ring<number>(4);
    for (let n = 1; n <= 2; n++) ring.push(n);
    assert.deepEqual(ring.toArray(), [1, 2], 'partly filled');
    for (let n = 3; n <= 11; n++) ring.push(n);
    assert.deepEqual(ring.toArray(), [8, 9, 10, 11]);
    assert.equal(ring.last(), 11);
    ring.clear();
    assert.equal(ring.size, 0);
    assert.equal(ring.last(), undefined);
    for (let n = 1; n <= 6; n++) ring.push(n);
    assert.deepEqual(ring.toArray(), [3, 4, 5, 6]);
    assert.equal(ring.last(), 6);
  });

  it('holds few items in a large ring without filling it', () => {
    const ring = new Ring<string>(1_000_000);
    ring.push('a');
    ring.push('b');
    assert.equal(ring.size, 2);
    assert.deepEqual(ring.toArray(), ['a', 'b']);
    assert.equal(ring.last(), 'b');
  });

  it('rejects a non-positive capacity', () => {
    assert.throws(() => new Ring(0), RangeError);
  });
});

describe('stats', () => {
  it('fits a line', () => {
    const fit = linearFit([0, 1, 2, 3], [1, 3, 5, 7]);
    assert.deepEqual(fit, { slope: 2, intercept: 1, r2: 1 });
    assert.equal(linearFit([1, 1], [1, 2]), null);
    assert.equal(linearFit([1], [1]), null);
  });

  it('turns counter deltas into rates, ignoring resets', () => {
    assert.equal(ratePerSecond(10, 30, 500), 40);
    assert.equal(ratePerSecond(30, 10, 500), 0);
    assert.equal(ratePerSecond(10, 30, 0), 0);
  });
});
