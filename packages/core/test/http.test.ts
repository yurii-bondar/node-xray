import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bucketOf, emptySide, histogramPercentile, HTTP_BUCKET_COUNT, httpRates, normalizeRoute, statusClass, summarizeHttp, type HttpMessage, type HttpSide } from '../src/http.js';
import { analyzeHttp } from '../src/insights.js';
import { parseStreamMessage } from '../src/protocol.js';
import { buildReport } from '../src/report.js';
import { describeInsight } from '../src/text.js';
import { Timeline } from '../src/timeline.js';
import { hello } from './fixtures.js';

/** A side with `latencies` finished requests (ms), all 200 unless `statuses` says otherwise. */
function side(latencies: readonly number[], extra: Partial<HttpSide> = {}): HttpSide {
  const histogram = new Array<number>(HTTP_BUCKET_COUNT).fill(0);
  for (const ms of latencies) histogram[bucketOf(ms)] = (histogram[bucketOf(ms)] ?? 0) + 1;
  return {
    ...emptySide(),
    started: latencies.length,
    finished: latencies.length,
    statuses: { '1xx': 0, '2xx': latencies.length, '3xx': 0, '4xx': 0, '5xx': 0 },
    histogram,
    maxMs: Math.max(0, ...latencies),
    ...extra,
  };
}

function tick(t: number, server: HttpSide, client: HttpSide = emptySide()): HttpMessage {
  return { type: 'http', start: t - 1000, end: t, server, client };
}

describe('normalizeRoute', () => {
  it('collapses ids, uuids, hashes and tokens, drops the query', () => {
    assert.equal(normalizeRoute('/users/42/orders?page=2'), '/users/:id/orders');
    assert.equal(normalizeRoute('/files/9f86d081-884c-4d63-9f2b-2e0a1d2c3b4a/download'), '/files/:id/download');
    assert.equal(normalizeRoute('/blobs/e3b0c44298fc1c149afbf4c8996fb924'), '/blobs/:id');
    assert.equal(normalizeRoute('/reset/Zx9_aB12cdEFghIJklMNopQR'), '/reset/:id');
    assert.equal(normalizeRoute('/health'), '/health');
    assert.equal(normalizeRoute('/'), '/');
    assert.equal(normalizeRoute('/a/b/c/d/e/f/g/h'), '/a/b/c/d/e/f/…');
  });
});

describe('latency histogram', () => {
  it('buckets by upper bound and interpolates percentiles', () => {
    assert.deepEqual([bucketOf(0.05), bucketOf(0.3), bucketOf(1), bucketOf(1.5), bucketOf(30_000)], [0, 2, 3, 4, 16]);
    const s = side([...Array<number>(90).fill(4), ...Array<number>(10).fill(400)]);
    const p50 = histogramPercentile(s.histogram, 50, s.maxMs);
    assert.ok(p50 > 2 && p50 <= 5, `p50 ${p50}`);
    const p99 = histogramPercentile(s.histogram, 99, s.maxMs);
    assert.ok(p99 > 250 && p99 <= 400, `p99 ${p99} is capped by the observed max`);
    assert.equal(histogramPercentile(new Array<number>(HTTP_BUCKET_COUNT).fill(0), 99, 0), 0);
  });

  it('turns a tick into rates', () => {
    const s = side(Array<number>(50).fill(10), { failed: 2, statuses: { '1xx': 0, '2xx': 45, '3xx': 0, '4xx': 2, '5xx': 3 }, inFlight: 4 });
    const rates = httpRates(s, { start: 0, end: 500 });
    assert.equal(rates.rps, 100);
    assert.equal(rates.errorRate, 5 / 52);
    assert.equal(rates.inFlight, 4);
    assert.equal(statusClass(503), '5xx');
    assert.equal(statusClass(0), null);
  });
});

describe('parse', () => {
  it('reads an http tick and rejects a wrong histogram', () => {
    const message = tick(2000, side([5, 7]));
    assert.deepEqual(parseStreamMessage(JSON.parse(JSON.stringify(message))), { ok: true, value: message });
    const bad = { ...message, server: { ...message.server, histogram: [1] } };
    assert.deepEqual(parseStreamMessage(bad), { ok: false, error: `$.server.histogram: expected ${HTTP_BUCKET_COUNT} buckets` });
  });
});

describe('analyzeHttp', () => {
  it('finds error spikes, slow tails and stuck requests, per side', () => {
    const insights = analyzeHttp([
      tick(1000, side(Array<number>(30).fill(5))),
      tick(2000, side(Array<number>(30).fill(5), { statuses: { '1xx': 0, '2xx': 25, '3xx': 0, '4xx': 0, '5xx': 5 } })),
      tick(3000, emptySide(), side(Array<number>(30).fill(1800))),
      tick(4000, side([5], { stuck: [{ route: 'GET /export', ageMs: 12_000 }, { route: 'GET /x', ageMs: 2000 }] })),
    ]);
    assert.deepEqual(
      insights.map((i) => [i.kind, 'side' in i ? i.side : '', 't' in i ? i.t : 0]),
      [
        ['http-errors', 'server', 2000],
        ['http-slow', 'client', 3000],
        ['http-stuck', 'server', 4000],
      ],
    );
    const stuck = insights[2];
    assert.ok(stuck);
    assert.equal(describeInsight(stuck, 0), '1 incoming request(s) running over 12.00 s, oldest GET /export at +4.00 s');
  });

  it('does not judge a rate from a handful of requests', () => {
    assert.deepEqual(analyzeHttp([tick(1000, side([5, 5], { failed: 2 }))]), []);
  });
});

describe('summarizeHttp and the report', () => {
  it('adds ticks up, ranks routes by total time and keeps the slowest examples', () => {
    const a = side([10, 20], {
      routes: [
        { key: 'GET /users/:id', count: 2, errors: 0, totalMs: 30, maxMs: 20 },
        { key: 'POST /orders', count: 1, errors: 1, totalMs: 5, maxMs: 5 },
      ],
      slowest: [{ route: 'GET /users/:id', status: 200, ms: 20 }],
    });
    const b = side([300], { routes: [{ key: 'GET /report', count: 1, errors: 0, totalMs: 300, maxMs: 300 }], slowest: [{ route: 'GET /report', status: 200, ms: 300 }] });
    const summary = summarizeHttp([tick(1000, a), tick(2000, b)], 'server');
    assert.ok(summary);
    assert.equal(summary.requests, 3);
    assert.equal(summary.rps, 1.5);
    assert.deepEqual(summary.routes.map((r) => r.key), ['GET /report', 'GET /users/:id', 'POST /orders']);
    assert.equal(summary.slowest[0]?.route, 'GET /report');
    assert.equal(summarizeHttp([tick(1000, a)], 'client'), null);

    const timeline = new Timeline();
    timeline.apply(hello);
    timeline.apply(tick(1000, a));
    assert.equal(buildReport(timeline)?.http.server?.requests, 2);
    assert.equal(buildReport(timeline)?.http.client, null);
  });
});
