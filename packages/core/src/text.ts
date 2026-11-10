// Human-readable units and findings, shared by the terminal summary and the dashboard.
// Pure: no locale, no clock.

import type { Insight } from './insights.js';
import type { TaskCategory } from './loop.js';

export function formatBytes(bytes: number): string {
  const abs = Math.abs(bytes);
  if (abs >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (abs >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (abs >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${Math.round(bytes)} B`;
}

export function formatMs(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)} min`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 10) return `${Math.round(ms)} ms`;
  if (ms >= 0.1 || ms === 0) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms * 1000)} µs`;
}

/** 0..1 → "12.5 %". */
export function formatShare(share: number): string {
  return `${(share * 100).toFixed(1)} %`;
}

/** Already a percentage → "12.5 %". */
export function formatPercent(value: number): string {
  return `${value.toFixed(1)} %`;
}

export const CATEGORY_LABEL: Readonly<Record<TaskCategory, string>> = {
  timer: 'timers',
  io: 'I/O',
  immediate: 'immediates',
  nextTick: 'nextTicks',
  microtask: 'microtasks',
  promise: 'promises',
};

/** One sentence per finding; times are shown relative to `origin` (epoch ms). */
export function describeInsight(insight: Insight, origin: number): string {
  const at = (t: number): string => `at +${formatMs(Math.max(0, t - origin))}`;
  switch (insight.kind) {
    case 'loop-stall':
      return `event loop stalled ${formatMs(insight.delay)} ${at(insight.t)}${insight.cause === 'gc' ? ` (GC pause ${formatMs(insight.gcPause)})` : ' (synchronous code)'}`;
    case 'gc-pressure':
      return `GC took ${formatShare(insight.pauseRatio)} of the time ${at(insight.t)}`;
    case 'heap-growth':
      return `heap keeps growing after GC: +${formatBytes(insight.trend.bytesPerMin)}/min (R² ${insight.trend.r2.toFixed(2)}): leak suspect`;
    case 'native-growth':
      return `memory outside the JS heap keeps growing: +${formatBytes(insight.trend.bytesPerMin)}/min (Buffers, native addons)`;
    case 'near-heap-limit':
      return `heap at ${formatBytes(insight.used)} of ${formatBytes(insight.limit)} limit: close to "heap out of memory"`;
    case 'near-memory-limit':
      return `RSS ${formatBytes(insight.rss)} of ${formatBytes(insight.limit)} available: close to the OOM killer`;
    case 'swapping':
      return `swapping: ${insight.majorFaultsPerSec.toFixed(0)} major page faults/s${insight.processSwap === null ? '' : `, ${formatBytes(insight.processSwap)} swapped out`} ${at(insight.t)}`;
    case 'detached-contexts':
      return `${insight.count} detached V8 context(s): leaked vm contexts or iframes`;
    case 'http-errors':
      return `${formatShare(insight.rate)} of ${insight.side === 'server' ? 'incoming' : 'outgoing'} requests failed (${insight.requests} in a tick) ${at(insight.t)}`;
    case 'http-slow':
      return `${insight.side === 'server' ? 'incoming' : 'outgoing'} requests slow: p99 ${formatMs(insight.p99)} ${at(insight.t)}`;
    case 'http-stuck':
      return `${insight.count} ${insight.side === 'server' ? 'incoming' : 'outgoing'} request(s) running over ${formatMs(insight.oldest.ageMs)}, oldest ${insight.oldest.route} ${at(insight.t)}`;
    case 'fs-blocking':
      return `synchronous file system calls blocked the event loop for ${formatMs(insight.ms)} ${at(insight.t)}${insight.worst === '' ? '' : `, slowest: ${insight.worst}`}`;
    case 'dns-slow':
      return `DNS ${insight.worst} took ${formatMs(insight.ms)} ${at(insight.t)}`;
    default: {
      const unreachable: never = insight;
      return unreachable;
    }
  }
}
