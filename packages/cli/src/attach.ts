// `xray attach <pid>`: profile a process that is already running. Opens its inspector
// (SIGUSR1), injects the agent bundle with `Runtime.evaluate`, receives its messages through a
// CDP binding, and on detach removes it and closes the inspector again if xray opened it. An
// open inspector runs any code: whatever goes wrong after SIGUSR1 (a busy --port, a failed
// injection, Ctrl+C half way), the agents are stopped and an inspector xray opened is closed.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SourceReport } from '@node-xray/core';
import { AckThrottle, type Schedule } from './acks.js';
import type { AttachOptions } from './args.js';
import { assets } from './assets.js';
import { connectCdp, evaluate, findInspector, workerCdp, type Cdp } from './cdp.js';
import type { Collector, OpenLink } from './collector.js';
import { Interrupts, openSession, type Session, type SessionArgs } from './session.js';

const BINDING = '__xray_send';
const API = "globalThis[Symbol.for('node-xray.attach')]";
const OPEN_TIMEOUT_MS = 5000;
/** Where SIGUSR1 opens the inspector unless the process was started with another --inspect-port. */
const DEFAULT_INSPECT_PORT = 9229;
const CLOSE_INSPECTOR = "process.getBuiltinModule ? process.getBuiltinModule('node:inspector').close() : require('node:inspector').close()";
/** Time for the agent's last messages (final profile window) after stop, before the binding goes. */
const SETTLE_MS = 300;

export class AttachError extends Error {
  override name = 'AttachError';
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves after `ms`, or never once `signal` aborts: the timer does not keep the CLI alive after that. */
function sleepUnless(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  });
}

export interface Injection {
  /** Absolute path of the attach bundle; the target loads it from disk (same machine). */
  readonly bundle: string;
  readonly binding: string;
  readonly intervalMs: number;
}

/**
 * Code a thread evaluates: load the bundle from its file, then start the agent.
 */
export function injection({ bundle, binding, intervalMs }: Injection): string {
  const file = JSON.stringify(bundle);
  return [
    // createRequire works in worker threads too; the console's `require` is the fallback for Node < 20.16.
    `(process.getBuiltinModule ? process.getBuiltinModule('node:module').createRequire(${file}) : typeof require === 'function' ? require : process.mainModule.require.bind(process.mainModule))(${file});`,
    `${API}.start(${JSON.stringify({ binding, intervalMs })});`,
  ].join('\n');
}

function assertAlive(pid: number): void {
  try {
    process.kill(pid, 0);
  } catch (error) {
    const code: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
    throw new AttachError(code === 'EPERM' ? `not allowed to signal pid ${pid} (another user's process?)` : `no process with pid ${pid}`);
  }
}

/** `ps -o comm=` output (a name or a path) → whether it is a Node.js binary (`node`, `nodejs`, `node22`). */
export function looksLikeNode(command: string): boolean {
  const name = command.trim().split(/[\\/]/).pop() ?? '';
  return /^(?:node|nodejs)(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(name);
}

/**
 * SIGUSR1 terminates a process that does not handle it: never send it to something that is not
 * Node. A Node binary under another name can still be attached when it already listens
 * (`--inspect`, then `--inspect-port`).
 */
async function assertNode(pid: number): Promise<void> {
  if (process.platform === 'win32') return;
  let command = '';
  try {
    command = (await promisify(execFile)('ps', ['-o', 'comm=', '-p', String(pid)], { timeout: 3000 })).stdout.trim();
  } catch {
    throw new AttachError(`cannot tell what pid ${pid} is (ps failed); start it with --inspect and pass --inspect-port`);
  }
  if (!looksLikeNode(command)) {
    throw new AttachError(
      `pid ${pid} is '${command}', not node: SIGUSR1 would terminate it. If it is Node.js under another name, start it with --inspect and pass --inspect-port.`,
    );
  }
}

/** Asks the process to open its inspector: SIGUSR1 on Unix, `process._debugProcess` on Windows. */
function openInspector(pid: number): void {
  if (process.platform === 'win32') {
    const debugProcess: unknown = Reflect.get(process, '_debugProcess');
    if (typeof debugProcess !== 'function') throw new AttachError('this Node cannot open another process inspector');
    debugProcess.call(process, pid);
    return;
  }
  process.kill(pid, 'SIGUSR1');
}

async function waitForInspector(edges: AttachEdges, port: number): Promise<string | null> {
  const deadline = Date.now() + OPEN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const url = await edges.findInspector(port);
    if (url !== null) return url;
    await sleep(100);
  }
  return null;
}

