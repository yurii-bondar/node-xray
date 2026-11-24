// `xray run`: launch the command with the agent preloaded (via NODE_OPTIONS, so child
// processes and worker threads get it too), watch until it exits, summarise.

import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SourceReport } from '@node-xray/core';
import type { RunOptions } from './args.js';
import { assets } from './assets.js';
import { windowsSpawnPlan, type SpawnPlan } from './command.js';
import { Interrupts, openSession, type Session } from './session.js';

/** After the command exits, how long to wait for agents' last messages. */
const DRAIN_MS = 1000;

/** NODE_OPTIONS takes double-quoted values, so paths with spaces survive. */
export function withPreload(nodeOptions: string | undefined, agentPath: string): string {
  const quoted = `"${agentPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return [nodeOptions?.trim(), `--require ${quoted}`].filter((part) => part !== undefined && part !== '').join(' ');
}

/** Variables for xray itself that the profiled program and its children must not see: the token opens `/api`. */
const PRIVATE_ENV: ReadonlySet<string> = new Set(['XRAY_DASHBOARD_TOKEN', 'XRAY_DASHBOARD_HOST']);

export interface ChildEnvArgs {
  /** The preload bundle. */
  readonly agent: string;
  readonly socketPath: string;
  readonly intervalMs: number;
}

/** The command's environment: ours without xray's private variables, plus what the agent needs. */
export function childEnv(parent: NodeJS.ProcessEnv, { agent, socketPath, intervalMs }: ChildEnvArgs): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Names are case-insensitive on Windows.
  for (const [name, value] of Object.entries(parent)) if (!PRIVATE_ENV.has(name.toUpperCase())) env[name] = value;
  env['NODE_OPTIONS'] = withPreload(parent['NODE_OPTIONS'], agent);
  env['XRAY_SOCKET'] = socketPath;
  env['XRAY_INTERVAL_MS'] = String(intervalMs);
  return env;
}

function spawnPlan(command: string, args: readonly string[]): SpawnPlan {
  if (process.platform !== 'win32') return { file: command, args, verbatim: false };
  return windowsSpawnPlan(command, args, {
    path: process.env['PATH'] ?? '',
    pathext: process.env['PATHEXT'] ?? '',
    cwd: process.cwd(),
    comspec: process.env['ComSpec'] ?? 'cmd.exe',
    isFile: (file) => statSync(file, { throwIfNoEntry: false })?.isFile() ?? false,
  });
}

export interface StartArgs {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: 'inherit' | 'pipe';
}

/** Spawns the command as `xray run` does: on Windows a `.cmd` / `.bat` (npm, npx) through cmd.exe. */
export function startCommand({ command, args, env, stdio }: StartArgs): ChildProcess {
  const plan = spawnPlan(command, args);
  return spawn(plan.file, [...plan.args], { stdio, env, windowsVerbatimArguments: plan.verbatim });
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

/**
 * Ctrl+C reaches the whole process group: the command gets it directly and we wait for it (the
 * run's `Interrupts` keeps it from killing xray). SIGTERM and SIGHUP are passed on.
 */
async function waitForExit(child: ChildProcess, command: string, stderr: NodeJS.WritableStream): Promise<Exit> {
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
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
    process.off('SIGTERM', forward);
    process.off('SIGHUP', forward);
  }
}

export interface ExitArgs {
  /** The command's exit code (128 + n when a signal ended it). */
  readonly code: number;
  readonly signal: NodeJS.Signals | null;
  readonly budgetsFailed: boolean;
}

/**
 * The command's own failure wins, else a broken budget fails the run. A service stopped with
 * Ctrl+C or SIGTERM (how a profiled server or a load test ends) is a clean stop, not a failure.
 */
export function runExitCode({ code, signal, budgetsFailed }: ExitArgs): number {
  const stopped = signal === 'SIGINT' || signal === 'SIGTERM';
  if (stopped || code === 0) return budgetsFailed ? 1 : 0;
  return code;
}

export interface RunResult {
  readonly exitCode: number;
  readonly sources: readonly SourceReport[];
}

export async function run(options: RunOptions, stderr: NodeJS.WritableStream = process.stderr): Promise<RunResult> {
  const interrupts = new Interrupts();
  let session: Session | null = null;
  let dir: string | null = null;
  try {
    session = await openSession({ options, status: { state: 'running', command: commandLine(options) }, stderr, probeHost: true });
    dir = await mkdtemp(path.join(os.tmpdir(), 'xray-'));
    const socketPath = socketPathIn(dir);
    await session.collector.listen(socketPath);
    const child = startCommand({
      command: options.command,
      args: options.args,
      env: childEnv(process.env, { agent: assets().agent, socketPath, intervalMs: options.intervalMs }),
      stdio: 'inherit',
    });
    const exit = await waitForExit(child, options.command, stderr);
    const code = exitCode(exit.code, exit.signal);
    await session.collector.whenDisconnected(DRAIN_MS);

    if (session.dashboard !== null) {
      session.dashboard.setStatus({ state: 'exited', command: commandLine(options), code });
      stderr.write(`xray: '${options.command}' exited with ${code}; the dashboard stays up. Ctrl+C to finish.\n`);
      await interrupts.wait();
    }
    const tempDir = dir;
    interrupts.finishing({ stderr, cleanup: () => rmSync(tempDir, { recursive: true, force: true }) });
    const outcome = await session.finish();
    return { exitCode: runExitCode({ code, signal: exit.signal, budgetsFailed: outcome.failed }), sources: outcome.sources };
  } finally {
    await session?.close();
    if (dir !== null) await rm(dir, { recursive: true, force: true });
    interrupts.dispose();
  }
}
