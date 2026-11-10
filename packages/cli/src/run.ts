// `xray run`: launch the command with the agent preloaded (via NODE_OPTIONS, so child
// processes and worker threads get it too), watch until it exits, summarise.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SourceReport } from '@node-xray/core';
import type { RunOptions } from './args.js';
import { assets } from './assets.js';
import { openSession, waitForInterrupt } from './session.js';

/** After the command exits, how long to wait for agents' last messages. */
const DRAIN_MS = 1000;

/** NODE_OPTIONS takes double-quoted values, so paths with spaces survive. */
export function withPreload(nodeOptions: string | undefined, agentPath: string): string {
  const quoted = `"${agentPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return [nodeOptions?.trim(), `--require ${quoted}`].filter((part) => part !== undefined && part !== '').join(' ');
}

function socketPathIn(dir: string): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\xray-${process.pid}-${path.basename(dir)}` : path.join(dir, 'agent.sock');
}

function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const number = signal === null ? undefined : os.constants.signals[signal];
  return number === undefined ? 1 : 128 + number;
}

function commandLine(options: RunOptions): string {
  return [options.command, ...options.args].join(' ');
}

interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** Ctrl+C reaches the whole process group: the command gets it directly and we wait for it. */
async function waitForExit(child: ChildProcess, command: string, stderr: NodeJS.WritableStream): Promise<Exit> {
  const ignore = (): void => undefined;
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  process.on('SIGINT', ignore);
  process.on('SIGTERM', forward);
  process.on('SIGHUP', forward);
  try {
    return await new Promise<Exit>((resolve) => {
      child.once('error', (error) => {
        stderr.write(`xray: cannot start '${command}': ${error.message}\n`);
        resolve({ code: 127, signal: null });
      });
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    process.off('SIGINT', ignore);
    process.off('SIGTERM', forward);
    process.off('SIGHUP', forward);
  }
}

export interface RunResult {
  readonly exitCode: number;
  readonly sources: readonly SourceReport[];
}

export async function run(options: RunOptions, stderr: NodeJS.WritableStream = process.stderr): Promise<RunResult> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'xray-'));
  const session = await openSession({ options, status: { state: 'running', command: commandLine(options) }, stderr, probeHost: true });
  try {
    const socketPath = socketPathIn(dir);
    await session.collector.listen(socketPath);
    const child = spawn(options.command, [...options.args], {
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_OPTIONS: withPreload(process.env['NODE_OPTIONS'], assets().agent),
        XRAY_SOCKET: socketPath,
        XRAY_INTERVAL_MS: String(options.intervalMs),
      },
    });
    const exit = await waitForExit(child, options.command, stderr);
    const code = exitCode(exit.code, exit.signal);
    await session.collector.whenDisconnected(DRAIN_MS);

    if (session.dashboard !== null) {
      session.dashboard.setStatus({ state: 'exited', command: commandLine(options), code });
      stderr.write(`xray: '${options.command}' exited with ${code}; the dashboard stays up. Ctrl+C to finish.\n`);
      await waitForInterrupt();
    }
    const outcome = await session.finish();
    // The command's own failure wins; otherwise a broken budget fails the run.
    return { exitCode: code === 0 && outcome.failed ? 1 : code, sources: outcome.sources };
  } finally {
    await session.close();
    await rm(dir, { recursive: true, force: true });
  }
}