export interface AttachResult {
  readonly exitCode: number;
  readonly sources: readonly SourceReport[];
}

/** What attaching reaches outside the CLI; tests pass fakes. */
export interface AttachEdges {
  /** Throws AttachError when there is no such process, or it may not be signalled. */
  assertAlive(pid: number): void;
  /** Throws AttachError unless `pid` is a Node binary: SIGUSR1 terminates anything else. */
  assertNode(pid: number): Promise<void>;
  openInspector(pid: number): void;
  findInspector(port: number): Promise<string | null>;
  connect(url: string): Promise<Cdp>;
  openSession(args: SessionArgs): Promise<Session>;
  /** Absolute path of the attach bundle. */
  bundle(): string;
}

const EDGES: AttachEdges = {
  assertAlive,
  assertNode,
  openInspector,
  findInspector,
  connect: connectCdp,
  openSession,
  bundle: () => assets().attach,
};

export async function attach(options: AttachOptions, stderr: NodeJS.WritableStream = process.stderr): Promise<AttachResult> {
  // Before anything is opened: Ctrl+C from here on detaches cleanly instead of killing the CLI.
  const interrupts = new Interrupts();
  try {
    return await attachWith({ options, stderr, interrupts, edges: EDGES });
  } finally {
    interrupts.dispose();
  }
}

export interface AttachArgs {
  readonly options: AttachOptions;
  readonly stderr: NodeJS.WritableStream;
  /** Installed by the caller before this runs; an interrupt at any point detaches. */
  readonly interrupts: Interrupts;
  readonly edges: AttachEdges;
}

