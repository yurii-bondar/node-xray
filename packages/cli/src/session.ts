// What `run` and `attach` share once agents are talking: the collector and its listeners
// (recording, dashboard, host probe), and the summary, report and profiles at the end.

import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { budgetsFailed, buildHostReport, buildReport, checkBudgets, encodeRecord, type AgentCommand, type BudgetResult, type HostReport, type SourcePosition, type SourceReport } from '@node-xray/core';
import type { SessionOptions } from './args.js';
import { assets } from './assets.js';
import { Collector } from './collector.js';
import { formatBudgets, formatHost, formatReport } from './format.js';
import { HostProbe } from './host.js';
import { exportProfile, type ProfileKind } from './profiles.js';
import { DashboardServer, type RunStatus } from './server.js';
import { SourceMapResolver } from './sourcemaps.js';

const HOST_PROBE_MS = 2000;

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

/** Resolves on Ctrl+C or SIGTERM. */
export function waitForInterrupt(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      resolve();
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}

interface Summary {
  readonly sources: SourceReport[];
  readonly host: HostReport;
}

/** Every code location a report shows, for source map lookup. */
function positionsOf(report: SourceReport): SourcePosition[] {
  const out: SourcePosition[] = [...report.hotFunctions, ...report.topAllocations];
  for (const insight of report.insights) if (insight.culprit !== null) out.push(insight.culprit);
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
  const recording = options.record === null ? null : createWriteStream(options.record);
  const collector = new Collector({ startupCommands: startupCommands(options) });
  const resolver = new SourceMapResolver((file) => readFile(file, 'utf8'));
  if (recording !== null) collector.onRecord((connection, raw) => recording.write(`${encodeRecord(connection, raw)}\n`));
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
    });
    const url = await dashboard.start();
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
      if (options.report !== null) await writeFile(options.report, `${JSON.stringify({ sources, host, budgets }, null, 2)}\n`);
      if (options.profiles !== null) await writeProfiles(collector, options.profiles, stderr);
      return { sources, budgets, failed: budgetsFailed(budgets) };
    },
    async close() {
      stopProbe();
      await server?.close();
      await collector.close();
      if (recording !== null) await new Promise<void>((done) => recording.end(done));
    },
  };
}
