// What `run` and `attach` share once agents are talking: the collector and its listeners
// (recording, dashboard, host probe), and the summary, report and profiles at the end.

import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { promisify } from 'node:util';
import { budgetsFailed, buildHostReport, buildReport, checkBudgets, encodeClosedRecord, encodeRecord, type AgentCommand, type BudgetResult, type HostReport, type SourcePosition, type SourceReport } from '@node-xray/core';
import type { SessionOptions } from './args.js';
import { assets } from './assets.js';
import { Collector, MAX_ENDED_SOURCES } from './collector.js';
import { formatBudgets, formatHost, formatReport } from './format.js';
import { HostProbe } from './host.js';
import { exportProfile, type ProfileKind } from './profiles.js';
import { DashboardServer, parseExtraHost, type ExtraHost, type RunStatus } from './server.js';
import { SourceMapResolver } from './sourcemaps.js';

const HOST_PROBE_MS = 2000;

/** Something the user can fix (a recording path, a busy port, a bad variable): reported as one line. */
export class SessionError extends Error {
  override name = 'SessionError';
}

export function startupCommands(options: SessionOptions): AgentCommand[] {
  const commands: AgentCommand[] = [];
  if (options.cpu) {
    // Short windows keep the live flame graph moving; the summary merges them anyway.
    commands.push({ type: 'cpu-profile-start', samplingIntervalUs: 1000, windowMs: options.ui ? 1000 : 5000 });
  }
  if (options.heap) commands.push({ type: 'heap-sampling-start', samplingIntervalBytes: 32 * 1024, windowMs: options.ui ? 2000 : 5000 });
  if (options.fs) commands.push({ type: 'fs-timing-start' });
  if (options.traceLoopMs !== null) commands.push({ type: 'loop-trace-start', flushMs: 250, maxEventsPerFlush: 5000, durationMs: options.traceLoopMs });
  return commands;
}

/** Polls swap and GPUs into the collector; returns the stop function. */
function startHostProbe(collector: Collector): () => void {
  const execFileAsync = promisify(execFile);
  const probe = new HostProbe({
    exec: async (file, args) => (await execFileAsync(file, [...args], { timeout: 5000 })).stdout,
    readText: (file) => readFile(file, 'utf8'),
    platform: process.platform,
    now: () => Date.now(),
  });
  let probing = false;
  const tick = (): void => {
    if (probing) return;
    probing = true;
    probe
      .sample(collector.pids())
      .then((sample) => collector.applyHost(sample))
      .catch(() => undefined)
      .finally(() => (probing = false));
  };
  tick();
  const timer = setInterval(tick, HOST_PROBE_MS);
  return () => clearInterval(timer);
}

