import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { decodeStreamMessage, encodeLine, LineDecoder, type StreamMessage } from '@node-xray/core';
import { Backlog } from '../src/backlog.js';
import { Collector, MAX_ENDED_SOURCES } from '../src/collector.js';
import { DashboardServer, hostAllowed, parseCommandRequest, parseExtraHost, parseResolveRequest } from '../src/server.js';
import { SourceMapResolver } from '../src/sourcemaps.js';

const hello = {
  type: 'hello',
  protocol: 1,
  pid: 4242,
  threadId: 0,
  nodeVersion: 'v24.15.0',
  platform: 'linux',
  arch: 'x64',
  argv: ['node'],
  execArgv: [],
  timeOrigin: 0,
  intervalMs: 250,
  cpus: 4,
  totalMemory: 1,
  agentScript: '',
} as const;

function message(raw: string): StreamMessage {
  const parsed = decodeStreamMessage(raw);
  if (!parsed.ok) assert.fail(parsed.error);
  return parsed.value;
}

describe('Backlog', () => {
  it('replays hello first, keeps a bounded tail, and drops samples older than a new hello', () => {
    const backlog = new Backlog({ samples: 2 });
    const sample = (t: number): string => JSON.stringify({ type: 'agent-error', message: `s${t}` });
    const h = JSON.stringify(hello);
    backlog.add(1, h, message(h));
    for (const t of [1, 2, 3]) backlog.add(1, sample(t), message(sample(t)));
    assert.deepEqual(backlog.records().length, 4, 'errors have their own ring');
    const host = JSON.stringify({ type: 'host', t: 1, swap: null, gpus: [] });
    backlog.add(0, host, message(host));
    const records = backlog.records();
    assert.ok(records[0]?.startsWith('{"c":0,'), 'host first');
    assert.ok(records[1]?.includes('"hello"'));
  });

  it('marks ended connections and forgets dropped ones', () => {
    const backlog = new Backlog();
    const h = JSON.stringify(hello);
    backlog.add(1, h, message(h));
    backlog.add(2, h, message(h));
    backlog.closed(1);
    assert.deepEqual(backlog.records(), [`{"c":1,"m":${h}}`, '{"c":1,"closed":true}', `{"c":2,"m":${h}}`]);
    backlog.drop(1);
    assert.deepEqual(backlog.records(), [`{"c":2,"m":${h}}`]);
  });
});

describe('Collector', () => {
  it('keeps live sources and the most recent ended ones, and says how many it dropped', () => {
    const collector = new Collector({ startupCommands: [] });
    const events: string[] = [];
    collector.onRecord({ record: () => undefined, closed: (c) => events.push(`closed ${c}`), dropped: (c) => events.push(`dropped ${c}`) });
    const live = collector.open({ send: () => undefined, close: () => undefined });
    live.line(JSON.stringify({ ...hello, threadId: 100 }));
    const total = MAX_ENDED_SOURCES + 4;
    for (let i = 0; i < total; i++) {
      const link = collector.open({ send: () => undefined, close: () => undefined });
      link.line(JSON.stringify({ ...hello, threadId: i + 1 }));
      link.closed();
      link.closed(); // twice is once
    }
    assert.equal(collector.sources.size, MAX_ENDED_SOURCES + 1, 'the live one and the last ended ones');
    assert.ok(collector.sources.has('4242:100' as never));
    assert.ok(!collector.sources.has('4242:1' as never), 'the oldest ended one went first');
    assert.ok(collector.sources.has(`4242:${total}` as never));
    assert.equal(collector.droppedSources, 4);
    assert.equal(events.filter((e) => e.startsWith('closed')).length, total);
    assert.deepEqual(
      events.filter((e) => e.startsWith('dropped')),
      [2, 3, 4, 5].map((c) => `dropped ${c}`),
    );
  });
});

describe('dashboard Host check', () => {
  it('takes one exact extra host, validated', () => {
    assert.deepEqual(parseExtraHost('Xray-7000.app.github.dev'), { name: 'xray-7000.app.github.dev', port: null });
    assert.deepEqual(parseExtraHost('box.local:8443'), { name: 'box.local', port: '8443' });
    for (const bad of ['*.app.github.dev', 'a b', 'http://x.dev', 'x.dev:99999', 'x.dev:', '-x.dev', 'x..dev', 'x.dev/path', '']) {
      assert.equal(parseExtraHost(bad), null, bad);
    }
  });

  it('accepts local names on any port, and the extra host as given', () => {
    const extra = parseExtraHost('xray-7000.app.github.dev');
    const withPort = parseExtraHost('box.local:8443');
    assert.equal(hostAllowed('127.0.0.1:5000', null), true);
    assert.equal(hostAllowed('[::1]:5000', null), true);
    assert.equal(hostAllowed('xray-7000.app.github.dev', null), false);
    assert.equal(hostAllowed('XRAY-7000.app.github.dev', extra), true);
    assert.equal(hostAllowed('xray-7000.app.github.dev:443', extra), true);
    assert.equal(hostAllowed('evil-xray-7000.app.github.dev', extra), false);
    assert.equal(hostAllowed('xray-7000.app.github.dev.evil.com', extra), false);
    assert.equal(hostAllowed('box.local:8443', withPort), true);
    assert.equal(hostAllowed('box.local:8444', withPort), false);
    assert.equal(hostAllowed('box.local', withPort), false);
  });
});

