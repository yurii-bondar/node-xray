// `xray attach <pid>`: profile a process that is already running. Opens its inspector
// (SIGUSR1), injects the agent bundle with `Runtime.evaluate`, receives its messages through a
// CDP binding, and on detach removes it and closes the inspector again if xray opened it.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SourceReport } from '@node-xray/core';
import type { AttachOptions } from './args.js';
import { assets } from './assets.js';
import { connectCdp, evaluate, findInspector, workerCdp, type Cdp } from './cdp.js';
import type { Collector, OpenLink } from './collector.js';
import { openSession, waitForInterrupt } from './session.js';

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

async function waitForInspector(port: number): Promise<string | null> {
  const deadline = Date.now() + OPEN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const url = await findInspector(port);
    if (url !== null) return url;
    await sleep(100);
  }
  return null;
}

export interface AttachResult {
  readonly exitCode: number;
  readonly sources: readonly SourceReport[];
}

export async function attach(options: AttachOptions, stderr: NodeJS.WritableStream = process.stderr): Promise<AttachResult> {
  const { pid, inspectPort } = options;
  assertAlive(pid);

  let url = await findInspector(inspectPort);
  const opened = url === null;
  if (url === null) {
    await assertNode(pid);
    openInspector(pid);
    url = await waitForInspector(inspectPort);
    if (url === null) {
      // The signal may have opened it elsewhere: an open inspector runs any code, so close it.
      const closed = inspectPort !== DEFAULT_INSPECT_PORT && (await closeInspectorOf(pid, DEFAULT_INSPECT_PORT));
      throw new AttachError(
        `pid ${pid} did not open its inspector on 127.0.0.1:${inspectPort}.${closed ? ` It opened one on ${DEFAULT_INSPECT_PORT} instead, which xray closed again; attach with --inspect-port ${DEFAULT_INSPECT_PORT}.` : ' Is it a Node.js process? Started with --inspect on another port (use --inspect-port), or with --disable-sigusr1?'}`,
      );
    }
  }

  const cdp = await connectCdp(url);
  let session: Awaited<ReturnType<typeof openSession>> | null = null;
  try {
    const actual = await evaluate(cdp, 'process.pid');
    if (actual !== pid) throw new AttachError(`the inspector on 127.0.0.1:${inspectPort} belongs to pid ${String(actual)}, not ${pid}`);
    const title = String(await evaluate(cdp, "process.argv.slice(1).map((a) => a.split(/[\\\\/]/).pop()).join(' ')"));
    const label = `attach ${pid} (node ${title})`;

    session = await openSession({ options, status: { state: 'running', command: label }, stderr, probeHost: true });
    const collector = session.collector;
    const main = await inject({ cdp, collector, intervalMs: options.intervalMs });
    stderr.write(`xray: attached to pid ${pid} (node ${title}). ${options.durationMs === null ? 'Ctrl+C to detach.' : `Detaching in ${Math.round(options.durationMs / 1000)} s.`}\n`);

    // Worker threads: each one is its own session, tunnelled through the main thread's inspector.
    const workers = new Map<string, Promise<Injected | null>>();
    cdp.on('NodeWorker.attachedToWorker', (params) => {
      const sessionId: unknown = typeof params === 'object' && params !== null ? Reflect.get(params, 'sessionId') : undefined;
      if (typeof sessionId !== 'string' || workers.has(sessionId)) return;
      const info: unknown = Reflect.get(params as object, 'workerInfo');
      const name: unknown = typeof info === 'object' && info !== null ? Reflect.get(info, 'title') : undefined;
      const worker = workerCdp(cdp, sessionId);
      workers.set(
        sessionId,
        inject({ cdp: worker, collector, intervalMs: options.intervalMs }).then(
          (injected) => {
            stderr.write(`xray: + ${typeof name === 'string' ? name : 'worker'}\n`);
            return injected;
          },
          () => null, // the worker ended before the agent was in
        ),
      );
    });
    await cdp.send('NodeWorker.enable', { waitForDebuggerOnStart: false });

    const reason = await Promise.race([
      waitForInterrupt().then(() => 'interrupt' as const),
      cdp.closed.then(() => 'gone' as const),
      ...(options.durationMs === null ? [] : [sleep(options.durationMs).then(() => 'duration' as const)]),
    ]);

    const injected = [...(await Promise.all(workers.values())).filter((w): w is Injected => w !== null), main];
    if (reason !== 'gone') await detach({ cdp, opened, agents: injected });
    for (const agent of injected) agent.link.closed();
    stderr.write(reason === 'gone' ? `xray: pid ${pid} went away.\n` : `xray: detached from pid ${pid}${opened ? ', inspector closed' : ''}.\n`);

    if (session.dashboard !== null) {
      session.dashboard.setStatus({ state: 'detached', command: label });
      stderr.write('xray: the dashboard stays up. Ctrl+C to finish.\n');
      await waitForInterrupt();
    }
    const outcome = await session.finish();
    return { exitCode: outcome.failed ? 1 : 0, sources: outcome.sources };
  } finally {
    cdp.close();
    await session?.close();
  }
}

interface InjectArgs {
  /** The main thread's session or a worker's. */
  readonly cdp: Cdp;
  readonly collector: Collector;
  readonly intervalMs: number;
}

interface Injected {
  readonly cdp: Cdp;
  readonly link: OpenLink;
}

/** Puts the agent into one thread: binding for its messages, `require` of the bundle, start. */
async function inject({ cdp, collector, intervalMs }: InjectArgs): Promise<Injected> {
  const link = collector.open({
    send: (command) => {
      evaluate(cdp, `${API}.command(${JSON.stringify(JSON.stringify(command))})`).catch(() => undefined);
    },
    close: () => cdp.close(),
  });
  cdp.on('Runtime.bindingCalled', (params) => {
    if (typeof params !== 'object' || params === null || Reflect.get(params, 'name') !== BINDING) return;
    const payload: unknown = Reflect.get(params, 'payload');
    if (typeof payload === 'string') link.line(payload);
  });
  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Runtime.addBinding', { name: BINDING });
    await evaluate(cdp, injection({ bundle: assets().attach, binding: BINDING, intervalMs }), { commandLineApi: true });
  } catch (error) {
    link.closed();
    throw error;
  }
  return { cdp, link };
}

/** Closes the inspector on `port` if it belongs to `pid`; true when it did. */
async function closeInspectorOf(pid: number, port: number): Promise<boolean> {
  const url = await findInspector(port);
  if (url === null) return false;
  const cdp = await connectCdp(url).catch(() => null);
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
  /** Every thread with an agent in it, the main one included. */
  readonly agents: readonly Injected[];
}

/** Stops every agent, lets their last messages arrive, removes the bindings, closes the inspector. */
async function detach({ cdp, opened, agents }: DetachArgs): Promise<void> {
  await Promise.all(agents.map((agent) => evaluate(agent.cdp, `${API}.stop()`).catch(() => undefined)));
  await sleep(SETTLE_MS);
  await Promise.all(agents.map((agent) => agent.cdp.send('Runtime.removeBinding', { name: BINDING }).catch(() => undefined)));
  for (const agent of agents) if (agent.cdp !== cdp) agent.cdp.close();
  try {
    await cdp.send('NodeWorker.disable').catch(() => undefined);
    // Closing the inspector ends this very connection: do not wait for an answer.
    if (opened) void evaluate(cdp, CLOSE_INSPECTOR, { commandLineApi: true }).catch(() => undefined);
    await sleep(100);
  } catch {
    // The process may be exiting; nothing left to clean up then.
  }
}
