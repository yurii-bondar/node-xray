// Pages of the dashboard, the hash route that picks one, and which page a finding belongs to.
// No DOM here.

import type { InsightKind, InsightSummary } from '@node-xray/core';

export type PageId = 'overview' | 'loop' | 'http' | 'io' | 'cpu' | 'memory' | 'gc' | 'system';

export const PAGES: readonly PageId[] = ['overview', 'loop', 'http', 'io', 'cpu', 'memory', 'gc', 'system'];

export const PAGE_LABEL: Readonly<Record<PageId, string>> = {
  overview: 'Overview',
  loop: 'Event loop',
  http: 'HTTP',
  io: 'Files & DNS',
  cpu: 'CPU',
  memory: 'Memory',
  gc: 'Garbage collector',
  system: 'System',
};

/** `#/gc` → `gc`; anything unknown is the overview. */
export function parseRoute(hash: string): PageId {
  const id = hash.replace(/^#\/?/, '');
  return (PAGES as readonly string[]).includes(id) ? (id as PageId) : 'overview';
}

export type Level = 'warn' | 'bad';

/** Where a finding is explained in detail. */
export function insightPage(kind: InsightKind): PageId {
  switch (kind) {
    case 'loop-stall':
      return 'loop';
    case 'gc-pressure':
      return 'gc';
    case 'heap-growth':
    case 'native-growth':
    case 'near-heap-limit':
    case 'detached-contexts':
      return 'memory';
    case 'near-memory-limit':
    case 'swapping':
      return 'system';
    case 'http-errors':
    case 'http-slow':
    case 'http-stuck':
      return 'http';
    case 'fs-blocking':
    case 'dns-slow':
      return 'io';
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

/** `bad` when the process is failing or about to; `warn` when it is slow or trending the wrong way. */
export function insightLevel(kind: InsightKind): Level {
  switch (kind) {
    case 'loop-stall':
    case 'gc-pressure':
    case 'near-heap-limit':
    case 'near-memory-limit':
    case 'swapping':
    case 'http-errors':
    case 'http-stuck':
      return 'bad';
    case 'heap-growth':
    case 'native-growth':
    case 'detached-contexts':
    case 'http-slow':
    case 'fs-blocking':
    case 'dns-slow':
      return 'warn';
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

/** The worst level of the findings on each page, for the dots in the navigation. */
export function pageAlerts(summaries: readonly InsightSummary[]): Map<PageId, Level> {
  const out = new Map<PageId, Level>();
  for (const summary of summaries) {
    const page = insightPage(summary.kind);
    if (out.get(page) !== 'bad') out.set(page, insightLevel(summary.kind));
  }
  return out;
}
