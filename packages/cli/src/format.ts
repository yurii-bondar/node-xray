// Reports → terminal text. Pure: no colours, no clock, no locale.

import path from 'node:path';
import {
  CATEGORY_LABEL,
  describeInsight,
  formatBytes,
  formatMs,
  formatPercent as percent,
  formatShare,
  TASK_CATEGORIES,
  type HostReport,
  type HotFunction,
  type InsightSummary,
  type BudgetResult,
  formatMetric,
  type HttpSummary,
  type IoSummary,
  type SourceReport,
  STATUS_CLASSES,
  positionKey,
  type Original,
} from '@node-xray/core';

function insightLine(summary: InsightSummary, report: SourceReport, options: FormatOptions): string {
  const times = summary.count > 1 ? ` ×${summary.count}, worst:` : '';
  const culprit = summary.culprit === null ? '' : `\n      likely in ${summary.culprit.name}${location(summary.culprit, options)} (${formatShare(summary.culprit.selfShare)} of CPU in that window)`;
  return `  ! ${summary.kind}${times} ${describeInsight(summary.worst, report.from)}${culprit}`;
}

export interface FormatOptions {
  /** Paths under it are shown relative to it. */
  readonly cwd: string;
  /** Source-mapped positions by `positionKey`; frames without one show their compiled location. */
  readonly originals: ReadonlyMap<string, Original>;
}

/** `file:///app/src/x.js` or `/app/src/x.js` → `src/x.js` when under cwd; anything else unchanged. */
export function shortPath(file: string, cwd: string): string {
  let local = file;
  if (file.startsWith('file://')) {
    try {
      local = decodeURIComponent(new URL(file).pathname);
    } catch {
      return file;
    }
  }
  if (!path.isAbsolute(local)) return local;
  const relative = path.relative(cwd, local);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : local;
}

function location(fn: HotFunction, options: FormatOptions): string {
  if (fn.url === '') return '';
  const original = options.originals.get(positionKey(fn));
  if (original !== undefined) return `  ${shortPath(original.file, options.cwd)}:${original.line}`;
  return `  ${shortPath(fn.url, options.cwd)}${fn.line > 0 ? `:${fn.line}` : ''}`;
}

function command(report: SourceReport, options: FormatOptions): string {
  const args = report.argv.slice(1).map((arg) => shortPath(arg, options.cwd)).join(' ');
  return args === '' ? 'node' : `node ${args}`;
}

function httpLines(label: string, http: HttpSummary): string[] {
  const statuses = STATUS_CLASSES.filter((c) => http.statuses[c] > 0)
    .map((c) => `${c} ${http.statuses[c]}`)
    .join('  ');
  const failed = http.failed > 0 ? `  failed ${http.failed}` : '';
  const lines = [
    `  ${label.padEnd(11)} ${http.requests} requests (${http.rps.toFixed(1)}/s), errors ${formatShare(http.errorRate)}   p50 ${formatMs(http.p50)} p90 ${formatMs(http.p90)} p99 ${formatMs(http.p99)} max ${formatMs(http.max)}`,
    `              ${statuses}${failed}`,
  ];
  for (const route of http.routes.slice(0, 5)) {
    const errors = route.errors > 0 ? `, ${route.errors} errors` : '';
    lines.push(`              ${formatMs(route.totalMs).padStart(9)} in ${route.key} ×${route.count} (avg ${formatMs(route.totalMs / route.count)}, max ${formatMs(route.maxMs)}${errors})`);
  }
  const slowest = http.slowest[0];
  if (slowest !== undefined) lines.push(`              slowest: ${slowest.route} ${formatMs(slowest.ms)}${slowest.status === 0 ? ' (failed)' : ` → ${slowest.status}`}`);
  return lines;
}

