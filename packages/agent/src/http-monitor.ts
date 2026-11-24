// HTTP in and out, from Node's diagnostics channels: no patching, no async_hooks. Subscribers run
// on the request path of the application, so they only note times; the tick aggregates.

import dc from 'node:diagnostics_channel';
import {
  bucketOf,
  HTTP_BUCKET_COUNT,
  normalizeRoute,
  statusClass,
  type HttpExample,
  type HttpMessage,
  type HttpRoute,
  type HttpSide,
  type HttpStuck,
  type StatusClass,
} from '@node-xray/core';
import type { SelfWork } from './self.js';

/** Routes kept per tick; the rest are counted under `(other)` so cardinality stays bounded. */
const MAX_ROUTES = 100;
const EXAMPLES = 5;
const STUCK_AFTER_MS = 1000;
const ROUTE_CACHE = 2000;
const HOST_CACHE = 256;
/** Requests ended in one tick whose route is worked out on the tick; beyond this, right away. */
const MAX_ENDED = 10_000;

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export interface RequestStart {
  readonly start: number;
  readonly method: string;
  /** Host (client side only). */
  readonly host: string;
  /** Raw path with query. */
  readonly path: string;
}

export interface Outcome {
  /** 0 = failed without a response. */
  readonly status: number;
  /** Route pattern the framework matched (Express `req.route.path`), relative to `base`. */
  readonly pattern?: string | undefined;
  /** Mount path of the router that matched (`req.baseUrl`). */
  readonly base?: string | undefined;
}

/** A request from start to the tick that counts it; the end fields are set when it ends. */
interface Running extends RequestStart {
  status: number;
  ms: number;
  pattern: string | null;
  base: string;
}

/** One direction (served or made): counters for the tick plus what is running now. */
export class HttpSideAggregator {
  readonly running = new Map<object, Running>();
  #started = 0;
  #finished = 0;
  #failed = 0;
  #statuses: Record<StatusClass, number> = { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  #histogram = new Array<number>(HTTP_BUCKET_COUNT).fill(0);
  #maxMs = 0;
  #routes = new Map<string, { count: number; errors: number; totalMs: number; maxMs: number }>();
  #slowest: HttpExample[] = [];
  readonly #routeCache = new Map<string, string>();
  /** Ended this tick, waiting for their route key. */
  readonly #ended: Running[] = [];

  begin(key: object, request: RequestStart): void {
    this.#started++;
    this.running.set(key, { start: request.start, method: request.method, host: request.host, path: request.path, status: 0, ms: 0, pattern: null, base: '' });
  }