describe('parseCommandRequest', () => {
  it('accepts a target and a valid command only', () => {
    assert.deepEqual(parseCommandRequest({ target: '4242:0', command: { type: 'loop-trace-stop' } }), { target: '4242:0', command: { type: 'loop-trace-stop' } });
    assert.deepEqual(parseCommandRequest({ target: null, command: { type: 'cpu-profile-stop' } }), { target: null, command: { type: 'cpu-profile-stop' } });
    assert.deepEqual(parseCommandRequest({ target: '../etc', command: { type: 'cpu-profile-stop' } }), { error: 'target: expected "pid:threadId" or null' });
    assert.deepEqual(parseCommandRequest({ target: null, command: { type: 'rm -rf' } }), { error: 'command: $.type: expected a known command' });
  });
});

describe('parseResolveRequest', () => {
  it('accepts a bounded list of positions', () => {
    assert.deepEqual(parseResolveRequest({ positions: [{ url: '/a.js', line: 1, column: 2 }] }), [{ url: '/a.js', line: 1, column: 2 }]);
    assert.equal(parseResolveRequest({ positions: [{ url: 1, line: 1, column: 2 }] }), null);
    assert.equal(parseResolveRequest({ positions: Array.from({ length: 501 }, () => ({ url: '/a.js', line: 1, column: 1 })) }), null);
    assert.equal(parseResolveRequest([]), null);
  });
});

