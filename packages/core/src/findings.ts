// Findings as a person reads them: one line per kind, and for a stall the code that was running.

import { hotFunctions, stacksOf, type CallStack, type FlameTree, type HotFunction } from './flame.js';
import type { Insight, InsightKind } from './insights.js';

export interface StallCulprit {
  /** For a loop stall not caused by GC: the busiest function of the CPU window around it. */
  readonly culprit: HotFunction | null;
  /** The heaviest path that reached `culprit` in that window. */
  readonly culpritStack: CallStack | null;
}

export interface InsightSummary extends StallCulprit {
  readonly kind: InsightKind;
  /** Frames it fired in (1 for state findings). */
  readonly count: number;
  /** The most severe occurrence. */
  readonly worst: Insight;
}

/** What a stall would be blamed on in one CPU profile window, worked out once when the window arrives. */
export interface CulpritWindow extends StallCulprit {
  readonly start: number;
  readonly end: number;
}

/** `tree` is one CPU window with the agent's own frames already left out (`withoutScript`). */
export function culpritWindow(tree: FlameTree): CulpritWindow {
  const culprit = hotFunctions(tree, 1)[0] ?? null;
  const culpritStack = culprit === null ? null : (stacksOf(tree, culprit, 1)[0] ?? null);
  return { start: tree.start, end: tree.end, culprit, culpritStack };
}

export interface StallSpan {
  /** When the stall was measured (the frame's end), epoch ms. */
  readonly t: number;
  /** How far back it may have started, ms. */
  readonly spanMs: number;
}

/** The culprit of the window that overlaps `[t - spanMs, t]` the most. */
export function stallCulprit(windows: readonly CulpritWindow[], { t, spanMs }: StallSpan): StallCulprit {
  let best: CulpritWindow | null = null;
  let bestOverlap = 0;
  for (const window of windows) {
    const overlap = Math.min(window.end, t) - Math.max(window.start, t - spanMs);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = window;
    }
  }
  return { culprit: best?.culprit ?? null, culpritStack: best?.culpritStack ?? null };
}

/** When a finding happened, epoch ms: its frame's end, or the end of the trend for growth. */
export function insightTime(insight: Insight): number {
  return insight.kind === 'heap-growth' || insight.kind === 'native-growth' ? insight.trend.to : insight.t;
}

function severity(insight: Insight): number {
  switch (insight.kind) {
    case 'loop-stall':
      return insight.delay;
    case 'gc-pressure':
      return insight.pauseRatio;
    case 'swapping':
      return insight.majorFaultsPerSec;
    case 'heap-growth':
    case 'native-growth':
      return insight.trend.bytesPerMin;
    case 'near-heap-limit':
      return insight.used / insight.limit;
    case 'near-memory-limit':
      return insight.rss / insight.limit;
    case 'detached-contexts':
      return insight.count;
    case 'http-errors':
      return insight.rate;
    case 'http-slow':
      return insight.p99;
    case 'http-stuck':
      return insight.oldest.ageMs;
    case 'fs-blocking':
    case 'dns-slow':
      return insight.ms;
    default: {
      const unreachable: never = insight;
      return unreachable;
    }
  }
}

/** One line per kind, worst first within the kind, kinds in first-seen order; no culprits (see `Timeline.findings`). */
export function summarizeInsights(insights: readonly Insight[]): InsightSummary[] {
  const byKind = new Map<InsightKind, { count: number; worst: Insight }>();
  for (const insight of insights) {
    const entry = byKind.get(insight.kind);
    if (entry === undefined) byKind.set(insight.kind, { count: 1, worst: insight });
    else {
      entry.count++;
      if (severity(insight) > severity(entry.worst)) entry.worst = insight;
    }
  }
  return [...byKind].map(([kind, { count, worst }]) => ({ kind, count, worst, culprit: null, culpritStack: null }));
}
