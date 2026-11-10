// End to end: the built `xray` binary runs a real Node program with the real agent.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/bin.js');

let dir = '';
before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'xray-cli-'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

interface Result {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function xray(args: readonly string[]): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

const APP = `
  function block() { const end = Date.now() + 120; while (Date.now() < end); }
  let n = 0;
  const t = setInterval(function work() { Promise.resolve().then(() => n++); if (n === 3) block(); if (n > 12) { clearInterval(t); console.log('app out'); process.exitCode = 3; } }, 60);
`;

describe('xray run', () => {
  it('profiles the command, keeps its output and exit code, writes report and recording', async () => {
    const report = path.join(dir, 'report.json');
    const recording = path.join(dir, 'run.xray.jsonl');
    const result = await xray(['run', '--interval', '100ms', '--cpu', '--trace-loop', '2s', '--report', report, '--record', recording, '--', process.execPath, '-e', APP]);

    assert.equal(result.code, 3);
    assert.equal(result.stdout, 'app out\n');
    assert.match(result.stderr, /── node {2}\(pid \d+, v/);
    assert.match(result.stderr, /Loop trace {2}/);
    assert.match(result.stderr, /! loop-stall/);

    const json: unknown = JSON.parse(readFileSync(report, 'utf8'));
    assert.ok(typeof json === 'object' && json !== null);
    const sources: unknown = Reflect.get(json, 'sources');
    assert.ok(Array.isArray(sources) && sources.length === 1);
    const source: unknown = sources[0];
    assert.ok(typeof source === 'object' && source !== null);
    assert.ok((Reflect.get(source, 'frames') as number) >= 5);
    assert.notEqual(Reflect.get(source, 'loopTrace'), null);

    const lines = readFileSync(recording, 'utf8').trim().split('\n');
    const first: unknown = JSON.parse(lines[0] ?? '{}');
    assert.ok(lines.length > 10);
    assert.ok(lines.every((line) => line.startsWith('{"c":')));
    assert.ok(typeof first === 'object' && first !== null && 'm' in first);
  });

  it('reports a command that cannot start', async () => {
    const result = await xray(['run', 'definitely-not-a-command-xray']);
    assert.equal(result.code, 127);
    assert.match(result.stderr, /cannot start 'definitely-not-a-command-xray'/);
  });

  it('says when nothing connected', async () => {
    const result = await xray(['run', process.platform === 'win32' ? 'cmd' : 'true']);
    assert.equal(result.code, 0);
    assert.match(result.stderr, /no Node\.js process connected/);
  });

  it('prints usage for bad arguments', async () => {
    const result = await xray(['run', '--bogus', 'node']);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /unknown option '--bogus'[\s\S]*Usage: xray run/);
  });
});

describe('file system and DNS', () => {
  it('times sync file system calls with --fs and DNS always', async () => {
    const program = "const fs = require('node:fs'); setTimeout(() => { for (let i = 0; i < 50; i++) fs.readFileSync(process.execPath).length; require('node:dns').lookup('localhost', () => setTimeout(() => {}, 300)); }, 250)";
    const result = await xray(['run', '--fs', '--interval', '100ms', '--budget', 'fs.sync<1ms', '--', process.execPath, '-e', program]);
    assert.equal(result.code, 1, 'the fs.sync budget is broken');
    assert.match(result.stderr, /Files sync {2}50 calls/);
    assert.match(result.stderr, /in readFileSync \S+ ×50/);
    assert.match(result.stderr, /DNS {9}1 calls/);
    assert.match(result.stderr, /✗ fs\.sync<1ms/);
  });
});

describe('budgets and replay', () => {
  it('fails a run that breaks a budget, then replays its recording with the same verdict', async () => {
    const recording = path.join(dir, 'budget.xray.jsonl');
    const run = await xray(['run', '--interval', '100ms', '--record', recording, '--budget', 'loop.max<50ms,cpu.avg<1000%,http.p99<1s', '--', process.execPath, '-e', APP]);
    assert.equal(run.code, 3, 'the command’s own exit code wins');
    assert.match(run.stderr, /── budgets: 1 broken, 1 met, 1 without data/);
    assert.match(run.stderr, /✗ loop\.max<50ms: \d+ ms/);
    assert.match(run.stderr, /✓ cpu\.avg<1000%/);
    assert.match(run.stderr, /– http\.p99<1s: no data in this run/);

    const report = path.join(dir, 'replay.json');
    const replayed = await xray(['replay', '--budget', 'loop.max<50ms', '--report', report, recording]);
    assert.equal(replayed.code, 1, 'a broken budget fails the replay');
    assert.match(replayed.stderr, /replayed \d+ records/);
    assert.match(replayed.stderr, /── node {2}\(pid \d+/);
    assert.match(replayed.stderr, /! loop-stall/);
    assert.doesNotMatch(replayed.stderr, /── host\n {2}GPU/, 'no host probe of this machine in a replay');
    const json: unknown = JSON.parse(readFileSync(report, 'utf8'));
    assert.ok(typeof json === 'object' && json !== null && Array.isArray(Reflect.get(json, 'budgets')));

    const met = await xray(['replay', '--budget', 'loop.max<10s', recording]);
    assert.equal(met.code, 0);
    assert.match(met.stderr, /── budgets: 0 broken, 1 met/);
  });

  it('treats a service stopped with SIGTERM as a clean stop and exits by the budgets', async () => {
    const child = spawn(process.execPath, [bin, 'run', '--interval', '100ms', '--budget', 'loop.max<10s', '--', process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    await new Promise((resolve) => setTimeout(resolve, 800));
    child.kill('SIGTERM');
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    assert.equal(code, 0, stderr);
    assert.match(stderr, /── budgets: 0 broken, 1 met/);
  });

  it('exits 1 for a successful command that breaks a budget', async () => {
    const program = 'setTimeout(() => { const e = Date.now() + 300; while (Date.now() < e); }, 400); setTimeout(() => {}, 900)';
    const result = await xray(['run', '--interval', '100ms', '--budget', 'loop.max<1ms', '--', process.execPath, '-e', program]);
    assert.equal(result.code, 1);
  });

  it('refuses a file that is not a recording', async () => {
    const bogus = path.join(dir, 'bogus.txt');
    writeFileSync(bogus, 'hello\n');
    const result = await xray(['replay', bogus]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /has no xray records/);
    assert.match((await xray(['replay', path.join(dir, 'missing.jsonl')])).stderr, /cannot read/);
  });
});
