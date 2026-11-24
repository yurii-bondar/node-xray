// `xray attach` against real processes started here without xray.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { Writable } from 'node:stream';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AttachOptions } from '../src/args.js';
import { AttachError, attachWith, injection, looksLikeNode, type AttachEdges } from '../src/attach.js';
import { CdpError, debuggerUrl, workerCdp, type Cdp } from '../src/cdp.js';
import { Collector } from '../src/collector.js';
import { Interrupts, type Session } from '../src/session.js';

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

/** A target's inspector session: answers `process.pid`, records every call, fails the methods it is told to. */
class FakeCdp implements Cdp {
  readonly calls: string[] = [];
  readonly closed: Promise<void>;
  #end: () => void = () => undefined;
  readonly #handlers = new Map<string, Set<(params: unknown) => void>>();

  constructor(
    private readonly pid: number,
    private readonly fail: ReadonlySet<string> = new Set(),
  ) {
    this.closed = new Promise((resolve) => (this.#end = resolve));
  }

  send(method: string, params: object = {}): Promise<unknown> {
    const expression: unknown = Reflect.get(params, 'expression');
    const call = typeof expression === 'string' ? `${method} ${expression}` : method;
    this.calls.push(call);
    if (this.fail.has(method)) return Promise.reject(new CdpError(`${method} failed`));
    if (expression === 'process.pid') return Promise.resolve({ result: { value: this.pid } });
    if (typeof expression === 'string' && expression.startsWith('process.argv')) return Promise.resolve({ result: { value: 'app.js' } });
    return Promise.resolve({ result: {} });
  }

  on(method: string, handler: (params: unknown) => void): () => void {
    const set = this.#handlers.get(method) ?? new Set();
    set.add(handler);
    this.#handlers.set(method, set);
    return () => set.delete(handler);
  }

  emit(method: string, params: unknown): void {
    for (const handler of this.#handlers.get(method) ?? []) handler(params);
  }

  handlerCount(method: string): number {
    return this.#handlers.get(method)?.size ?? 0;
  }

  close(): void {
    this.calls.push('close');
    this.#end();
  }

  closedInspector(): boolean {
    return this.calls.some((call) => call.includes("'node:inspector').close()"));
  }

  stoppedAgent(): boolean {
    return this.calls.some((call) => call.includes('.stop()'));
  }
}

const OPTIONS: AttachOptions = {
  pid: 4242,
  inspectPort: 9229,
  durationMs: null,
  intervalMs: 250,
  cpu: false,
  heap: false,
  fs: false,
  traceLoopMs: null,
  record: null,
  report: null,
  profiles: null,
  ui: null,
  budgets: [],
};

interface Scenario {
  /** An inspector already listens (the user started the target with --inspect). */
  readonly listening?: boolean;
  /** What `process.pid` answers on the inspector. */
  readonly inspectorPid?: number;
  readonly fail?: readonly string[];
  readonly sessionFails?: boolean;
  /** Called when the session opens (after the inspector was opened and verified). */
  readonly onSession?: () => void;
  /** Called when the summary starts. */
  readonly onFinish?: () => void;
}

function scenario({ listening = false, inspectorPid = OPTIONS.pid, fail = [], sessionFails = false, onSession, onFinish }: Scenario) {
  const cdp = new FakeCdp(inspectorPid, new Set(fail));
  const log: string[] = [];
  let open = listening;
  const finished: string[] = [];
  const edges: AttachEdges = {
    assertAlive: () => undefined,
    assertNode: async () => undefined,
    openInspector: (pid) => {
      log.push(`SIGUSR1 ${pid}`);
      open = true;
    },
    findInspector: async (port) => {
      log.push(`find ${port}`);
      return open ? `ws://127.0.0.1:${port}/x` : null;
    },
    connect: async () => cdp,
    openSession: async () => {
      onSession?.();
      if (sessionFails) throw new Error('listen EADDRINUSE: address already in use 127.0.0.1:7000');
      const collector = new Collector({ startupCommands: [] });
      const session: Session = {
        collector,
        dashboard: null,
        finish: async () => {
          finished.push('finish');
          onFinish?.();
          return { sources: [], budgets: [], failed: false };
        },
        close: () => collector.close(),
      };
      return session;
    },
    bundle: () => '/opt/xray/attach.cjs',
  };
  return { cdp, log, edges, finished };
}

const quiet = new Writable({ write: (_chunk, _encoding, done) => done() });

describe('attach cleans up after itself', () => {
  it('closes the inspector it opened when the session cannot start (busy --port)', async () => {
    const { cdp, edges } = scenario({ sessionFails: true });
    const interrupts = new Interrupts(new EventEmitter());
    await assert.rejects(attachWith({ options: OPTIONS, stderr: quiet, interrupts, edges }), /EADDRINUSE/);
    assert.ok(cdp.closedInspector(), 'inspector closed');
    assert.ok(cdp.calls.includes('close'), 'connection closed');
  });

  it('stops a half-injected agent and closes the inspector when injection fails', async () => {
    const { cdp, edges } = scenario({ fail: ['Runtime.addBinding'] });
    await assert.rejects(attachWith({ options: OPTIONS, stderr: quiet, interrupts: new Interrupts(new EventEmitter()), edges }), /addBinding failed/);
    assert.ok(cdp.stoppedAgent());
    assert.ok(cdp.closedInspector());
  });

  it('stops the agent and closes the inspector when NodeWorker.enable throws', async () => {
    const { cdp, edges } = scenario({ fail: ['NodeWorker.enable'] });
    await assert.rejects(attachWith({ options: OPTIONS, stderr: quiet, interrupts: new Interrupts(new EventEmitter()), edges }), CdpError);
    assert.ok(cdp.stoppedAgent());
    assert.ok(cdp.calls.includes('Runtime.removeBinding'));
    assert.ok(cdp.closedInspector());
  });

  it('stops its agent but leaves an inspector it did not open alone', async () => {
    const { cdp, edges, log } = scenario({ listening: true, fail: ['NodeWorker.enable'] });
    await assert.rejects(attachWith({ options: OPTIONS, stderr: quiet, interrupts: new Interrupts(new EventEmitter()), edges }), CdpError);
    assert.ok(cdp.stoppedAgent());
    assert.ok(!cdp.closedInspector());
    assert.ok(!log.some((line) => line.startsWith('SIGUSR1')));
  });

  it('never closes an inspector that belongs to another process', async () => {
    const { cdp, edges } = scenario({ inspectorPid: 7 });
    await assert.rejects(attachWith({ options: OPTIONS, stderr: quiet, interrupts: new Interrupts(new EventEmitter()), edges }), AttachError);
    assert.ok(!cdp.closedInspector(), 'pid 7 keeps its inspector');
    assert.ok(!cdp.stoppedAgent());
  });

  it('detaches cleanly, with the summary, on Ctrl+C while attaching', async () => {
    const signals = new EventEmitter();
    const { cdp, edges, finished } = scenario({ onSession: () => signals.emit('SIGINT') });
    const interrupts = new Interrupts(signals);
    const result = await attachWith({ options: { ...OPTIONS, durationMs: 60_000 }, stderr: quiet, interrupts, edges });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(finished, ['finish']);
    assert.ok(cdp.stoppedAgent());
    assert.ok(cdp.closedInspector());
    // The 60 s --duration timer is cleared: this test file would otherwise stay alive for a minute.
  });

  it('does not signal at all after Ctrl+C before the inspector was opened', async () => {
    const signals = new EventEmitter();
    const { edges, log } = scenario({});
    const interrupts = new Interrupts(signals);
    signals.emit('SIGINT');
    await assert.rejects(attachWith({ options: OPTIONS, stderr: quiet, interrupts, edges }), /interrupted before attaching/);
    assert.ok(!log.some((line) => line.startsWith('SIGUSR1')));
  });
});

/** Polls until `condition` holds (the attach flow awaits several fake round trips). */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !condition(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(condition(), 'condition never held');
}

describe('attach acknowledgements and the summary', () => {
  it('acks the characters received per agent, throttled, and stops when detaching', async () => {
    const signals = new EventEmitter();
    const { cdp, edges } = scenario({});
    const attaching = attachWith({ options: OPTIONS, stderr: quiet, interrupts: new Interrupts(signals), edges });
    await until(() => cdp.calls.includes('NodeWorker.enable'));
    const acks = (): string[] => cdp.calls.filter((call) => call.includes('.ack('));

    cdp.emit('Runtime.bindingCalled', { name: '__xray_send', payload: 'x'.repeat(1_000_000) });
    assert.deepEqual(acks(), ["Runtime.evaluate globalThis[Symbol.for('node-xray.attach')].ack(1000000)"], 'a million characters: at once');
    cdp.emit('Runtime.bindingCalled', { name: 'other', payload: 'not ours' });
    cdp.emit('Runtime.bindingCalled', { name: '__xray_send', payload: '{}' });
    assert.equal(acks().length, 1, 'small payloads wait for the interval');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(acks().slice(1), ["Runtime.evaluate globalThis[Symbol.for('node-xray.attach')].ack(1000002)"]);

    cdp.emit('Runtime.bindingCalled', { name: '__xray_send', payload: '{}' });
    signals.emit('SIGINT');
    await attaching;
    assert.equal(acks().length, 2, 'no ack once detaching started');
  });

  it('detaches before the summary, and a second Ctrl+C during it quits with 130', async () => {
    const signals = new EventEmitter();
    const exits: number[] = [];
    let closedBeforeQuit = false;
    const { cdp, edges } = scenario({
      onFinish: () => {
        signals.emit('SIGINT');
        closedBeforeQuit = cdp.closedInspector() && cdp.stoppedAgent();
        signals.emit('SIGINT');
      },
    });
    const interrupts = new Interrupts(signals, (code) => exits.push(code));
    let stderr = '';
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        stderr += chunk.toString();
        done();
      },
    });
    const attaching = attachWith({ options: OPTIONS, stderr: sink, interrupts, edges });
    await until(() => cdp.calls.includes('NodeWorker.enable'));
    signals.emit('SIGINT'); // detach
    await attaching;
    assert.ok(closedBeforeQuit, 'the inspector xray opened is closed before the summary starts');
    assert.deepEqual(exits, [130]);
    assert.match(stderr, /detached from pid 4242, inspector closed\.\nxray: finishing the summary; Ctrl\+C again to quit without it\n/);
  });
});

describe('workerCdp', () => {
  it('removes its handlers from the main session when the worker goes', async () => {
    const parent = new FakeCdp(1);
    const worker = workerCdp(parent, 's1');
    assert.equal(parent.handlerCount('NodeWorker.receivedMessageFromWorker'), 1);
    parent.emit('NodeWorker.detachedFromWorker', { sessionId: 's1' });
    await worker.closed;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(parent.handlerCount('NodeWorker.receivedMessageFromWorker'), 0);
    assert.equal(parent.handlerCount('NodeWorker.detachedFromWorker'), 0);
  });
});
