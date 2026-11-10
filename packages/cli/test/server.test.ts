import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { encodeLine, LineDecoder, parseRecord, type StreamMessage } from '@node-xray/core';
import { Backlog } from '../src/backlog.js';
import { Collector } from '../src/collector.js';
import { DashboardServer, parseCommandRequest, parseResolveRequest } from '../src/server.js';
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
  const parsed = parseRecord(`{"c":1,"m":${raw}}`);
  if (!parsed.ok) assert.fail(parsed.error);
  return parsed.value.message;
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
    server = new DashboardServer({ collector, resolver: new SourceMapResolver(async () => ''), staticDir: dir, port: 0, status: { state: 'running', command: 'node app.js' }, token: 'given-token-0123456789' });
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
