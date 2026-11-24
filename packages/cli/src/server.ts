// Local HTTP server for the dashboard: static files, an SSE stream of records, commands.
// Binds 127.0.0.1 only. The inspector behind the agents runs arbitrary code, so every
// /api request needs the per-run token, and Host must be ours (no DNS rebinding): a local
// name, or the one extra host a port forward uses (`XRAY_DASHBOARD_HOST`, see `parseExtraHost`).

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { encodeClosedRecord, encodeRecord, parseAgentCommand, positionKey, scriptPath, type AgentCommand, type Original, type SourceId, type SourcePosition } from '@node-xray/core';
import { Backlog } from './backlog.js';
import type { Collector } from './collector.js';
import { exportProfile, type ProfileKind } from './profiles.js';
import type { SourceMapResolver } from './sourcemaps.js';

/** What the dashboard shows about the launched command. */
export type RunStatus =
  | { readonly state: 'running'; readonly command: string }
  | { readonly state: 'exited'; readonly command: string; readonly code: number }
  /** `attach`: the agent was removed; the process itself carries on. */
  | { readonly state: 'detached'; readonly command: string }
  /** `replay`: a recording, nothing is live. */
  | { readonly state: 'replay'; readonly command: string };

const STATIC: Readonly<Record<string, string>> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/app.js.map': 'app.js.map',
  '/app.css': 'app.css',
  '/uplot.css': 'uplot.css',
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const MAX_BODY_BYTES = 64 * 1024;
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** Positions per /api/resolve request. */
const MAX_POSITIONS = 500;
/** Live data a browser tab may fall behind by before it is dropped; it reconnects and gets the backlog. */
const MAX_CLIENT_BUFFER = 32 * 1024 * 1024;
/** The backlog goes out in writes of about this size, each after the previous one drained. */
const BACKLOG_WRITE = 64 * 1024;

export interface DashboardServerOptions {
  readonly collector: Collector;
  readonly resolver: SourceMapResolver;
  /** Built dashboard files (`@node-xray/dashboard/dist`). */
  readonly staticDir: string;
  /** 0 picks a free port. */
  readonly port: number;
  readonly status: RunStatus;
  /** Use this token instead of a random one (at least 16 URL-safe characters); null = random. */
  readonly token: string | null;
  /** One more Host the dashboard answers to besides the local names; null = none. */
  readonly extraHost: ExtraHost | null;
  /** `MAX_CLIENT_BUFFER` unless a test needs a small one. */
  readonly maxClientBuffer?: number;
}

/** A Host header value other than the local names, e.g. a forwarded port's `*.app.github.dev`. */
export interface ExtraHost {
  /** Lower case. */
  readonly name: string;
  /** Null: any port (or none), as for the local names. */
  readonly port: string | null;
}

const HOST_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * `XRAY_DASHBOARD_HOST`: opt-in, for a dashboard reached through a port forward (VS Code remote,
 * Codespaces) whose browser sends another Host. One exact `host` or `host:port`, no wildcards;
 * the token stays mandatory. Null when the value is not one.
 */
export function parseExtraHost(value: string): ExtraHost | null {
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(value.trim().toLowerCase());
  const name = match?.[1];
  const port = match?.[2];
  if (name === undefined || name.length > 253 || !HOST_NAME.test(name)) return null;
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return null;
  return { name, port: port === undefined ? null : String(Number(port)) };
}

/** Whether a Host header names this server: a local name, or the extra host. */
export function hostAllowed(header: string, extra: ExtraHost | null): boolean {
  const host = header.toLowerCase();
  const name = host.replace(/:\d+$/, '');
  if (LOCAL_HOSTS.has(name)) return true;
  if (extra === null || name !== extra.name) return false;
  return extra.port === null || host === `${name}:${extra.port}`;
}

/** One `/api/stream` reader. */
interface Client {
  readonly res: http.ServerResponse;
  /** Live chunks held back while the backlog is still going out; null once it is through. */
  queue: string[] | null;
  queued: number;
}

/** Writes and resolves once the response can take more: true, or false when it closed first. */
function write(res: http.ServerResponse, chunk: string): Promise<boolean> {
  if (res.destroyed) return Promise.resolve(false);
  if (res.write(chunk)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const settle = (ok: boolean): void => {
      res.off('drain', drained);
      res.off('close', closed);
      resolve(ok);
    };
    const drained = (): void => settle(true);
    const closed = (): void => settle(false);
    res.on('drain', drained);
    res.on('close', closed);
  });
}

export interface CommandRequest {
  readonly target: SourceId | null;
  readonly command: AgentCommand;
}