describe('DashboardServer', () => {
  let dir = '';
  let collector: Collector;
  let server: DashboardServer;
  let base = '';
  let agent: net.Socket;
  const received: string[] = [];

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'xray-server-'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>xray</title>');
    collector = new Collector({ startupCommands: [] });
    const socketPath = path.join(dir, 'agent.sock');
    await collector.listen(socketPath);
    server = new DashboardServer({ collector, resolver: new SourceMapResolver(async () => ''), staticDir: dir, port: 0, status: { state: 'running', command: 'node app.js' }, token: 'given-token-0123456789', extraHost: parseExtraHost('xray-7000.app.github.dev') });
    const url = await server.start();
    base = url.slice(0, url.indexOf('/?'));

    // A fake agent: says hello, records the commands it gets.
    agent = net.createConnection(socketPath);
    agent.setEncoding('utf8');
    const decoder = new LineDecoder();
    agent.on('data', (chunk: string) => received.push(...decoder.push(chunk)));
    agent.write(encodeLine(hello));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  after(async () => {
    agent.destroy();
    await server.close();
    await collector.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function request(pathname: string, init: { method?: string; host?: string; body?: string; type?: string } = {}): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(base + pathname);
      const req = http.request(
        {
          host: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method: init.method ?? 'GET',
          headers: { host: init.host ?? url.host, ...(init.type ? { 'content-type': init.type } : {}) },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => {
            body += c;
            // SSE never ends: stop after the first chunk.
            if (res.headers['content-type'] === 'text/event-stream') {
              res.destroy();
              resolve({ status: res.statusCode ?? 0, body });
            }
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end(init.body);
    });
  }

  it('serves the page but guards the API with the token and the Host header', async () => {
    assert.equal((await request('/')).status, 200);
    assert.equal((await request('/secret.txt')).status, 404);
    assert.equal((await request('/api/stream')).status, 401);
    assert.equal((await request(`/api/stream?token=wrong`)).status, 401);
    assert.equal((await request('/', { host: 'evil.example:80' })).status, 403);
    assert.equal((await request('/', { host: 'localhost:61000' })).status, 200, 'a forwarded port is still local');
    assert.equal((await request('/', { host: 'xray-7000.app.github.dev' })).status, 200, 'the extra host');
    assert.equal((await request('/api/stream', { host: 'xray-7000.app.github.dev' })).status, 401, 'still needs the token');
    assert.equal((await request(`/api/status?token=${server.token}`, { host: 'other.app.github.dev' })).status, 403);
    assert.equal(server.token, 'given-token-0123456789', 'the token it was given');
  });

  it('streams status and the backlog as records', async () => {
    const { status, body } = await request(`/api/stream?token=${server.token}`);
    assert.equal(status, 200);
    assert.match(body, /event: reset/);
    assert.match(body, /event: status\ndata: \{"state":"running","command":"node app\.js"\}/);
    assert.match(body, /data: \{"c":1,"m":\{"type":"hello"/);
  });

  it('forwards valid commands to the agent and rejects the rest', async () => {
    const ok = await request(`/api/command?token=${server.token}`, {
      method: 'POST',
      type: 'application/json',
      body: JSON.stringify({ target: '4242:0', command: { type: 'loop-trace-stop' } }),
    });
    assert.deepEqual(ok, { status: 200, body: '{"sent":1}' });
    const form = await request(`/api/command?token=${server.token}`, { method: 'POST', type: 'text/plain', body: '{}' });
    assert.equal(form.status, 415);
    const bad = await request(`/api/command?token=${server.token}`, { method: 'POST', type: 'application/json', body: '{"target":null,"command":{}}' });
    assert.equal(bad.status, 400);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(received, ['{"type":"loop-trace-stop"}']);
  });

  it('answers the run status as JSON', async () => {
    assert.equal((await request('/api/status')).status, 401);
    const answer = await new Promise<{ type: string | undefined; body: string }>((resolve, reject) => {
      http.get(`${base}/api/status?token=${server.token}`, (res) => {
        let body = '';
        res.setEncoding('utf8').on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ type: res.headers['content-type'], body }));
      }).on('error', reject);
    });
    assert.deepEqual(answer, { type: 'application/json', body: '{"state":"running","command":"node app.js"}' });
    server.setStatus({ state: 'exited', command: 'node app.js', code: 3 });
    assert.deepEqual(await request(`/api/status?token=${server.token}`), { status: 200, body: '{"state":"exited","command":"node app.js","code":3}' });
    server.setStatus({ state: 'running', command: 'node app.js' });
  });

  it('serves per-line CPU samples (none yet)', async () => {
    assert.deepEqual(await request(`/api/lines?token=${server.token}`), { status: 200, body: '{"work":0,"files":[]}' });
  });

  it('resolves positions and exports profiles only when there is one', async () => {
    const resolved = await request(`/api/resolve?token=${server.token}`, { method: 'POST', type: 'application/json', body: JSON.stringify({ positions: [{ url: '/x.js', line: 1, column: 1 }] }) });
    assert.deepEqual(resolved, { status: 200, body: '{"originals":{}}' });
    assert.equal((await request(`/api/resolve?token=${server.token}`, { method: 'POST', type: 'application/json', body: '{"positions":7}' })).status, 400);
    const none = await request(`/api/export?token=${server.token}&source=4242:0&kind=cpu`);
    assert.deepEqual(none, { status: 404, body: 'no CPU profile yet' });
    assert.equal((await request(`/api/export?token=${server.token}&source=1:0&kind=cpu`)).status, 404);
    assert.equal((await request(`/api/export?source=4242:0&kind=cpu`)).status, 401);
  });
});

describe('DashboardServer backlog streaming', () => {
  const LIMIT = 64 * 1024;
  let collector: Collector;
  let server: DashboardServer;
  let streamUrl = '';
  const big = 'x'.repeat(20_000);
  let pid = 1;

  /** A source whose hello is about 20 KB. */
  function source(size: 'big' | 'small'): void {
    const link = collector.open({ send: () => undefined, close: () => undefined });
    link.line(JSON.stringify({ ...hello, pid: pid++, argv: ['node', size === 'big' ? big : 'small'] }));
  }

  before(async () => {
    collector = new Collector({ startupCommands: [] });
    server = new DashboardServer({
      collector,
      resolver: new SourceMapResolver(async () => ''),
      staticDir: os.tmpdir(),
      port: 0,
      status: { state: 'running', command: 'x' },
      token: 'given-token-0123456789',
      extraHost: null,
      maxClientBuffer: LIMIT,
    });
    const url = await server.start();
    streamUrl = `${url.slice(0, url.indexOf('/?'))}/api/stream?token=${server.token}`;
    // About 4 MB of backlog: 60 times the live limit.
    for (let i = 0; i < 200; i++) source('big');
  });

  after(async () => {
    await server.close();
    await collector.close();
  });

  /** Opens the stream paused; `read()` resumes it and collects until `done(body)` or the end. */
  function paused(): Promise<{ read(done: (body: string) => boolean): Promise<{ body: string; ended: boolean }> }> {
    return new Promise((resolve, reject) => {
      http.get(streamUrl, (res) => {
        res.pause();
        resolve({
          read: (done) =>
            new Promise((finish) => {
              let body = '';
              let settled = false;
              const settle = (ended: boolean): void => {
                if (settled) return;
                settled = true;
                res.destroy();
                finish({ body, ended });
              };
              res.setEncoding('utf8');
              res.on('data', (c: string) => {
                body += c;
                if (done(body)) settle(false);
              });
              res.on('close', () => settle(true));
              res.resume();
            }),
        });
      }).on('error', reject);
    });
  }

  const hellos = (body: string): number => body.split('"type":"hello"').length - 1;

  it('sends a backlog far larger than the limit to a slow reader, then live records in order', async () => {
    const client = await paused();
    await new Promise((resolve) => setTimeout(resolve, 200));
    source('small');
    source('small');
    const { body, ended } = await client.read((text) => hellos(text) === 202);
    assert.equal(ended, false, 'not dropped');
    assert.equal(hellos(body), 202);
    assert.ok(body.lastIndexOf(big) < body.indexOf('"small"'), 'live records after the backlog');
  });

  it('drops a reader that falls behind by more than the limit of live data', async () => {
    const client = await paused();
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (let i = 0; i < 5; i++) source('big');
    const { ended, body } = await client.read(() => false);
    assert.equal(ended, true);
    assert.ok(hellos(body) < 205);
  });
});
