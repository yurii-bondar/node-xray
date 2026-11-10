// HTTP traffic per tick, from `diagnostics_channel` in the agent: requests the process serves
// (server) and requests it makes (client: `http.request`, `fetch`). The agent aggregates per tick
// (counts, a latency histogram, a bounded route table, a few examples); everything else is here.

import { Fields, ProtocolError } from './guard.js';

/** Upper bounds of the latency buckets, ms; one more bucket holds everything slower. */
/** Fine at the bottom: a fast handler takes microseconds, and the first bucket bounds how well its median reads. */
export const HTTP_BUCKETS_MS: readonly number[] = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000];

export const HTTP_BUCKET_COUNT = HTTP_BUCKETS_MS.length + 1;

export function bucketOf(ms: number): number {
  for (let i = 0; i < HTTP_BUCKETS_MS.length; i++) if (ms <= (HTTP_BUCKETS_MS[i] as number)) return i;
  return HTTP_BUCKETS_MS.length;
}

export type StatusClass = '1xx' | '2xx' | '3xx' | '4xx' | '5xx';

export const STATUS_CLASSES: readonly StatusClass[] = ['1xx', '2xx', '3xx', '4xx', '5xx'];

export function statusClass(status: number): StatusClass | null {
  const hundred = Math.floor(status / 100);
  return hundred >= 1 && hundred <= 5 ? (`${hundred}xx` as StatusClass) : null;
}

const NUMERIC = /^\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{12,}$/i;
const TOKEN = /^(?=.*\d)[A-Za-z0-9_-]{20,}$/;
const MAX_SEGMENTS = 6;

/**
 * `/users/42/orders/9f86d081-…?page=2` → `/users/:id/orders/:id`. Keeps the route table small
 * however many distinct URLs a service sees: ids, UUIDs, hashes and tokens collapse.
 */