/** `{ "target": "4242:0" | null, "command": { ... } }` */
export function parseCommandRequest(value: unknown): CommandRequest | { readonly error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: 'expected an object' };
  const target: unknown = Reflect.get(value, 'target');
  if (target !== null && (typeof target !== 'string' || !/^\d+:\d+$/.test(target))) return { error: 'target: expected "pid:threadId" or null' };
  const command = parseAgentCommand(Reflect.get(value, 'command'));
  if (!command.ok) return { error: `command: ${command.error}` };
  return { target: target as SourceId | null, command: command.value };
}

/** `{ "positions": [{ "url", "line", "column" }] }` → positions; null when malformed. */
export function parseResolveRequest(value: unknown): SourcePosition[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const positions: unknown = Reflect.get(value, 'positions');
  if (!Array.isArray(positions) || positions.length > MAX_POSITIONS) return null;
  const out: SourcePosition[] = [];
  for (const item of positions as unknown[]) {
    if (typeof item !== 'object' || item === null) return null;
    const url: unknown = Reflect.get(item, 'url');
    const line: unknown = Reflect.get(item, 'line');
    const column: unknown = Reflect.get(item, 'column');
    if (typeof url !== 'string' || typeof line !== 'number' || typeof column !== 'number') return null;
    out.push({ url, line, column });
  }
  return out;
}