export async function attachWith({ options, stderr, interrupts, edges }: AttachArgs): Promise<AttachResult> {
  const { pid, inspectPort } = options;
  edges.assertAlive(pid);
  const existing = await edges.findInspector(inspectPort);
  const opened = existing === null;
  if (opened) await edges.assertNode(pid);
  if (interrupts.count > 0) throw new AttachError('interrupted before attaching');

  let cdp: Cdp | null = null;
  /** `cdp` is the target's own inspector: agents can be stopped, and the inspector closed, through it. */
  let verified = false;
  /** Nothing left in the target to clean up. */
  let clean = false;
  let session: Session | null = null;
  /** Every thread an agent went (or may have gone) into, the main one first. */
  const threads: Cdp[] = [];
  const workers = new Map<string, Promise<Injected | null>>();
  const duration = new AbortController();
  /** Aborted when detaching starts: no more acks to the agents. */
  const acking = new AbortController();
  try {
    let url = existing;
    if (url === null) {
      edges.openInspector(pid);
      url = await waitForInspector(edges, inspectPort);
      if (url === null) {
        clean = true;
        // The signal may have opened it elsewhere: an open inspector runs any code, so close it.
        const closed = inspectPort !== DEFAULT_INSPECT_PORT && (await closeInspectorOf({ edges, pid, port: DEFAULT_INSPECT_PORT }));
        throw new AttachError(
          `pid ${pid} did not open its inspector on 127.0.0.1:${inspectPort}.${closed ? ` It opened one on ${DEFAULT_INSPECT_PORT} instead, which xray closed again; attach with --inspect-port ${DEFAULT_INSPECT_PORT}.` : ' Is it a Node.js process? Started with --inspect on another port (use --inspect-port), or with --disable-sigusr1?'}`,
        );
      }
    }

    const main = await edges.connect(url);
    cdp = main;
    const actual = await evaluate(main, 'process.pid');
    if (actual !== pid) throw new AttachError(`the inspector on 127.0.0.1:${inspectPort} belongs to pid ${String(actual)}, not ${pid}`);
    verified = true;
    const title = String(await evaluate(main, "process.argv.slice(1).map((a) => a.split(/[\\\\/]/).pop()).join(' ')"));
    const label = `attach ${pid} (node ${title})`;

    const opening = await edges.openSession({ options, status: { state: 'running', command: label }, stderr, probeHost: true });
    session = opening;
    const collector = opening.collector;
    const bundle = edges.bundle();
    threads.push(main);
    const injectedMain = await inject({ cdp: main, collector, intervalMs: options.intervalMs, bundle, acking: acking.signal });
    stderr.write(`xray: attached to pid ${pid} (node ${title}). ${options.durationMs === null ? 'Ctrl+C to detach.' : `Detaching in ${Math.round(options.durationMs / 1000)} s.`}\n`);

    // Worker threads: each one is its own session, tunnelled through the main thread's inspector.
    main.on('NodeWorker.attachedToWorker', (params) => {
      const sessionId: unknown = typeof params === 'object' && params !== null ? Reflect.get(params, 'sessionId') : undefined;
      if (typeof sessionId !== 'string' || workers.has(sessionId)) return;
      const info: unknown = Reflect.get(params as object, 'workerInfo');
      const name: unknown = typeof info === 'object' && info !== null ? Reflect.get(info, 'title') : undefined;
      const worker = workerCdp(main, sessionId);
      threads.push(worker);
      workers.set(
        sessionId,
        inject({ cdp: worker, collector, intervalMs: options.intervalMs, bundle, acking: acking.signal }).then(
          (injected) => {
            stderr.write(`xray: + ${typeof name === 'string' ? name : 'worker'}\n`);
            return injected;
          },
          () => null, // the worker ended before the agent was in
        ),
      );
    });
    await main.send('NodeWorker.enable', { waitForDebuggerOnStart: false });

    const reason = await Promise.race([
      // Also an interrupt that came while attaching.
      interrupts.wait(0).then(() => 'interrupt' as const),
      main.closed.then(() => 'gone' as const),
      ...(options.durationMs === null ? [] : [sleepUnless(options.durationMs, duration.signal).then(() => 'duration' as const)]),
    ]);

    const injected = [...(await Promise.all(workers.values())).filter((w): w is Injected => w !== null), injectedMain];
    acking.abort();
    if (reason !== 'gone') await detach({ cdp: main, opened, threads });
    clean = true;
    for (const agent of injected) agent.link.closed();
    stderr.write(reason === 'gone' ? `xray: pid ${pid} went away.\n` : `xray: detached from pid ${pid}${opened ? ', inspector closed' : ''}.\n`);

    if (opening.dashboard !== null) {
      opening.dashboard.setStatus({ state: 'detached', command: label });
      stderr.write('xray: the dashboard stays up. Ctrl+C to finish.\n');
      await interrupts.wait();
    }
    // Only now: the agents are stopped and an inspector xray opened is closed, so quitting is safe.
    interrupts.finishing({ stderr });
    const outcome = await opening.finish();
    return { exitCode: outcome.failed ? 1 : 0, sources: outcome.sources };
  } finally {
    duration.abort();
    acking.abort();
    if (!clean) {
      if (verified && cdp !== null) {
        await Promise.all(workers.values());
        await detach({ cdp, opened, threads });
      } else if (opened) {
        // Not (known to be) the target's inspector: only close what is verifiably the target's.
        await closeInspectorOf({ edges, pid, port: inspectPort });
        if (inspectPort !== DEFAULT_INSPECT_PORT) await closeInspectorOf({ edges, pid, port: DEFAULT_INSPECT_PORT });
      }
    }
    cdp?.close();
    await session?.close();
  }
}