/** `readFile /srv/app/x.json` → `readFile x.json` under cwd. */
function ioKey(key: string, options: FormatOptions): string {
  const space = key.indexOf(' ');
  if (space === -1) return key;
  const target = key.slice(space + 1);
  return target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target) ? `${key.slice(0, space)} ${shortPath(target, options.cwd)}` : key;
}

function ioLines(label: string, io: IoSummary, options: FormatOptions): string[] {
  const errors = io.errors > 0 ? `, ${io.errors} failed` : '';
  const blocked = label === 'Files sync' ? `, blocked the loop ${formatMs(io.totalMs)}` : '';
  const lines = [`  ${label.padEnd(11)} ${io.calls} calls (${io.perSec.toFixed(1)}/s)${errors}   p50 ${formatMs(io.p50)} p99 ${formatMs(io.p99)} max ${formatMs(io.max)}${blocked}`];
  for (const op of io.operations.slice(0, 4)) {
    lines.push(`              ${formatMs(op.totalMs).padStart(9)} in ${ioKey(op.key, options)} ×${op.count} (max ${formatMs(op.maxMs)}${op.errors > 0 ? `, ${op.errors} failed` : ''})`);
  }
  return lines;
}

export function formatReport(report: SourceReport, options: FormatOptions): string {
  const lines: string[] = [];
  const thread = report.threadId === 0 ? '' : `, worker ${report.threadId}`;
  lines.push(`── ${command(report, options)}  (pid ${report.pid}${thread}, ${report.nodeVersion}, ${formatMs(report.to - report.from)}, ${report.frames} samples)`);
  if (report.frames === 0) {
    lines.push('  no samples: the process exited before the first interval');
    return lines.join('\n');
  }

  lines.push(`  CPU         avg ${percent(report.cpu.avg)}  max ${percent(report.cpu.max)} of one core`);
  const iterations = report.loop.iterationsPerSec === null ? '' : `   ${Math.round(report.loop.iterationsPerSec.avg)} iterations/s`;
  lines.push(
    `  Event loop  busy avg ${formatShare(report.loop.utilization.avg)} max ${formatShare(report.loop.utilization.max)}   delay p99 ${formatMs(report.loop.delayP99)} max ${formatMs(report.loop.delayMax)}${iterations}`,
  );
  const m = report.memory;
  lines.push(`  Memory      RSS max ${formatBytes(m.rssMax)} of ${formatBytes(m.memoryLimit)}   heap max ${formatBytes(m.heapUsedMax)} of ${formatBytes(m.heapLimit)}   external max ${formatBytes(m.externalMax)}`);
  const swap = m.processSwapMax === null ? 'not reported on this OS' : formatBytes(m.processSwapMax);
  lines.push(`  Swap        process ${swap}   major page faults avg ${m.majorFaultsPerSec.avg.toFixed(1)}/s max ${m.majorFaultsPerSec.max.toFixed(1)}/s`);
  const g = report.gc;
  const kinds = (['minor', 'major', 'incremental'] as const)
    .filter((kind) => g.byKind[kind].count > 0)
    .map((kind) => `${kind} ${g.byKind[kind].count} / ${formatMs(g.byKind[kind].pause)}`)
    .join('  ');
  lines.push(`  GC          ${g.count} runs, ${formatMs(g.pause)} paused (${formatShare(g.pauseRatio)}), longest ${formatMs(g.maxPause)}${kinds === '' ? '' : `   ${kinds}`}`);
  lines.push(`  Overhead    agent avg ${percent(report.overhead.avg)} max ${percent(report.overhead.max)}`);

  if (report.loopTrace !== null) {
    const trace = report.loopTrace;
    const ran = TASK_CATEGORIES.filter((c) => trace.executed[c] > 0)
      .map((c) => `${CATEGORY_LABEL[c]} ${trace.executed[c]} (${formatMs(trace.busy[c])})`)
      .join('  ');
    lines.push(`  Loop trace  ${formatMs(trace.traced)} traced: ${ran === '' ? 'nothing ran' : ran}${trace.dropped > 0 ? `   (${trace.dropped} events over the cap, counts exact)` : ''}`);
    const pending = trace.queues.slice(0, 5).map((q) => `${q.resource} ${q.pending}`).join('  ');
    if (pending !== '') lines.push(`              still pending: ${pending}`);
  }

  for (const [label, summary] of [
    ['HTTP in', report.http.server],
    ['HTTP out', report.http.client],
  ] as const) {
    if (summary !== null) lines.push(...httpLines(label, summary));
  }
  for (const [label, summary] of [
    ['Files', report.io.fs],
    ['Files sync', report.io.fsSync],
    ['DNS', report.io.dns],
  ] as const) {
    if (summary !== null) lines.push(...ioLines(label, summary, options));
  }

  if (report.insights.length > 0) {
    lines.push('  Findings');
    for (const summary of report.insights) lines.push(insightLine(summary, report, options));
    if (report.hotFunctions.length === 0 && report.insights.some((s) => s.kind === 'loop-stall' && s.worst.kind === 'loop-stall' && s.worst.cause === 'unknown')) {
      lines.push('    run with --cpu to see which code blocks the loop');
    }
  }
  if (report.hotFunctions.length > 0) {
    lines.push('  Hot functions (share of busy CPU)');
    for (const fn of report.hotFunctions) lines.push(`    ${formatShare(fn.selfShare).padStart(7)}  ${fn.name}${location(fn, options)}`);
  }
  if (report.topAllocations.length > 0) {
    lines.push('  Top allocation sites (sampled)');
    for (const fn of report.topAllocations) lines.push(`    ${formatBytes(fn.self).padStart(10)}  ${fn.name}${location(fn, options)}`);
  }
  return lines.join('\n');
}

