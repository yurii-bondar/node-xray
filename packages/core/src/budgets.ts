// Budgets for CI: `loop.p99<50ms`, `heap.growth<5MiB/min`, `http.errors<1%`, checked against run
// reports. A metric the run has no data for is skipped, not passed.

import type { SourceReport } from './report.js';
import { formatBytes, formatMs, formatPercent } from './text.js';

export type MetricUnit = 'ms' | 'bytes' | 'bytesPerMin' | 'percent' | 'perSec';

interface Metric {
  readonly unit: MetricUnit;
  readonly describe: string;
  readonly read: (report: SourceReport) => number | null;
}

/** Every metric a budget can name, read from one process's report. */
export const METRICS: Readonly<Record<string, Metric>> = {
  'cpu.avg': { unit: 'percent', describe: 'average CPU, % of one core', read: (r) => (r.frames > 0 ? r.cpu.avg : null) },
  'cpu.max': { unit: 'percent', describe: 'peak CPU, % of one core', read: (r) => (r.frames > 0 ? r.cpu.max : null) },
  'loop.p99': { unit: 'ms', describe: 'worst p99 event loop delay', read: (r) => (r.frames > 0 ? r.loop.delayP99 : null) },
  'loop.max': { unit: 'ms', describe: 'longest event loop delay', read: (r) => (r.frames > 0 ? r.loop.delayMax : null) },
  'loop.busy': { unit: 'percent', describe: 'average event loop utilization', read: (r) => (r.frames > 0 ? r.loop.utilization.avg * 100 : null) },
  'rss.max': { unit: 'bytes', describe: 'peak RSS', read: (r) => (r.frames > 0 ? r.memory.rssMax : null) },
  'heap.max': { unit: 'bytes', describe: 'peak heap used', read: (r) => (r.frames > 0 ? r.memory.heapUsedMax : null) },
  'heap.growth': { unit: 'bytesPerMin', describe: 'heap growth after GC (needs a few minutes)', read: (r) => r.memory.heapGrowthPerMin },
  'native.growth': { unit: 'bytesPerMin', describe: 'growth outside the JS heap (needs a few minutes)', read: (r) => r.memory.nativeGrowthPerMin },
  'gc.pause': { unit: 'percent', describe: 'share of time in GC pauses', read: (r) => (r.frames > 0 ? r.gc.pauseRatio * 100 : null) },
  'gc.max': { unit: 'ms', describe: 'longest GC pause', read: (r) => (r.frames > 0 ? r.gc.maxPause : null) },
  'http.p50': { unit: 'ms', describe: 'median latency of requests served', read: (r) => r.http.server?.p50 ?? null },
  'http.p99': { unit: 'ms', describe: 'p99 latency of requests served', read: (r) => r.http.server?.p99 ?? null },
  'http.errors': { unit: 'percent', describe: 'failed requests served (5xx, aborted)', read: (r) => (r.http.server ? r.http.server.errorRate * 100 : null) },
  'http.rps': { unit: 'perSec', describe: 'requests served per second', read: (r) => r.http.server?.rps ?? null },
  'http.out.p99': { unit: 'ms', describe: 'p99 latency of requests made', read: (r) => r.http.client?.p99 ?? null },
  'fs.p99': { unit: 'ms', describe: 'p99 latency of async file system calls (needs --fs)', read: (r) => r.io.fs?.p99 ?? null },
  'fs.sync': { unit: 'ms', describe: 'total time *Sync file system calls blocked the loop (needs --fs)', read: (r) => (r.io.fsSync ? r.io.fsSync.totalMs : null) },
  'dns.p99': { unit: 'ms', describe: 'p99 DNS lookup time', read: (r) => r.io.dns?.p99 ?? null },
  'dns.max': { unit: 'ms', describe: 'slowest DNS lookup', read: (r) => r.io.dns?.max ?? null },
  'http.out.errors': { unit: 'percent', describe: 'failed requests made (5xx, network errors)', read: (r) => (r.http.client ? r.http.client.errorRate * 100 : null) },
};

export type Comparison = '<' | '<=' | '>' | '>=';

export interface Budget {
  /** As written, for messages. */
  readonly text: string;
  readonly metric: string;
  readonly comparison: Comparison;
  /** In the metric's unit (ms, bytes, bytes/min, percent, per second). */
  readonly limit: number;
}

const SIZE: Readonly<Record<string, number>> = { b: 1, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 };
const TIME: Readonly<Record<string, number>> = { us: 0.001, µs: 0.001, ms: 1, s: 1000, m: 60_000, min: 60_000 };