function sameToken(given: string | null, token: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class DashboardServer {
  readonly token: string;
  readonly #server: http.Server;
  readonly #clients = new Set<Client>();
  readonly #backlog = new Backlog();
  readonly #files = new Map<string, Buffer>();
  readonly #unsubscribe: () => void;
  readonly #maxClientBuffer: number;
  #status: RunStatus;
  #port = 0;

  constructor(private readonly options: DashboardServerOptions) {
    this.token = options.token !== null && /^[A-Za-z0-9_-]{16,}$/.test(options.token) ? options.token : randomBytes(18).toString('base64url');
    this.#status = options.status;
    this.#maxClientBuffer = options.maxClientBuffer ?? MAX_CLIENT_BUFFER;
    this.#server = http.createServer((req, res) => {
      this.#handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    this.#unsubscribe = options.collector.onRecord({
      record: (connection, raw, message) => {
        this.#backlog.add(connection, raw, message);
        this.#broadcast(`data: ${encodeRecord(connection, raw)}\n\n`);
      },
      closed: (connection) => {
        this.#backlog.closed(connection);
        this.#broadcast(`data: ${encodeClosedRecord(connection)}\n\n`);
      },
      dropped: (connection) => this.#backlog.drop(connection),
    });
  }

  /** Resolves to the URL to open (with the token). */
  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.options.port, '127.0.0.1', () => {
        this.#server.off('error', reject);
        resolve();
      });
    });
    this.#port = (this.#server.address() as AddressInfo).port;
    return `http://127.0.0.1:${this.#port}/?token=${this.token}`;
  }

  setStatus(status: RunStatus): void {
    this.#status = status;
    this.#broadcast(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
  }

  async close(): Promise<void> {
    this.#unsubscribe();
    for (const client of this.#clients) client.res.end();
    this.#clients.clear();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #broadcast(chunk: string): void {
    for (const client of this.#clients) {
      if (client.queue !== null) {
        client.queue.push(chunk);
        client.queued += chunk.length;
        if (client.queued > this.#maxClientBuffer) this.#drop(client);
        continue;
      }
      if (client.res.writableLength > this.#maxClientBuffer) {
        this.#drop(client);
        continue;
      }
      client.res.write(chunk);
    }
  }

  #drop(client: Client): void {
    client.res.destroy();
    this.#clients.delete(client);
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // DNS rebinding sends another host name; the port may differ behind a forward (VS Code remote).
    const host = req.headers.host ?? '';
    if (!hostAllowed(host, this.options.extraHost)) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (url.pathname.startsWith('/api/')) {
      if (!sameToken(url.searchParams.get('token'), this.token)) {
        res.writeHead(401).end();
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/stream') return this.#stream(res);
      if (req.method === 'POST' && url.pathname === '/api/command') return this.#command(req, res);
      if (req.method === 'POST' && url.pathname === '/api/resolve') return this.#resolve(req, res);
      if (req.method === 'GET' && url.pathname === '/api/export') return this.#export(url, res);
      if (req.method === 'GET' && url.pathname === '/api/lines') return this.#lines(res);
      if (req.method === 'GET' && url.pathname === '/api/status') return this.#statusOf(res);
      res.writeHead(404).end();
      return;
    }
    const file = STATIC[url.pathname];
    if (req.method !== 'GET' || file === undefined) {
      res.writeHead(404).end();
      return;
    }
    let body = this.#files.get(file);
    if (body === undefined) {
      body = await readFile(path.join(this.options.staticDir, file));
      this.#files.set(file, body);
    }
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
    });
    res.end(body);
  }

  #stream(res: http.ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const client: Client = { res, queue: [], queued: 0 };
    this.#clients.add(client);
    res.on('close', () => this.#clients.delete(client));
    this.#catchUp(client).catch(() => this.#drop(client));
  }

  /**
   * The backlog (up to tens of MB after a long run with --cpu --trace-loop) in pieces, each after
   * the previous one drained, never as one string; then the live chunks that arrived meanwhile.
   * Only after that does the client get live data directly, under `maxClientBuffer`.
   */
  async #catchUp(client: Client): Promise<void> {
    let chunk = `retry: 2000\n\nevent: reset\ndata: {}\n\nevent: status\ndata: ${JSON.stringify(this.#status)}\n\n`;
    for (const record of this.#backlog.records()) {
      chunk += `data: ${record}\n\n`;
      if (chunk.length < BACKLOG_WRITE) continue;
      if (!(await write(client.res, chunk))) return;
      chunk = '';
    }
    if (chunk !== '' && !(await write(client.res, chunk))) return;
    while (client.queue !== null && client.queue.length > 0) {
      const queued = client.queue.join('');
      client.queue = [];
      client.queued = 0;
      if (!(await write(client.res, queued))) return;
    }
    client.queue = null;
  }

  /** What the SSE `status` event says, for a client that does not stream (the VS Code extension). */
  #statusOf(res: http.ServerResponse): void {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(this.#status));
  }

  /** The JSON body, or undefined after answering 415 / 413 / 400 itself. */
  async #jsonBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<{ value: unknown } | undefined> {
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
      res.writeHead(415).end();
      return undefined;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        return undefined;
      }
      chunks.push(buffer);
    }
    try {
      return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown };
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'body is not JSON' }));
      return undefined;
    }
  }

  async #resolve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.#jsonBody(req, res);
    if (body === undefined) return;
    const positions = parseResolveRequest(body.value);
    if (positions === null) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `expected { positions: [{ url, line, column }] } (at most ${MAX_POSITIONS})` }));
      return;
    }
    const resolved = await this.options.resolver.resolveAll(positions);
    const originals: Record<string, Original> = {};
    for (const position of positions) {
      const original = resolved.get(positionKey(position));
      if (original !== undefined) originals[positionKey(position)] = original;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ originals }));
  }

  /** CPU samples per line of every process, on local files (source-mapped when possible): for editor decorations. */
  async #lines(res: http.ServerResponse): Promise<void> {
    const entries: Array<{ position: SourcePosition; ticks: number }> = [];
    let work = 0;
    for (const source of this.options.collector.sources.values()) {
      const lines = source.timeline.hotLines();
      work += lines.work;
      for (const [url, byLine] of lines.files) for (const [line, ticks] of byLine) entries.push({ position: { url, line, column: 1 }, ticks });
    }
    const originals = await this.options.resolver.resolveAll(entries.map((e) => e.position));
    const files = new Map<string, Map<number, number>>();
    for (const { position, ticks } of entries) {
      const original = originals.get(positionKey(position));
      const file = original?.file ?? scriptPath(position.url);
      if (!path.isAbsolute(file)) continue;
      const line = original?.line ?? position.line;
      const byLine = files.get(file) ?? new Map<number, number>();
      byLine.set(line, (byLine.get(line) ?? 0) + ticks);
      files.set(file, byLine);
    }
    const body = { work, files: [...files].map(([file, byLine]) => ({ file, lines: [...byLine] })) };
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
  }

  #export(url: URL, res: http.ServerResponse): void {
    const kind = url.searchParams.get('kind');
    const source = this.options.collector.sources.get((url.searchParams.get('source') ?? '') as SourceId);
    if ((kind !== 'cpu' && kind !== 'heap') || source === undefined) {
      res.writeHead(404).end();
      return;
    }
    const file = exportProfile(source.timeline, kind satisfies ProfileKind);
    if (file === null) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end(kind === 'cpu' ? 'no CPU profile yet' : 'no allocation profile yet');
      return;
    }
    res
      .writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${file.fileName}"`, 'cache-control': 'no-store' })
      .end(file.json);
  }

  async #command(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.#jsonBody(req, res);
    if (body === undefined) return;
    const request = parseCommandRequest(body.value);
    if ('error' in request) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: request.error }));
      return;
    }
    const sent = this.options.collector.send(request.target, request.command);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sent }));
  }
}