export function formatHost(host: HostReport): string | null {
  const parts: string[] = [];
  if (host.swapUsedMax !== null && host.swapTotal !== null) parts.push(`system swap max ${formatBytes(host.swapUsedMax)} of ${formatBytes(host.swapTotal)}`);
  for (const gpu of host.gpus) {
    const util = gpu.utilization === null ? 'utilization n/a' : `busy avg ${formatShare(gpu.utilization.avg)} max ${formatShare(gpu.utilization.max)}`;
    const memory = gpu.memoryTotal === null ? `memory max ${formatBytes(gpu.memoryUsedMax)} (shared)` : `memory max ${formatBytes(gpu.memoryUsedMax)} of ${formatBytes(gpu.memoryTotal)}`;
    const own = gpu.processMemoryMax === null ? '' : `, this app ${formatBytes(gpu.processMemoryMax)}`;
    parts.push(`GPU ${gpu.index} ${gpu.name}: ${util}, ${memory}${own}`);
  }
  return parts.length === 0 ? null : `── host\n${parts.map((p) => `  ${p}`).join('\n')}`;
}

const OUTCOME_MARK: Readonly<Record<BudgetResult['outcome'], string>> = { pass: '✓', fail: '✗', skipped: '–' };

/** One line per budget and process; skipped ones say why. */
export function formatBudgets(results: readonly BudgetResult[]): string {
  const several = new Set(results.map((r) => `${r.pid}:${r.threadId}`)).size > 1;
  const lines = results.map((r) => {
    const where = several ? ` (pid ${r.pid}${r.threadId === 0 ? '' : `, worker ${r.threadId}`})` : '';
    const actual = r.actual === null ? 'no data in this run' : formatMetric(r.budget.metric, r.actual);
    return `  ${OUTCOME_MARK[r.outcome]} ${r.budget.text}: ${actual}${where}`;
  });
  const count = (outcome: BudgetResult['outcome']): number => results.filter((r) => r.outcome === outcome).length;
  const skipped = count('skipped');
  return `── budgets: ${count('fail')} broken, ${count('pass')} met${skipped > 0 ? `, ${skipped} without data` : ''}\n${lines.join('\n')}`;
}