  /**
   * Called on the application's request path: only numbers here. Route keys (string work and
   * route normalisation) are built on the tick.
   */
  end(key: object, now: number, outcome: Outcome): void {
    const running = this.running.get(key);
    if (running === undefined) return;
    this.running.delete(key);
    const status = outcome.status;
    const ms = now - running.start;
    running.status = status;
    running.ms = ms;
    running.pattern = outcome.pattern ?? null;
    running.base = outcome.base ?? '';
    if (status === 0) this.#failed++;
    else {
      this.#finished++;
      const cls = statusClass(status);
      if (cls !== null) this.#statuses[cls]++;
      const bucket = bucketOf(ms);
      this.#histogram[bucket] = (this.#histogram[bucket] ?? 0) + 1;
      if (ms > this.#maxMs) this.#maxMs = ms;
    }
    if (this.#ended.length < MAX_ENDED) this.#ended.push(running);
    else this.#route(running);
  }

  #route(ended: Running): void {
    const { status, ms } = ended;
    const route = this.#routeKey(ended, ended.pattern === null ? undefined : `${ended.base}${ended.pattern}` || '/');
    const errored = status === 0 || status >= 500;
    let entry = this.#routes.get(route);
    if (entry === undefined) {
      const key = this.#routes.size < MAX_ROUTES ? route : '(other)';
      entry = this.#routes.get(key) ?? { count: 0, errors: 0, totalMs: 0, maxMs: 0 };
      this.#routes.set(key, entry);
    }
    entry.count++;
    if (errored) entry.errors++;
    entry.totalMs += ms;
    if (ms > entry.maxMs) entry.maxMs = ms;

    if (this.#slowest.length < EXAMPLES || ms > (this.#slowest[this.#slowest.length - 1] as HttpExample).ms) {
      this.#slowest.push({ route, status, ms });
      this.#slowest.sort((a, b) => b.ms - a.ms);
      if (this.#slowest.length > EXAMPLES) this.#slowest.pop();
    }
  }

  /** Requests that ended without a finish event (socket destroyed, aborted): counted as failed. */
  sweep(isGone: (key: object) => boolean, now: number): void {
    for (const key of [...this.running.keys()]) if (isGone(key)) this.end(key, now, { status: 0 });
  }

  /** The tick's numbers; counters start over, running requests carry on. */
  snapshot(now: number): HttpSide {
    for (const ended of this.#ended) this.#route(ended);
    this.#ended.length = 0;
    const stuck: HttpStuck[] = [];
    for (const running of this.running.values()) {
      const ageMs = now - running.start;
      if (ageMs >= STUCK_AFTER_MS) stuck.push({ route: this.#routeKey(running), ageMs });
    }
    stuck.sort((a, b) => b.ageMs - a.ageMs);
    const routes: HttpRoute[] = [];
    for (const [key, r] of this.#routes) routes.push({ key, count: r.count, errors: r.errors, totalMs: r.totalMs, maxMs: r.maxMs });
    const side: HttpSide = {
      started: this.#started,
      finished: this.#finished,
      failed: this.#failed,
      inFlight: this.running.size,
      statuses: this.#statuses,
      histogram: this.#histogram,
      maxMs: this.#maxMs,
      routes,
      slowest: this.#slowest,
      stuck: stuck.slice(0, EXAMPLES),
    };
    this.#started = 0;
    this.#finished = 0;
    this.#failed = 0;
    this.#statuses = { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
    this.#histogram = new Array<number>(HTTP_BUCKET_COUNT).fill(0);
    this.#maxMs = 0;
    this.#routes = new Map();
    this.#slowest = [];
    return side;
  }

  #routeKey(running: RequestStart, override?: string): string {
    const query = running.path.indexOf('?');
    const bare = query === -1 ? running.path : running.path.slice(0, query);
    let route = override;
    if (route === undefined) {
      route = this.#routeCache.get(bare);
      if (route === undefined) {
        route = normalizeRoute(bare);
        if (this.#routeCache.size >= ROUTE_CACHE) this.#routeCache.clear();
        this.#routeCache.set(bare, route);
      }
    }
    return running.host === '' ? `${running.method} ${route}` : `${running.method} ${running.host} ${route}`;
  }
}

/** Express sets `req.route.path` (relative to `req.baseUrl`) once routing matched. */
function routeOutcome(request: unknown, status: number): Outcome {
  const pattern = field(field(request, 'route'), 'path');
  if (typeof pattern !== 'string') return { status };
  return { status, pattern, base: text(field(request, 'baseUrl')) };
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export interface HttpMonitorDeps {
  readonly self: SelfWork;
  readonly send: (message: HttpMessage) => void;
  readonly now: () => number;
  readonly timeOrigin: number;
  readonly intervalMs: number;
}

/** `at`: `now()` when the message arrived. */
type Handler = (message: unknown, at: number) => void;

export class HttpMonitor {
  readonly server = new HttpSideAggregator();
  readonly client = new HttpSideAggregator();
  #subscriptions: Array<[string, (message: unknown, name: string | symbol) => void]> = [];
  #timer: NodeJS.Timeout | null = null;
  #lastTick = 0;
  /** fetch() origin → host: `new URL` on every request would be the costliest step of a subscriber. */
  readonly #hosts = new Map<string, string>();
  /** Nothing is sent until the process has done any HTTP: no empty ticks from a CLI tool. */
  #active = false;

  constructor(private readonly deps: HttpMonitorDeps) {}

  start(): void {
    const { self, now } = this.deps;
    const on = (name: string, handler: Handler): void => {
      const listener = (message: unknown): void => {
        const at = now();
        // A throwing subscriber surfaces as an uncaught exception in the application.
        try {
          this.#active = true;
          handler(message, at);
        } catch (error) {
          self.report(error);
        }
        self.addOverhead((now() - at) * 1000);
      };
      dc.subscribe(name, listener);
      this.#subscriptions.push([name, listener]);
    };

    on('http.server.request.start', (m, at) => {
      const request = field(m, 'request');
      const response = field(m, 'response');
      if (typeof response !== 'object' || response === null) return;
      this.server.begin(response, { start: at, method: text(field(request, 'method'), 'GET'), host: '', path: text(field(request, 'url'), '/') });
    });
    on('http.server.response.finish', (m, at) => {
      const response = field(m, 'response');
      if (typeof response !== 'object' || response === null) return;
      const status = field(response, 'statusCode');
      this.server.end(response, at, routeOutcome(field(m, 'request'), typeof status === 'number' ? status : 200));
    });

    on('http.client.request.start', (m, at) => {
      const request = field(m, 'request');
      if (typeof request !== 'object' || request === null) return;
      this.client.begin(request, { start: at, method: text(field(request, 'method'), 'GET'), host: text(field(request, 'host')), path: text(field(request, 'path'), '/') });
    });
    on('http.client.response.finish', (m, at) => {
      const request = field(m, 'request');
      const status = field(field(m, 'response'), 'statusCode');
      if (typeof request === 'object' && request !== null) this.client.end(request, at, { status: typeof status === 'number' ? status : 200 });
    });
    on('http.client.request.error', (m, at) => {
      const request = field(m, 'request');
      if (typeof request === 'object' && request !== null) this.client.end(request, at, { status: 0 });
    });

    // fetch() is undici, which has its own channels. Its requests are timed to the response
    // headers: `trailers` only comes once the body is read, and many callers never read it.
    on('undici:request:create', (m, at) => {
      const request = field(m, 'request');
      if (typeof request !== 'object' || request === null) return;
      this.client.begin(request, { start: at, method: text(field(request, 'method'), 'GET'), host: this.#host(text(field(request, 'origin'))), path: text(field(request, 'path'), '/') });
    });
    on('undici:request:headers', (m, at) => {
      const request = field(m, 'request');
      const status = field(field(m, 'response'), 'statusCode');
      if (typeof request === 'object' && request !== null) this.client.end(request, at, { status: typeof status === 'number' ? status : 200 });
    });
    on('undici:request:error', (m, at) => {
      const request = field(m, 'request');
      if (typeof request === 'object' && request !== null) this.client.end(request, at, { status: 0 });
    });

    this.#lastTick = now();
    this.#timer = self.own(setInterval(() => self.run(() => this.tick()), this.deps.intervalMs).unref());
  }

  stop(): void {
    for (const [name, listener] of this.#subscriptions) dc.unsubscribe(name, listener);
    this.#subscriptions = [];
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Sends the tick (also called once on exit). */
  tick(): void {
    if (!this.#active) return;
    const started = this.deps.now();
    // A response or request object destroyed without finishing was aborted.
    const gone = (key: object): boolean => field(key, 'destroyed') === true;
    this.server.sweep(gone, started);
    this.client.sweep(gone, started);
    this.deps.send({
      type: 'http',
      start: this.deps.timeOrigin + this.#lastTick,
      end: this.deps.timeOrigin + started,
      server: this.server.snapshot(started),
      client: this.client.snapshot(started),
    });
    this.#lastTick = started;
  }

  #host(origin: string): string {
    let host = this.#hosts.get(origin);
    if (host === undefined) {
      host = hostOf(origin);
      if (this.#hosts.size >= HOST_CACHE) this.#hosts.clear();
      this.#hosts.set(origin, host);
    }
    return host;
  }
}