export function normalizeRoute(path: string): string {
  const end = path.search(/[?#]/);
  const bare = end === -1 ? path : path.slice(0, end);
  const segments = bare.split('/').filter((s) => s !== '');
  const kept = segments.slice(0, MAX_SEGMENTS).map((s) => (NUMERIC.test(s) || UUID.test(s) || HEX.test(s) || TOKEN.test(s) ? ':id' : s));
  return `/${kept.join('/')}${segments.length > MAX_SEGMENTS ? '/…' : ''}`;
}

export interface HttpRoute {
  /** `GET /users/:id` (server) or `GET api.example.com /v1/charges` (client). */
  readonly key: string;
  readonly count: number;
  /** 5xx answers, aborted requests and network errors. */
  readonly errors: number;
  readonly totalMs: number;
  readonly maxMs: number;
}

export interface HttpExample {
  readonly route: string;
  /** 0 when the request failed or was aborted before a status. */
  readonly status: number;
  readonly ms: number;
}

export interface HttpStuck {
  readonly route: string;
  /** How long it has been running when the tick was taken. */
  readonly ageMs: number;
}

export interface HttpSide {
  readonly started: number;
  readonly finished: number;
  /** Aborted (client went away, socket destroyed) or network errors, without a response. */
  readonly failed: number;
  /** Running when the tick was taken. */
  readonly inFlight: number;
  readonly statuses: Readonly<Record<StatusClass, number>>;
  /** Finished requests per latency bucket (`HTTP_BUCKETS_MS`), `HTTP_BUCKET_COUNT` long. */
  readonly histogram: readonly number[];
  readonly maxMs: number;
  /** The tick's routes (bounded; the rest are counted under `(other)`). */
  readonly routes: readonly HttpRoute[];
  /** Slowest finished requests of the tick. */
  readonly slowest: readonly HttpExample[];
  /** Oldest requests still running, at least a second old. */
  readonly stuck: readonly HttpStuck[];
}

export interface HttpMessage {
  readonly type: 'http';
  /** Epoch ms of the tick. */
  readonly start: number;
  readonly end: number;
  readonly server: HttpSide;
  readonly client: HttpSide;
}

export function emptySide(): HttpSide {
  return {
    started: 0,
    finished: 0,
    failed: 0,
    inFlight: 0,
    statuses: { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
    histogram: new Array<number>(HTTP_BUCKET_COUNT).fill(0),
    maxMs: 0,
    routes: [],
    slowest: [],
    stuck: [],
  };
}

function parseSide(value: unknown, path: string): HttpSide {
  const f = Fields.of(value, path);
  const statuses = f.fields('statuses');
  const histogram = f.numbers('histogram');
  if (histogram.length !== HTTP_BUCKET_COUNT) throw new ProtocolError(f.at('histogram'), `${HTTP_BUCKET_COUNT} buckets`);
  return {
    started: f.number('started'),
    finished: f.number('finished'),
    failed: f.number('failed'),
    inFlight: f.number('inFlight'),
    statuses: {
      '1xx': statuses.numberOr('1xx', 0),
      '2xx': statuses.numberOr('2xx', 0),
      '3xx': statuses.numberOr('3xx', 0),
      '4xx': statuses.numberOr('4xx', 0),
      '5xx': statuses.numberOr('5xx', 0),
    },
    histogram,
    maxMs: f.number('maxMs'),
    routes: f.list('routes', (v, p) => {
      const r = Fields.of(v, p);
      return { key: r.string('key'), count: r.number('count'), errors: r.number('errors'), totalMs: r.number('totalMs'), maxMs: r.number('maxMs') };
    }),
    slowest: f.list('slowest', (v, p) => {
      const r = Fields.of(v, p);
      return { route: r.string('route'), status: r.number('status'), ms: r.number('ms') };
    }),
    stuck: f.list('stuck', (v, p) => {
      const r = Fields.of(v, p);
      return { route: r.string('route'), ageMs: r.number('ageMs') };
    }),
  };
}

export function parseHttp(f: Fields): HttpMessage {
  return { type: 'http', start: f.number('start'), end: f.number('end'), server: f.read('server', parseSide), client: f.read('client', parseSide) };
}

/** Latency at percentile `p` (0..100) from bucket counts: linear inside the bucket, `max` caps the last one. */
export function histogramPercentile(counts: readonly number[], p: number, max: number): number {
  let total = 0;
  for (const c of counts) total += c;
  if (total === 0) return 0;
  const rank = (p / 100) * total;
  let seen = 0;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i] as number;
    if (c === 0) continue;
    if (seen + c >= rank) {
      const low = i === 0 ? 0 : (HTTP_BUCKETS_MS[i - 1] as number);
      const high = Math.min(HTTP_BUCKETS_MS[i] ?? max, Math.max(max, low));
      return low + ((rank - seen) / c) * (high - low);
    }
    seen += c;
  }
  return max;
}

export interface HttpRates {
  readonly t: number;
  /** Finished requests per second. */
  readonly rps: number;
  /** (5xx + failed) / (finished + failed), 0..1. */
  readonly errorRate: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly max: number;
  readonly inFlight: number;
}

export function httpRates(side: HttpSide, window: { readonly start: number; readonly end: number }): HttpRates {
  const seconds = Math.max(0.001, (window.end - window.start) / 1000);
  const done = side.finished + side.failed;
  return {
    t: window.end,
    rps: side.finished / seconds,
    errorRate: done > 0 ? (side.statuses['5xx'] + side.failed) / done : 0,
    p50: histogramPercentile(side.histogram, 50, side.maxMs),
    p90: histogramPercentile(side.histogram, 90, side.maxMs),
    p99: histogramPercentile(side.histogram, 99, side.maxMs),
    max: side.maxMs,
    inFlight: side.inFlight,
  };
}

export interface HttpSummary {
  readonly requests: number;
  readonly failed: number;
  readonly errorRate: number;
  readonly rps: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly max: number;
  readonly statuses: Readonly<Record<StatusClass, number>>;
  /** By total time spent, heaviest first. */
  readonly routes: readonly HttpRoute[];
  readonly slowest: readonly HttpExample[];
}

/** Several ticks of one side added up; null when nothing happened on that side. */
export function summarizeHttp(windows: readonly HttpMessage[], side: 'server' | 'client', limit = 10): HttpSummary | null {
  const histogram = new Array<number>(HTTP_BUCKET_COUNT).fill(0);
  const statuses: Record<StatusClass, number> = { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  const routes = new Map<string, { key: string; count: number; errors: number; totalMs: number; maxMs: number }>();
  const slowest: HttpExample[] = [];
  let requests = 0;
  let failed = 0;
  let max = 0;
  let start = Number.POSITIVE_INFINITY;
  let end = 0;
  for (const window of windows) {
    const s = window[side];
    start = Math.min(start, window.start);
    end = Math.max(end, window.end);
    requests += s.finished;
    failed += s.failed;
    max = Math.max(max, s.maxMs);
    s.histogram.forEach((c, i) => (histogram[i] = (histogram[i] ?? 0) + c));
    for (const c of STATUS_CLASSES) statuses[c] += s.statuses[c];
    for (const r of s.routes) {
      const entry = routes.get(r.key) ?? { key: r.key, count: 0, errors: 0, totalMs: 0, maxMs: 0 };
      entry.count += r.count;
      entry.errors += r.errors;
      entry.totalMs += r.totalMs;
      entry.maxMs = Math.max(entry.maxMs, r.maxMs);
      routes.set(r.key, entry);
    }
    slowest.push(...s.slowest);
  }
  if (requests + failed === 0) return null;
  slowest.sort((a, b) => b.ms - a.ms);
  const seconds = Math.max(0.001, (end - start) / 1000);
  return {
    requests,
    failed,
    errorRate: (statuses['5xx'] + failed) / (requests + failed),
    rps: requests / seconds,
    p50: histogramPercentile(histogram, 50, max),
    p90: histogramPercentile(histogram, 90, max),
    p99: histogramPercentile(histogram, 99, max),
    max,
    statuses,
    routes: [...routes.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, limit),
    slowest: slowest.slice(0, limit),
  };
}