export function openBrowser(url: string): void {
  const [file, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  const opener = spawn(file, args, { stdio: 'ignore', detached: true });
  opener.on('error', () => undefined);
  opener.unref();
}

type Interrupt = 'SIGINT' | 'SIGTERM';

/** Where interrupts come from: `process`, or an emitter in tests. */
export interface SignalSource {
  on(signal: Interrupt, listener: () => void): unknown;
  off(signal: Interrupt, listener: () => void): unknown;
}

/** Exit code of a CLI that quit on a second interrupt during the summary (128 + SIGINT). */
export const FORCED_QUIT_CODE = 130;

export interface FinishingArgs {
  readonly stderr: NodeJS.WritableStream;
  /** What can be cleaned up synchronously before a forced quit (temp files). */
  readonly cleanup?: () => void;
}

/**
 * Ctrl+C and SIGTERM, handled from the moment a command starts until the CLI is done. While it is
 * installed no interrupt takes the default action (killing the CLI half way), so cleanup (closing
 * an inspector xray opened, removing temp files) always happens first. Before the summary an
 * interrupt means what the command makes of it (stop the program, end the dashboard wait,
 * detach). Once `finishing` was called (the inspector is closed by then) the first interrupt says
 * the summary is still being written, and the second quits without it.
 */
export class Interrupts {
  #count = 0;
  #waiting: Array<() => void> = [];
  #finishing: Required<FinishingArgs> | null = null;
  #duringFinish = 0;
  readonly #signals: SignalSource;
  readonly #exit: (code: number) => void;
  readonly #handle = (): void => {
    this.#count++;
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const resolve of waiting) resolve();
    if (this.#finishing === null) return;
    this.#duringFinish++;
    if (this.#duringFinish === 1) {
      this.#finishing.stderr.write('xray: finishing the summary; Ctrl+C again to quit without it\n');
      return;
    }
    try {
      this.#finishing.cleanup();
    } catch {
      // Quitting anyway: what is left is the operating system's temp directory.
    }
    this.#exit(FORCED_QUIT_CODE);
  };

  /** `exit` ends the CLI on a forced quit; tests pass a fake. */
  constructor(signals: SignalSource = process, exit: (code: number) => void = (code) => process.exit(code)) {
    this.#signals = signals;
    this.#exit = exit;
    signals.on('SIGINT', this.#handle);
    signals.on('SIGTERM', this.#handle);
  }

  /** Interrupts so far. */
  get count(): number {
    return this.#count;
  }

  /** Resolves once more than `seen` interrupts arrived: by default on the next one. */
  wait(seen: number = this.#count): Promise<void> {
    if (this.#count > seen) return Promise.resolve();
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  /**
   * The summary, report and profiles are being written: interrupts from here on (not the ones
   * before) warn once, then quit with `FORCED_QUIT_CODE` after `cleanup`.
   */
  finishing({ stderr, cleanup = () => undefined }: FinishingArgs): void {
    this.#finishing = { stderr, cleanup };
    this.#duringFinish = 0;
  }

  /** The default actions apply again. */
  dispose(): void {
    this.#signals.off('SIGINT', this.#handle);
    this.#signals.off('SIGTERM', this.#handle);
  }
}

export interface RecordingArgs {
  readonly stream: Writable;
  /** For the message. */
  readonly file: string;
  readonly stderr: NodeJS.WritableStream;
}

/** The `--record` file. A write error stops the recording, says so once, and the run goes on. */
export class Recording {
  readonly #stream: Writable;
  #failed = false;

  constructor({ stream, file, stderr }: RecordingArgs) {
    this.#stream = stream;
    stream.on('error', (error: Error) => {
      if (this.#failed) return;
      this.#failed = true;
      stderr.write(`xray: recording to ${file} stopped: ${error.message}\n`);
    });
  }

  write(line: string): void {
    if (!this.#failed && !this.#stream.destroyed && !this.#stream.writableEnded) this.#stream.write(line);
  }

  close(): Promise<void> {
    if (this.#failed || this.#stream.destroyed || this.#stream.writableEnded) return Promise.resolve();
    return new Promise((done) => this.#stream.end(() => done()));
  }
}

/** Opens the file before anything starts: a missing directory fails the command cleanly. */
async function openRecording(file: string, stderr: NodeJS.WritableStream): Promise<Recording> {
  const stream = createWriteStream(file);
  try {
    await once(stream, 'open');
  } catch (error) {
    throw new SessionError(`cannot write the recording ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return new Recording({ stream, file, stderr });
}

/** `XRAY_DASHBOARD_HOST` (see `parseExtraHost`); unset or empty = none. */
function extraHost(value: string | undefined): ExtraHost | null {
  if (value === undefined || value.trim() === '') return null;
  const host = parseExtraHost(value);
  if (host === null) throw new SessionError(`XRAY_DASHBOARD_HOST: expected one host name or host:port, got '${value}'`);
  return host;
}

interface Summary {
  readonly sources: SourceReport[];
  readonly host: HostReport;
}

/** Every code location a report shows, for source map lookup. */
function positionsOf(report: SourceReport): SourcePosition[] {
  const out: SourcePosition[] = [...report.hotFunctions, ...report.topAllocations];
  for (const insight of report.insights) {
    if (insight.culprit !== null) out.push(insight.culprit);
    if (insight.culpritStack !== null) out.push(...insight.culpritStack.frames.filter((frame) => frame.url !== ''));
  }
  return out;
}

async function summarize(collector: Collector, resolver: SourceMapResolver, stderr: NodeJS.WritableStream): Promise<Summary> {
  const sources = [...collector.sources.values()].flatMap((source) => {
    const report = buildReport(source.timeline);
    return report === null ? [] : [report];
  });
  const host = buildHostReport(collector.host.hostSamples());
  const originals = await resolver.resolveAll(sources.flatMap(positionsOf));
  const blocks = sources.map((report) => formatReport(report, { cwd: process.cwd(), originals }));
  const hostBlock = formatHost(host);
  if (hostBlock !== null) blocks.push(hostBlock);
  const errors = [...collector.sources.values()].flatMap((source) => source.timeline.errors().map((e) => `  ${source.id}: ${e}`));
  if (errors.length > 0) blocks.push(`── agent errors\n${errors.join('\n')}`);
  if (collector.droppedSources > 0) {
    blocks.push(`── ${collector.droppedSources} more ended processes/threads not shown: only the ${MAX_ENDED_SOURCES} that ended last are kept`);
  }
  stderr.write(blocks.length > 0 ? `\nxray\n${blocks.join('\n')}\n` : '\nxray: no Node.js process connected (is the command a Node program?)\n');
  return { sources, host };
}

async function writeProfiles(collector: Collector, dir: string, stderr: NodeJS.WritableStream): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const source of collector.sources.values()) {
    const kinds: readonly ProfileKind[] = ['cpu', 'heap'];
    for (const kind of kinds) {
      const file = exportProfile(source.timeline, kind);
      if (file === null) continue;
      const target = path.join(dir, file.fileName);
      await writeFile(target, file.json);
      stderr.write(`xray: wrote ${target}\n`);
    }
  }
}

export interface SessionArgs {
  readonly options: SessionOptions;
  /** What the dashboard says is being watched (the command, or the attached process). */
  readonly status: RunStatus;
  readonly stderr: NodeJS.WritableStream;
  /** Poll this machine's swap and GPUs (not for a replay: they belong to another run). */
  readonly probeHost: boolean;
}

export interface Outcome {
  readonly sources: readonly SourceReport[];
  readonly budgets: readonly BudgetResult[];
  /** At least one budget was broken. */
  readonly failed: boolean;
}

export interface Session {
  readonly collector: Collector;
  /** Null without `--ui`. */
  readonly dashboard: DashboardServer | null;
  /** Prints the summary and budgets, writes `--report` and `--profiles`. */
  finish(): Promise<Outcome>;
  close(): Promise<void>;
}

export async function openSession({ options, status, stderr, probeHost }: SessionArgs): Promise<Session> {
  // Everything that can fail on the user's input fails here, before a command is spawned or an inspector opened.
  const extra = options.ui === null ? null : extraHost(process.env['XRAY_DASHBOARD_HOST']);
  const recording = options.record === null ? null : await openRecording(options.record, stderr);
  const collector = new Collector({ startupCommands: startupCommands(options) });
  const resolver = new SourceMapResolver((file) => readFile(file, 'utf8'));
  if (recording !== null) {
    collector.onRecord({
      record: (connection, raw) => recording.write(`${encodeRecord(connection, raw)}\n`),
      closed: (connection) => recording.write(`${encodeClosedRecord(connection)}\n`),
    });
  }
  let dashboard: DashboardServer | null = null;
  if (options.ui !== null) {
    dashboard = new DashboardServer({
      collector,
      resolver,
      staticDir: assets().dashboard,
      port: options.ui.port,
      status,
      // The VS Code extension opens the dashboard itself, so it picks the token.
      token: process.env['XRAY_DASHBOARD_TOKEN'] ?? null,
      extraHost: extra,
    });
    let url: string;
    try {
      url = await dashboard.start();
    } catch (error) {
      await recording?.close();
      throw new SessionError(`cannot serve the dashboard on 127.0.0.1:${options.ui.port}: ${error instanceof Error ? error.message : String(error)}`);
    }
    stderr.write(`xray: dashboard ${url}\n`);
    if (options.ui.open) openBrowser(url);
  }
  const stopProbe = probeHost ? startHostProbe(collector) : () => undefined;
  const server = dashboard;

  return {
    collector,
    dashboard,
    async finish() {
      stopProbe();
      const { sources, host } = await summarize(collector, resolver, stderr);
      const budgets = checkBudgets(options.budgets, sources);
      if (budgets.length > 0) stderr.write(`${formatBudgets(budgets)}\n`);
      if (options.report !== null) {
        // droppedSources: ended processes/threads beyond the kept ones, not in `sources` (added field; 0 for most runs).
        const report = { sources, host, budgets, droppedSources: collector.droppedSources };
        await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
      }
      if (options.profiles !== null) await writeProfiles(collector, options.profiles, stderr);
      return { sources, budgets, failed: budgetsFailed(budgets) };
    },
    async close() {
      stopProbe();
      await server?.close();
      await collector.close();
      await recording?.close();
    },
  };
}
