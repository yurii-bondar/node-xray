// End to end through the bundle: a real `node --require dist/agent.cjs` child talks to a socket here.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeStreamMessage, encodeLine, LineDecoder, type AgentCommand, type StreamMessage } from '@node-xray/core';

const agentPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../agent.cjs');

interface Run {
  readonly messages: StreamMessage[];
  readonly errors: string[];
  readonly stdout: string;
  readonly code: number | null;
}

let dir = '';
before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'xray-agent-'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

/** Runs `script` under the agent; `commands` go to every source right after its hello. */
async function run(script: string, commands: readonly AgentCommand[] = [], env: Record<string, string> = {}): Promise<Run> {
  const socketPath = path.join(dir, `s${Math.random().toString(36).slice(2, 8)}.sock`);
  const messages: StreamMessage[] = [];
  const errors: string[] = [];
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    const decoder = new LineDecoder();
    socket.on('data', (chunk: string) => {
      for (const line of decoder.push(chunk)) {
        const parsed = decodeStreamMessage(line);
        if (!parsed.ok) {
          errors.push(parsed.error);
          continue;
        }
        messages.push(parsed.value);
        if (parsed.value.type === 'hello') for (const command of commands) socket.write(encodeLine(command));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  const child = spawn(process.execPath, ['--require', agentPath, '-e', script], {
    env: { ...process.env, XRAY_SOCKET: socketPath, XRAY_INTERVAL_MS: '100', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { messages, errors, stdout, code };
}

function ofType<T extends StreamMessage['type']>(messages: readonly StreamMessage[], type: T): Array<Extract<StreamMessage, { type: T }>> {
  return messages.filter((m): m is Extract<StreamMessage, { type: T }> => m.type === type);
}

describe('agent bundle', () => {
  it('streams hello and samples without touching the app', async () => {
    const result = await run(`
      let n = 0; const keep = [];
      const timer = setInterval(() => { keep.push(new Array(1e4).fill(n++)); if (n === 5) { clearInterval(timer); console.log('done'); } }, 80);
    `);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'done\n');
    assert.deepEqual(result.errors, []);
    const [hello] = ofType(result.messages, 'hello');
    assert.ok(hello);
    assert.equal(hello.intervalMs, 100);
    const samples = ofType(result.messages, 'sample');
    assert.ok(samples.length >= 3, `${samples.length} samples`);
    const last = samples[samples.length - 1];
    assert.ok(last && last.memory.heapUsed > 0 && last.cpu.user > 0);
    assert.deepEqual(ofType(result.messages, 'agent-error'), []);
  });

  it('traces the loop and profiles on command', async () => {
    const result = await run(
      `
      function busy() { const end = Date.now() + 5; while (Date.now() < end); }
      let n = 0;
      const timer = setInterval(function tickWork() { busy(); Promise.resolve().then(() => n++); if (n > 8) clearInterval(timer); }, 40);
    `,
      [
        { type: 'loop-trace-start', flushMs: 100, maxEventsPerFlush: 1000, durationMs: 5000 },
        { type: 'cpu-profile-start', samplingIntervalUs: 500, windowMs: 150 },
      ],
    );
    assert.equal(result.code, 0);
    assert.deepEqual(ofType(result.messages, 'agent-error'), []);
    const traces = ofType(result.messages, 'loop-trace');
    assert.ok(traces.length >= 2, `${traces.length} trace batches`);
    const named = traces.flatMap((t) => t.events).filter((e) => e.name === 'tickWork');
    assert.ok(named.length >= 5, `${named.length} tickWork callbacks`);
    assert.ok(named.every((e) => e.duration >= 4), 'busy() inside each callback');
    const profiles = ofType(result.messages, 'cpu-profile');
    assert.ok(profiles.length >= 1, `${profiles.length} cpu profiles`);
  });

  it('sends the profile of a program shorter than one profiling window', async () => {
    const result = await run(
      'function spin() { const end = Date.now() + 300; while (Date.now() < end); } setTimeout(spin, 100);',
      [
        { type: 'cpu-profile-start', samplingIntervalUs: 500, windowMs: 60_000 },
        { type: 'heap-sampling-start', samplingIntervalBytes: 1024, windowMs: 60_000 },
      ],
    );
    assert.equal(result.code, 0);
    const [cpu] = ofType(result.messages, 'cpu-profile');
    assert.ok(cpu, 'cpu profile flushed on exit');
    assert.ok(cpu.profile.nodes.some((n) => n.callFrame.functionName === 'spin'));
    assert.equal(ofType(result.messages, 'heap-profile').length, 1, 'heap profile flushed on exit');
  });

  it('reports HTTP served and made: routes, statuses, failures, stuck requests', async () => {
    const result = await run(`
      const http = require('node:http');
      const server = http.createServer((req, res) => {
        if (req.url.startsWith('/boom')) { res.statusCode = 500; res.end(); return; }
        if (req.url.startsWith('/slow')) { setTimeout(() => res.end('late'), 1300); return; }
        setTimeout(() => res.end('ok'), 5);
      });
      server.listen(0, '127.0.0.1', async () => {
        const base = 'http://127.0.0.1:' + server.address().port;
        const slow = fetch(base + '/slow/report').then((r) => r.text());
        for (let i = 0; i < 6; i++) await (await fetch(base + '/users/' + i)).text();
        await (await fetch(base + '/boom')).text();
        await new Promise((resolve) => http.get(base + '/users/99?x=1', (res) => { res.resume(); res.on('end', resolve); }));
        // A port that was just free: connection refused (port 1 is on fetch's blocked list).
        const closed = await new Promise((resolve) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
        await fetch('http://127.0.0.1:' + closed + '/').catch(() => {});
        await slow;
        server.close();
      });
    `);
    assert.equal(result.code, 0);
    assert.deepEqual(ofType(result.messages, 'agent-error'), []);
    const ticks = ofType(result.messages, 'http');
    assert.ok(ticks.length >= 3, `${ticks.length} http ticks`);
    const sum = (pick: (t: (typeof ticks)[number]) => number): number => ticks.reduce((n, t) => n + pick(t), 0);
    assert.equal(sum((t) => t.server.finished), 9, 'six users, boom, the http.get one, slow');
    assert.equal(sum((t) => t.server.statuses['5xx']), 1);
    assert.equal(sum((t) => t.client.finished), 9);
    assert.equal(sum((t) => t.client.failed), 1, 'the refused connection, counted once');
    const routes = new Set(ticks.flatMap((t) => t.server.routes.map((r) => r.key)));
    assert.ok(routes.has('GET /users/:id'), [...routes].join(', '));
    assert.ok(routes.has('GET /slow/report'));
    assert.ok(ticks.some((t) => t.server.stuck.some((s) => s.route === 'GET /slow/report')), 'the slow request showed up as stuck while running');
    assert.ok(ticks.flatMap((t) => t.client.routes).some((r) => /^GET 127\.0\.0\.1:\d+ \/users\/:id$/.test(r.key)));
  });

  it('times DNS always, and file system calls once asked to', async () => {
    const result = await run(
      `
      const fs = require('node:fs');
      const dns = require('node:dns');
      setTimeout(async () => {
        await new Promise((resolve) => dns.lookup('localhost', resolve));
        fs.readFileSync(__filename === '[eval]' ? process.execPath : __filename, { encoding: null }).length;
        await fs.promises.stat('/');
        await fs.promises.readFile('/definitely/missing').catch(() => {});
        await new Promise((resolve) => fs.readdir('/', resolve));
        setTimeout(() => {}, 250);
      }, 200);
    `,
      [{ type: 'fs-timing-start' }],
    );
    assert.equal(result.code, 0);
    assert.deepEqual(ofType(result.messages, 'agent-error'), []);
    const ticks = ofType(result.messages, 'io');
    const keys = (kind: 'fs' | 'fsSync' | 'dns'): string[] => ticks.flatMap((t) => t[kind].operations.map((o) => o.key));
    assert.ok(keys('dns').some((k) => k === 'lookup localhost'), keys('dns').join(', '));
    assert.ok(keys('fsSync').some((k) => k.startsWith('readFileSync ')), keys('fsSync').join(', '));
    assert.ok(keys('fs').includes('stat /'));
    assert.ok(keys('fs').includes('readdir /'));
    const missing = ticks.flatMap((t) => t.fs.operations).find((o) => o.key === 'readFile /definitely/missing');
    assert.equal(missing?.errors, 1);
  });

  it('sends no HTTP ticks for a process without HTTP', async () => {
    const result = await run('setTimeout(() => {}, 250)');
    assert.deepEqual(ofType(result.messages, 'http'), []);
  });

  it('gives each worker thread its own source', async () => {
    const result = await run(`
      const { Worker } = require('node:worker_threads');
      const w = new Worker('setTimeout(() => {}, 250)', { eval: true });
      w.on('exit', () => setTimeout(() => {}, 150));
    `);
    const threads = ofType(result.messages, 'hello').map((h) => h.threadId).sort();
    assert.deepEqual(threads, [0, 1]);
  });

  it('leaves the app alone when the CLI is not there', async () => {
    const child = spawn(process.execPath, ['--require', agentPath, '-e', 'setTimeout(() => console.log("still fine"), 50)'], {
      env: { ...process.env, XRAY_SOCKET: path.join(dir, 'nobody-listens.sock') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (out += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (err += c));
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    assert.deepEqual([code, out, err], [0, 'still fine\n', '']);
  });
});
