import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bucketOf } from '@node-xray/core';
import { HttpSideAggregator } from '../src/http-monitor.js';

describe('HttpSideAggregator', () => {
  it('counts, buckets and routes finished requests', () => {
    const side = new HttpSideAggregator();
    const a = {};
    const b = {};
    const c = {};
    side.begin(a, { start: 0, method: 'GET', host: '', path: '/users/42?x=1' });
    side.begin(b, { start: 0, method: 'GET', host: '', path: '/users/7' });
    side.begin(c, { start: 0, method: 'POST', host: '', path: '/orders' });
    side.end(a, 12, { status: 200 });
    side.end(b, 30, { status: 503 });
    side.end(c, 4, { status: 201, route: '/orders/:kind' });
    side.end(c, 9, { status: 200 });
    const tick = side.snapshot(40);
    assert.deepEqual([tick.started, tick.finished, tick.failed, tick.inFlight], [3, 3, 0, 0]);
    assert.deepEqual(tick.statuses, { '1xx': 0, '2xx': 2, '3xx': 0, '4xx': 0, '5xx': 1 });
    assert.equal(tick.histogram[bucketOf(12)], 1);
    assert.equal(tick.maxMs, 30);
    assert.deepEqual(
      tick.routes.map((r) => [r.key, r.count, r.errors, r.maxMs]),
      [
        ['GET /users/:id', 2, 1, 30],
        ['POST /orders/:kind', 1, 0, 4],
      ],
    );
    assert.deepEqual(tick.slowest.map((e) => e.ms), [30, 12, 4]);
  });

  it('starts every tick from zero but keeps what is still running, reporting old ones as stuck', () => {
    const side = new HttpSideAggregator();
    const slow = {};
    side.begin(slow, { start: 0, method: 'GET', host: 'api.example.com', path: '/v1/export/99' });
    side.snapshot(500);
    const tick = side.snapshot(2500);
    assert.deepEqual([tick.started, tick.inFlight], [0, 1]);
    assert.deepEqual(tick.stuck, [{ route: 'GET api.example.com /v1/export/:id', ageMs: 2500 }]);
  });

  it('counts aborted requests as failed', () => {
    const side = new HttpSideAggregator();
    const gone = { destroyed: true };
    const alive = { destroyed: false };
    side.begin(gone, { start: 0, method: 'GET', host: '', path: '/a' });
    side.begin(alive, { start: 0, method: 'GET', host: '', path: '/b' });
    side.sweep((key) => Reflect.get(key, 'destroyed') === true, 10);
    const tick = side.snapshot(10);
    assert.deepEqual([tick.failed, tick.finished, tick.inFlight], [1, 0, 1]);
    assert.equal(tick.routes[0]?.errors, 1);
  });

  it('bounds the route table', () => {
    const side = new HttpSideAggregator();
    for (let i = 0; i < 150; i++) {
      const key = {};
      side.begin(key, { start: 0, method: 'GET', host: '', path: `/page-${String.fromCharCode(97 + (i % 26))}${Math.floor(i / 26)}x` });
      side.end(key, 1, { status: 200 });
    }
    const tick = side.snapshot(1);
    assert.equal(tick.routes.length, 101);
    assert.equal(tick.routes.find((r) => r.key === '(other)')?.count, 50);
  });
});