/** The limit in the metric's unit, or an explanation of what was expected. */
function parseLimit(value: number, suffix: string, unit: MetricUnit): number | string {
  const s = suffix.toLowerCase();
  switch (unit) {
    case 'ms':
      if (s === '') return value;
      return TIME[s] === undefined ? 'a duration (50ms, 1.5s)' : value * (TIME[s] as number);
    case 'bytes':
      if (s === '') return value;
      return SIZE[s] === undefined ? 'a size (512MiB, 2GiB)' : value * (SIZE[s] as number);
    case 'bytesPerMin': {
      const [size = '', per = ''] = s.split('/');
      if (per !== 'min' && per !== 'm') return 'a rate per minute (5MiB/min)';
      return SIZE[size] === undefined ? 'a rate per minute (5MiB/min)' : value * (SIZE[size] as number);
    }
    case 'percent':
      return s === '' || s === '%' ? value : 'a percentage (80%)';
    case 'perSec':
      return s === '' || s === '/s' ? value : 'a rate per second (100/s)';
    default: {
      const unreachable: never = unit;
      return unreachable;
    }
  }
}

/** `loop.p99<50ms` → budget; a string explains what is wrong. */
export function parseBudget(text: string): Budget | string {
  const match = /^\s*([a-z][a-z0-9.]*)\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)\s*([a-zµ%/]*)\s*$/i.exec(text);
  if (match === null) return `'${text}': expected <metric><op><limit>, like loop.p99<50ms`;
  const [, metric = '', comparison = '<', number = '0', suffix = ''] = match;
  const definition = METRICS[metric];
  if (definition === undefined) return `'${text}': unknown metric '${metric}' (known: ${Object.keys(METRICS).join(', ')})`;
  const limit = parseLimit(Number(number), suffix, definition.unit);
  if (typeof limit === 'string') return `'${text}': ${metric} takes ${limit}`;
  return { text: text.trim(), metric, comparison: comparison as Comparison, limit };
}

/** Budgets from `--budget` values, each possibly a comma-separated list. */
export function parseBudgets(values: readonly string[]): Budget[] | string {
  const out: Budget[] = [];
  for (const value of values) {
    for (const part of value.split(',')) {
      if (part.trim() === '') continue;
      const budget = parseBudget(part);
      if (typeof budget === 'string') return budget;
      out.push(budget);
    }
  }
  return out;
}

export type BudgetOutcome = 'pass' | 'fail' | 'skipped';

export interface BudgetResult {
  readonly budget: Budget;
  readonly pid: number;
  readonly threadId: number;
  readonly outcome: BudgetOutcome;
  /** null when skipped (no data). */
  readonly actual: number | null;
}

function holds(actual: number, comparison: Comparison, limit: number): boolean {
  switch (comparison) {
    case '<':
      return actual < limit;
    case '<=':
      return actual <= limit;
    case '>':
      return actual > limit;
    case '>=':
      return actual >= limit;
    default: {
      const unreachable: never = comparison;
      return unreachable;
    }
  }
}

/** Every budget against every process; a process without data for a metric is skipped for it. */
export function checkBudgets(budgets: readonly Budget[], reports: readonly SourceReport[]): BudgetResult[] {
  const out: BudgetResult[] = [];
  for (const budget of budgets) {
    const metric = METRICS[budget.metric];
    if (metric === undefined) continue;
    for (const report of reports) {
      const actual = metric.read(report);
      out.push({
        budget,
        pid: report.pid,
        threadId: report.threadId,
        outcome: actual === null ? 'skipped' : holds(actual, budget.comparison, budget.limit) ? 'pass' : 'fail',
        actual,
      });
    }
  }
  return out;
}

export function budgetsFailed(results: readonly BudgetResult[]): boolean {
  return results.some((r) => r.outcome === 'fail');
}

/** A value in its metric's unit, for messages. */
export function formatMetric(metric: string, value: number): string {
  const unit = METRICS[metric]?.unit;
  switch (unit) {
    case 'ms':
      return formatMs(value);
    case 'bytes':
      return formatBytes(value);
    case 'bytesPerMin':
      return `${value < 0 ? '−' : ''}${formatBytes(Math.abs(value))}/min`;
    case 'percent':
      return formatPercent(value);
    case 'perSec':
      return `${value.toFixed(1)}/s`;
    case undefined:
      return String(value);
    default: {
      const unreachable: never = unit;
      return unreachable;
    }
  }
}