interface InjectArgs {
  /** The main thread's session or a worker's. */
  readonly cdp: Cdp;
  readonly collector: Collector;
  readonly intervalMs: number;
  readonly bundle: string;
  /** Aborts when detaching starts. */
  readonly acking: AbortSignal;
}

interface Injected {
  readonly cdp: Cdp;
  readonly link: OpenLink;
}

const unrefTimeout: Schedule = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

/** Puts the agent into one thread: binding for its messages, `require` of the bundle, start. */
async function inject({ cdp, collector, intervalMs, bundle, acking }: InjectArgs): Promise<Injected> {
  const link = collector.open({
    send: (command) => {
      evaluate(cdp, `${API}.command(${JSON.stringify(JSON.stringify(command))})`).catch(() => undefined);
    },
    close: () => cdp.close(),
  });
  // Tells the agent how much arrived since it was injected; never awaited on the message path.
  const acks = new AckThrottle({
    send: (total) => {
      evaluate(cdp, `${API}.ack(${total})`).catch(() => undefined);
    },
    schedule: unrefTimeout,
  });
  const stopAcks = (): void => acks.stop();
  if (acking.aborted) stopAcks();
  acking.addEventListener('abort', stopAcks, { once: true });
  // A pool that churns workers must not leave a listener per worker behind.
  void cdp.closed.then(() => {
    stopAcks();
    acking.removeEventListener('abort', stopAcks);
  });
  cdp.on('Runtime.bindingCalled', (params) => {
    if (typeof params !== 'object' || params === null || Reflect.get(params, 'name') !== BINDING) return;
    const payload: unknown = Reflect.get(params, 'payload');
    if (typeof payload !== 'string') return;
    link.line(payload);
    acks.received(payload.length);
  });
  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Runtime.addBinding', { name: BINDING });
    await evaluate(cdp, injection({ bundle, binding: BINDING, intervalMs }), { commandLineApi: true });
  } catch (error) {
    link.closed();
    throw error;
  }
  return { cdp, link };
}

interface CloseArgs {
  readonly edges: AttachEdges;
  readonly pid: number;
  readonly port: number;
}

/** Closes the inspector on `port` if it belongs to `pid`; true when it did. */
async function closeInspectorOf({ edges, pid, port }: CloseArgs): Promise<boolean> {
  const url = await edges.findInspector(port);
  if (url === null) return false;
  const cdp = await edges.connect(url).catch(() => null);
  if (cdp === null) return false;
  try {
    if ((await evaluate(cdp, 'process.pid')) !== pid) return false;
    void evaluate(cdp, CLOSE_INSPECTOR, { commandLineApi: true }).catch(() => undefined);
    await sleep(100);
    return true;
  } catch {
    return false;
  } finally {
    cdp.close();
  }
}

interface DetachArgs {
  /** The main thread's session. */
  readonly cdp: Cdp;
  /** xray opened the inspector, so it closes it again. */
  readonly opened: boolean;
  /** Every thread an agent went (or may have gone) into, the main one included. */
  readonly threads: readonly Cdp[];
}

/**
 * Stops every agent, lets their last messages arrive, removes the bindings, closes the inspector.
 * Each step tolerates a thread without an agent (an injection that failed half way).
 */
async function detach({ cdp, opened, threads }: DetachArgs): Promise<void> {
  await Promise.all(threads.map((thread) => evaluate(thread, `${API}?.stop()`).catch(() => undefined)));
  await sleep(SETTLE_MS);
  await Promise.all(threads.map((thread) => thread.send('Runtime.removeBinding', { name: BINDING }).catch(() => undefined)));
  for (const thread of threads) if (thread !== cdp) thread.close();
  try {
    await cdp.send('NodeWorker.disable').catch(() => undefined);
    // Closing the inspector ends this very connection: do not wait for an answer.
    if (opened) void evaluate(cdp, CLOSE_INSPECTOR, { commandLineApi: true }).catch(() => undefined);
    await sleep(100);
  } catch {
    // The process may be exiting; nothing left to clean up then.
  }
}
