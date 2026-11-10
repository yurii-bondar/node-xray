// `xray attach` against real processes started here without xray.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { injection, looksLikeNode } from '../src/attach.js';
import { debuggerUrl } from '../src/cdp.js';

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/bin.js');
const children: ChildProcess[] = [];
after(() => {
  for (const child of children) child.kill();
});

function start(file: string, args: readonly string[], options: { stdio?: 'ignore' | 'pipe' } = {}): ChildProcess {
  const child = spawn(file, [...args], { stdio: options.stdio ?? 'ignore' });
  children.push(child);
  return child;
}

function xray(args: readonly string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.on('exit', (code) => resolve({ code, stderr }));
  });
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('attach helpers', () => {
  it('recognises Node binaries by name only', () => {
    assert.equal(looksLikeNode('node'), true);
    assert.equal(looksLikeNode('/usr/local/bin/node22'), true);
    assert.equal(looksLikeNode('C:\\\\Program Files\\\\nodejs\\\\node.exe'), true);
    assert.equal(looksLikeNode('nodejs'), true);
    assert.equal(looksLikeNode('postgres'), false);
    assert.equal(looksLikeNode('/usr/bin/nodemon'), false);
    assert.equal(looksLikeNode(''), false);
  });

  it('picks the debugger URL from /json/list', () => {
    assert.equal(debuggerUrl([{ type: 'node', webSocketDebuggerUrl: 'ws://127.0.0.1:9229/abc' }]), 'ws://127.0.0.1:9229/abc');
    assert.equal(debuggerUrl([{ type: 'node' }]), null);
    assert.equal(debuggerUrl('nope'), null);
  });

  it('loads the bundle from its file and starts it', () => {
    const code = injection({ bundle: '/opt/My Dir/attach.cjs', binding: '__xray_send', intervalMs: 250 });
    assert.match(code, /^\(process\.getBuiltinModule \? process\.getBuiltinModule\('node:module'\)\.createRequire\("\/opt\/My Dir\/attach\.cjs"\) : typeof require === 'function'/);
    assert.match(code, /\)\("\/opt\/My Dir\/attach\.cjs"\);\n/);
    assert.match(code, /\.start\(\{"binding":"__xray_send","intervalMs":250\}\);$/);
  });
});

describe('xray attach', () => {
  it('profiles a running process, then leaves it running with the inspector closed', async () => {
    const target = start(process.execPath, ['-e', 'const t = setInterval(() => { const e = Date.now() + 5; while (Date.now() < e); }, 20); setTimeout(() => clearInterval(t), 20000)']);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const pid = target.pid as number;
    const result = await xray(['attach', '--inspect-port', '9341', '--duration', '2s', '--interval', '250ms', String(pid)]);
    // --inspect-port 9341: SIGUSR1 opens 9229, so nothing answers on 9341; xray closes 9229 again.
    assert.equal(result.code, 1);
    assert.match(result.stderr, /did not open its inspector on 127\.0\.0\.1:9341\. It opened one on 9229 instead, which xray closed again/);
    assert.equal(await fetch('http://127.0.0.1:9229/json/list').then(() => 'open', () => 'closed'), 'closed');
    target.kill();

    const second = start(process.execPath, ['--inspect=127.0.0.1:9342', '-e', 'setInterval(() => { const e = Date.now() + 5; while (Date.now() < e); }, 20)']);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const ok = await xray(['attach', '--inspect-port', '9342', '--duration', '2s', '--interval', '250ms', String(second.pid)]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stderr, /attached to pid \d+/);
    assert.match(ok.stderr, /detached from pid \d+\./, 'an inspector xray did not open stays open');
    assert.match(ok.stderr, /── node {2}\(pid \d+, v[\d.]+, [\d.]+ s, \d+ samples\)/);
    assert.ok(alive(second.pid as number), 'still running after detach');
  });

  it('opens the inspector with SIGUSR1 and closes it on detach', async () => {
    const target = start(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const result = await xray(['attach', '--duration', '1500ms', '--interval', '250ms', String(target.pid)]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /detached from pid \d+, inspector closed\./);
    assert.ok(alive(target.pid as number));
    const after = await fetch('http://127.0.0.1:9229/json/list').then(() => 'open', () => 'closed');
    assert.equal(after, 'closed');
  });

  it('puts the agent into worker threads too, each its own source', async () => {
    const program = "const { Worker } = require('node:worker_threads'); new Worker('setInterval(() => { const e = Date.now() + 3; while (Date.now() < e); }, 20)', { eval: true }); setInterval(() => {}, 1000)";
    const target = start(process.execPath, ['--inspect=127.0.0.1:9344', '-e', program]);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const result = await xray(['attach', '--inspect-port', '9344', '--duration', '2500ms', '--interval', '250ms', String(target.pid)]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /xray: \+ \[worker 1\]/);
    assert.match(result.stderr, /── node {2}\(pid \d+, v/);
    assert.match(result.stderr, /── node \[worker eval\] {2}\(pid \d+, worker 1, v/);
    assert.ok(alive(target.pid as number));
  });

  it('refuses to signal something that is not Node', async () => {
    const sleeper = start('sleep', ['30']);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await xray(['attach', '--inspect-port', '9343', String(sleeper.pid)]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /is 'sleep', not node: SIGUSR1 would terminate it/);
    assert.ok(alive(sleeper.pid as number), 'not killed');
  });

  it('says when there is no such process', async () => {
    const result = await xray(['attach', '999999']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no process with pid 999999/);
  });
});
