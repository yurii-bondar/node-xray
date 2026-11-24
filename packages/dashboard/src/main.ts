// Dashboard entry: stream → Store → the open page, redrawn at most every RENDER_MS.

import {
  describeInsight,
  formatBytes,
  formatMs,
  formatPercent,
  formatShare,
  changedFunctions,
  diffFlames,
  hotFunctions,
  httpRates,
  mergeFlames,
  stacksOf,
  ioRates,
  summarizeIo,
  summarizeHttp,
  withoutScript,
  CATEGORY_LABEL,
  DEFAULT_TIMELINE_OPTIONS,
  LOOP_PHASES,
  TASK_CATEGORIES,
  type AgentCommand,
  type CallStack,
  type FlameFrame,
  type FlameNode,
  type FlameTree,
  type HotFunction,
  type HttpMessage,
  type HttpRates,
  type HttpRoute,
  type Insight,
  type InsightKind,
  type InsightSummary,
  type IoMessage,
  type IoOperation,
  type IoRates,
  type Frame,
  type Iteration,
  type LoopEvent,
  type LoopPhase,
  type SourceId,
} from '@node-xray/core';
import { connectStream, exportUrl, resolvePositions, sendCommand } from './api.js';
import { TimeChart } from './charts.js';
import { byId, el, fillTable, linkButton, pressSegment, replaceIfChanged, segmented, setText, shortLocation, sparkline, SPARK_BOX, updateSparkline, type Cell, type DetailRow } from './dom.js';
import { findByPath, nodeKey, stackAlong } from './flame-layout.js';
import { FlameView } from './flame-view.js';
import { parseTheme, parseThemeMessage, type Theme } from './host.js';
import { iterationDetail } from './lane-layout.js';
import { IterationStrip, iterationSummary, LaneView, ROW_COLOR, ROW_LABEL } from './lane-view.js';
import { insightLevel, insightPage, PAGE_LABEL, PAGES, pageAlerts, parseRoute, type PageId } from './nav.js';
import { OriginalsCache } from './originals.js';
import {
  columns,
  gcByKind,
  gcCoverageStart,
  gcLevel,
  GC_LABEL,
  keptSpan,
  markerTimes,
  PAUSE_BUCKETS,
  pauseHistogram,
  PointCache,
  recentTotal,
  shortIoKey,
  sparkPath,
  type Timed,
} from './series.js';
import { lastResult, latestTime, LIVE, snapshotOf, type Snapshot } from './snapshot.js';
import { commandLabel, headerState, parseStatus, sourceLabel, Store, type SourceEntry } from './store.js';

const RENDER_MS = 200;
/** Findings closer than this in time are one marker on the charts. */
const MARKER_GAP_MS = 2000;
/** Live flame graph: the last N CPU windows (1 s each when started from here). */
const FLAME_WINDOWS = 10;
/** Samples in a tile's sparkline. */
const SPARK_POINTS = 60;
/** "Last 10 s" tiles. */
const RECENT_MS = 10_000;
const TRACE: AgentCommand = { type: 'loop-trace-start', flushMs: 250, maxEventsPerFlush: 5000, durationMs: 10_000 };
const CPU: AgentCommand = { type: 'cpu-profile-start', samplingIntervalUs: 1000, windowMs: 1000 };
const HEAP: AgentCommand = { type: 'heap-sampling-start', samplingIntervalBytes: 32 * 1024, windowMs: 2000 };

const params = new URLSearchParams(location.search);
const token = params.get('token') ?? '';
/** Inside the VS Code extension's webview. */
const inVscode = params.get('host') === 'vscode' && window.parent !== window;
/** The webview's origin: the only one messages go to and are taken from; without it nothing is posted. */
const parentOrigin = inVscode ? params.get('parent') : null;
/** Code locations open in the editor. */
const canOpen = parentOrigin !== null;
const store = new Store();

/** True when the page's theme changed. Before the charts are built: they read the colours once. */
function applyTheme(theme: Theme | null): boolean {
  if (theme === null || document.documentElement.dataset['theme'] === theme) return false;
  document.documentElement.dataset['theme'] = theme;
  return true;
}
applyTheme(parseTheme(params.get('theme')));

function pageTiles(page: PageId): HTMLElement {
  return byId(`tiles-${page}`, HTMLElement);
}

const ui = {
  source: byId('source', HTMLSelectElement),
  status: byId('status', HTMLElement),
  window: byId('window', HTMLElement),
  windowAll: byId('window-all', HTMLButtonElement),
  pause: byId('pause', HTMLButtonElement),
  proc: byId('proc', HTMLElement),
  procCmd: byId('proc-cmd', HTMLElement),
  procFacts: byId('proc-facts', HTMLElement),
  overviewLede: byId('overview-lede', HTMLElement),
  findingsPanel: byId('findings-panel', HTMLElement),
  findingsCount: byId('findings-count', HTMLElement),
  findings: byId('findings', HTMLElement),
  trace: byId('trace', HTMLButtonElement),
  span: byId('span', HTMLElement),
  legend: byId('lane-legend', HTMLElement),
  laneEmpty: byId('lane-empty', HTMLElement),
  laneWrap: byId('lane-wrap', HTMLElement),
  iterWrap: byId('iter-wrap', HTMLElement),
  phaseBar: byId('phase-bar', HTMLElement),
  iterationDetail: byId('iteration-detail', HTMLElement),
  queues: byId('queues', HTMLTableElement),
  cpuToggle: byId('cpu-toggle', HTMLButtonElement),
  flameWrap: byId('flame-wrap', HTMLElement),
  flameStack: byId('flame-stack', HTMLElement),
  flameReset: byId('flame-reset', HTMLButtonElement),
  hot: byId('hot', HTMLTableElement),
  changes: byId('changes', HTMLTableElement),
  baseline: byId('baseline', HTMLButtonElement),
  cpuDownload: byId('cpu-download', HTMLAnchorElement),
  heapDownload: byId('heap-download', HTMLAnchorElement),
  flameNote: byId('flame-note', HTMLElement),
  heapToggle: byId('heap-toggle', HTMLButtonElement),
  spaces: byId('spaces', HTMLElement),
  allocations: byId('allocations', HTMLTableElement),
  gcHistogram: byId('gc-histogram', HTMLElement),
  gcHistogramNote: byId('gc-histogram-note', HTMLElement),
  gcKinds: byId('gc-kinds', HTMLTableElement),
  gcKindsNote: byId('gc-kinds-note', HTMLElement),
  gcList: byId('gc-list', HTMLTableElement),
  hostFacts: byId('host-facts', HTMLElement),
  processFacts: byId('process-facts', HTMLElement),
  handles: byId('handles', HTMLElement),
  threads: byId('threads', HTMLTableElement),
  httpEmpty: byId('http-empty', HTMLElement),
  httpBody: byId('http-body', HTMLElement),
  fsToggle: byId('fs-toggle', HTMLButtonElement),
  ioFs: byId('io-fs', HTMLTableElement),
  ioSync: byId('io-sync', HTMLTableElement),
  ioDns: byId('io-dns', HTMLTableElement),
  httpRoutes: byId('http-routes', HTMLTableElement),
  httpCalls: byId('http-calls', HTMLTableElement),
  httpSlowest: byId('http-slowest', HTMLTableElement),
  httpRunning: byId('http-running', HTMLTableElement),
  pages: new Map(PAGES.map((page) => [page, document.querySelector<HTMLElement>(`.page[data-page="${page}"]`)])),
  navItems: [...document.querySelectorAll<HTMLAnchorElement>('.nav-item[data-page]')],
};

const state = {
  page: parseRoute(location.hash),
  selected: null as SourceId | null,
  /** Epoch ms the view is frozen at (every page shows data up to it); null = live. */
  pausedAt: null as number | null,
  windowMs: 300_000,
  spanMs: 1000,
  selectedIteration: null as number | null,
  /** CPU tree pinned for comparison; the flame graph shows the change against it. */
  baseline: null as FlameTree | null,
  flamePath: [] as string[],
  /** Function rows whose call stacks are shown (`table id:node key`). */
  expanded: new Set<string>(),
  /** Findings whose call stack is unfolded. */
  openStacks: new Set<string>(),
  /** What a toggle was just set to, shown until the stream can confirm it. */
  desired: new Map<Toggle, { on: boolean; until: number }>(),
};

type Toggle = 'trace' | 'cpu' | 'heap' | 'fs';

// ---- charts -------------------------------------------------------------------------------

const ms = (v: number): string => formatMs(v);
const pct = (v: number): string => formatPercent(v);
const perSec = (v: number): string => `${v >= 100 ? Math.round(v) : v.toFixed(1)}/s`;
const bytes = (v: number): string => formatBytes(v);
const OVERVIEW_HEIGHT = 150;

const charts = {
  overviewLoop: new TimeChart(byId('chart-ov-loop', HTMLElement), {
    title: '',
    left: ms,
    right: pct,
    height: OVERVIEW_HEIGHT,
    series: [
      { label: 'delay p99', color: '--s2', format: ms },
      { label: 'max', color: '--s3', format: ms },
      { label: 'busy', color: '--s4', format: pct, right: true, fill: true },
    ],
  }),
  overviewCpu: new TimeChart(byId('chart-ov-cpu', HTMLElement), {
    title: '',
    left: pct,
    height: OVERVIEW_HEIGHT,
    series: [
      { label: 'user', color: '--s1', format: pct, fill: true },
      { label: 'system', color: '--s3', format: pct },
    ],
  }),
  overviewMemory: new TimeChart(byId('chart-ov-memory', HTMLElement), {
    title: '',
    left: bytes,
    height: OVERVIEW_HEIGHT,
    series: [
      { label: 'RSS', color: '--s3', format: bytes },
      { label: 'heap used', color: '--s1', format: bytes, fill: true },
    ],
  }),
  overviewGc: new TimeChart(byId('chart-ov-gc', HTMLElement), {
    title: '',
    left: ms,
    height: OVERVIEW_HEIGHT,
    series: [
      { label: 'all pauses', color: '--s1', format: ms, bars: true },
      { label: 'major', color: '--s3', format: ms, bars: true },
    ],
  }),
  loopDelay: new TimeChart(byId('chart-loop-delay', HTMLElement), {
    title: 'Delay and utilization',
    left: ms,
    right: pct,
    series: [
      { label: 'p50', color: '--s1', format: ms },
      { label: 'p99', color: '--s2', format: ms },
      { label: 'max', color: '--s3', format: ms },
      { label: 'busy', color: '--s4', format: pct, right: true, fill: true },
    ],
  }),
  loopRate: new TimeChart(byId('chart-loop-rate', HTMLElement), {
    title: 'Iterations and libuv events',
    left: perSec,
    series: [
      { label: 'iterations', color: '--s1', format: perSec, fill: true },
      { label: 'libuv events', color: '--s5', format: perSec },
    ],
  }),
  cpu: new TimeChart(byId('chart-cpu', HTMLElement), {
    title: 'CPU (percent of one core)',
    left: pct,
    height: 200,
    series: [
      { label: 'user', color: '--s1', format: pct, fill: true },
      { label: 'system', color: '--s3', format: pct },
      { label: 'of machine', color: '--s4', format: pct },
      { label: 'xray agent', color: '--s5', format: pct },
    ],
  }),
  memory: new TimeChart(byId('chart-memory', HTMLElement), {
    title: 'Memory',
    left: bytes,
    height: 220,
    series: [
      { label: 'RSS', color: '--s3', format: bytes },
      { label: 'heap total', color: '--s2', format: bytes },
      { label: 'heap used', color: '--s1', format: bytes, fill: true },
      { label: 'external', color: '--s5', format: bytes },
      { label: 'ArrayBuffers', color: '--s4', format: bytes },
    ],
  }),
  gc: new TimeChart(byId('chart-gc', HTMLElement), {
    title: 'Pauses per sample',
    left: ms,
    height: 200,
    series: [
      { label: 'all pauses', color: '--s1', format: ms, bars: true },
      { label: 'major', color: '--s3', format: ms, bars: true },
    ],
  }),
  os: new TimeChart(byId('chart-os', HTMLElement), {
    title: 'Paging and scheduling',
    left: perSec,
    series: [
      { label: 'major faults (swap-in)', color: '--s3', format: perSec },
      { label: 'involuntary switches', color: '--s2', format: perSec },
      { label: 'voluntary switches', color: '--s1', format: perSec },
    ],
  }),
  ioRate: new TimeChart(byId('chart-io-rate', HTMLElement), {
    title: 'Calls per second',
    left: perSec,
    right: ms,
    series: [
      { label: 'fs', color: '--s1', format: perSec, fill: true },
      { label: 'fs sync', color: '--s3', format: perSec },
      { label: 'DNS', color: '--s5', format: perSec },
      { label: 'loop blocked by sync fs (ms/s)', color: '--s2', format: ms, right: true },
    ],
  }),
  ioLatency: new TimeChart(byId('chart-io-latency', HTMLElement), {
    title: 'Latency p99',
    left: ms,
    series: [
      { label: 'fs', color: '--s1', format: ms },
      { label: 'fs sync', color: '--s3', format: ms },
      { label: 'DNS', color: '--s5', format: ms },
    ],
  }),
  httpRate: new TimeChart(byId('chart-http-rate', HTMLElement), {
    title: 'Throughput',
    left: perSec,
    right: pct,
    series: [
      { label: 'served', color: '--s1', format: perSec, fill: true },
      { label: 'made', color: '--s5', format: perSec },
      { label: 'errors served', color: '--s3', format: pct, right: true },
      { label: 'errors made', color: '--s2', format: pct, right: true },
    ],
  }),
  httpLatency: new TimeChart(byId('chart-http-latency', HTMLElement), {
    title: 'Latency',
    left: ms,
    series: [
      { label: 'served p50', color: '--s1', format: ms },
      { label: 'served p99', color: '--s3', format: ms },
      { label: 'made p50', color: '--s5', format: ms },
      { label: 'made p99', color: '--s2', format: ms },
    ],
  }),
  host: new TimeChart(byId('chart-host', HTMLElement), {
    title: 'GPU and system swap',
    left: pct,
    series: [
      { label: 'GPU busy', color: '--s5', format: pct, fill: true },
      { label: 'swap used', color: '--s3', format: pct },
    ],
  }),
};

// ---- canvases -----------------------------------------------------------------------------

const lane = new LaneView(byId('lane', HTMLCanvasElement), byId('lane-tip', HTMLElement));
const strip = new IterationStrip(byId('iterations', HTMLCanvasElement), (iteration) => {
  state.selectedIteration = iteration.index;
  render();
});
const originals = new OriginalsCache(
  (positions) => resolvePositions(token, positions),
  () => {
    store.revision++;
    invalidate();
  },
);

/** Where a frame's code is: the original source when a source map says so, else the compiled file. */
function where(frame: FlameFrame): string {
  const original = originals.get(frame);
  return original === null ? shortLocation(frame) : shortLocation({ name: frame.name, url: original.file, line: original.line, column: original.column });
}

function openable(frame: FlameFrame): boolean {
  return canOpen && frame.url !== '' && !frame.url.startsWith('node:');
}

/** Asks the extension to open the code (the original source when a source map knows it). */
function openInEditor(frame: FlameFrame): void {
  const original = originals.get(frame);
  const target = original === null ? { url: frame.url, line: frame.line, column: frame.column } : { url: original.file, line: original.line, column: original.column };
  if (parentOrigin === null || target.url === '' || target.url.startsWith('node:')) return;
  try {
    window.parent.postMessage({ type: 'xray.open', ...target }, parentOrigin);
  } catch {
    // `parent` is not an origin: there is nobody to ask.
  }
}

function whereCell(frame: FlameFrame): Cell {
  const cell: Cell = { text: where(frame), title: frame.url === '' ? '' : `${frame.url}:${frame.line}` };
  return openable(frame) ? { ...cell, title: 'Open in editor', action: () => openInEditor(frame) } : cell;
}

interface StackListArgs {
  /** The function first, then its callers. */
  readonly frames: readonly FlameFrame[];
  /** Right-hand note per frame (a share). */
  readonly notes?: readonly string[];
  /** Picks a frame; the index is into `frames`. */
  readonly onPick?: (index: number) => void;
}

/** The frames `stackList` shows, for telling whether it needs building again (notes are updated in place). */
function stackSignature({ frames }: StackListArgs): string {
  return frames.map((frame) => `${frame.name}\u0000${where(frame)}`).join('\u0001');
}

/** Sets the texts of `selector` matches under `root`, in order, without rebuilding them. */
function setTexts(root: ParentNode, selector: string, texts: readonly string[]): void {
  root.querySelectorAll(selector).forEach((node, i) => setText(node, texts[i] ?? ''));
}

/** A call stack, one frame per line; a picked frame is a button, and inside VS Code so is its location. */
function stackList({ frames, notes, onPick }: StackListArgs): HTMLElement {
  const list = el('ol', 'stack');
  frames.forEach((frame, i) => {
    const item = el('li', `${i === 0 ? 'top' : ''}${onPick === undefined ? '' : ' pick'}`);
    const name = onPick === undefined ? el('span', 'fn', frame.name) : linkButton(frame.name, 'Zoom out to this caller');
    name.classList.add('fn');
    const loc = openable(frame) ? linkButton(where(frame), 'Open in editor') : el('span', '', where(frame));
    loc.classList.add('loc');
    if (loc instanceof HTMLButtonElement) {
      loc.addEventListener('click', (event) => {
        event.stopPropagation();
        openInEditor(frame);
      });
    }
    item.append(name, loc, el('span', 'note', notes?.[i] ?? ''));
    // The whole line is a mouse target; the name button is the keyboard one (its click bubbles here).
    if (onPick !== undefined) item.addEventListener('click', () => onPick(i));
    list.append(item);
  });
  return list;
}

const flame = new FlameView({
  canvas: byId('flame', HTMLCanvasElement),
  tip: byId('flame-tip', HTMLElement),
  onZoom: (relative) => {
    state.flamePath = relative === null ? state.flamePath.slice(0, -1) : [...state.flamePath, ...relative];
    render();
  },
  locate: where,
  onOpen: canOpen ? openInEditor : null,
});

// ---- helpers ------------------------------------------------------------------------------

/** Forgets what belonged to the previously shown source. */
function useSource(id: SourceId | null): void {
  state.selected = id;
  state.flamePath = [];
  state.selectedIteration = null;
  state.baseline = null;
}

/** The selected source, or the default one when there is none or it was dropped. */
function current(): SourceEntry | undefined {
  const selected = state.selected === null ? undefined : store.sources.get(state.selected);
  if (selected !== undefined) return selected;
  const fallback = store.defaultSource();
  useSource(fallback?.id ?? null);
  return fallback;
}

/** Up to when the pages show data. */
function until(): number {
  return state.pausedAt ?? LIVE;
}

/** A toggle's state: what was just asked for, else what the stream shows. */
function toggleState(toggle: Toggle, observed: boolean): boolean {
  const desired = state.desired.get(toggle);
  return desired !== undefined && desired.until > Date.now() ? desired.on : observed;
}

async function toggle(name: Toggle, button: HTMLButtonElement, start: AgentCommand, stop: AgentCommand): Promise<void> {
  const on = !button.classList.contains('on');
  state.desired.set(name, { on, until: Date.now() + 2500 });
  render();
  const ok = await sendCommand(token, state.selected, on ? start : stop);
  if (!ok) state.desired.delete(name);
  render();
}

function showToggle(button: HTMLButtonElement, on: boolean, labels: { readonly on: string; readonly off: string }): void {
  setText(button, on ? labels.on : labels.off);
  button.classList.toggle('on', on);
}

type Level = 'ok' | 'warn' | 'bad';

interface TileSpec {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly level?: Level;
  /** Recent values, oldest first. */
  readonly spark?: readonly (number | null)[];
  /** CSS custom property of the sparkline when the level is ok. */
  readonly color?: string;
}

function newTile(label: string): HTMLElement {
  const box = el('div', 'tile');
  box.dataset['label'] = label;
  box.append(el('div', 'label', label), el('div', 'value'), el('div', 'detail'));
  return box;
}

/** Changes only what differs, so a selection in a tile survives the next update. */
function updateTile(box: HTMLElement, spec: TileSpec): void {
  const level = spec.level ?? 'ok';
  const className = level === 'ok' ? 'tile' : `tile ${level}`;
  if (box.className !== className) box.className = className;
  const [, value, detail] = box.children;
  if (value !== undefined) setText(value, spec.value);
  if (detail !== undefined) setText(detail, spec.detail);
  let badge = box.querySelector('.badge');
  if (level === 'ok') badge?.remove();
  else {
    badge ??= box.appendChild(el('span', 'badge'));
    setText(badge, level === 'bad' ? 'HIGH' : 'WATCH');
  }
  const found = box.querySelector('svg.spark');
  if (spec.spark === undefined) found?.remove();
  else {
    const spark = found instanceof SVGSVGElement ? found : box.appendChild(sparkline());
    const color = level === 'bad' ? '--bad' : level === 'warn' ? '--warn' : (spec.color ?? '--s1');
    updateSparkline(spark, sparkPath({ values: spec.spark, ...SPARK_BOX }), color);
  }
}

function renderTiles(page: PageId, specs: readonly TileSpec[]): void {
  const container = pageTiles(page);
  specs.forEach((spec, i) => {
    const existing = container.children[i];
    if (existing instanceof HTMLElement && existing.dataset['label'] === spec.label) {
      updateTile(existing, spec);
      return;
    }
    const fresh = newTile(spec.label);
    if (existing === undefined) container.append(fresh);
    else existing.replaceWith(fresh);
    updateTile(fresh, spec);
  });
  while (container.children.length > specs.length) container.lastElementChild?.remove();
}

const WAITING: TileSpec = { label: 'Waiting', value: '…', detail: 'for the first samples' };

/** The last SPARK_POINTS values of a series, for a sparkline. */
function recent<T extends Timed>(items: readonly T[], pick: (item: T) => number | null): (number | null)[] {
  return items.slice(-SPARK_POINTS).map(pick);
}

function fillFacts(list: HTMLElement, facts: ReadonlyArray<readonly [string, string]>): void {
  replaceIfChanged(list, JSON.stringify(facts), () => facts.flatMap(([key, value]) => [el('dt', '', key), el('dd', '', value)]));
}

interface MeterArgs {
  readonly name: string;
  readonly amount: string;
  readonly share: number;
  readonly colorVar: string;
}

function meterRow(args: MeterArgs): HTMLElement {
  const row = el('div', 'meter-row');
  const meter = el('div', 'meter');
  const fill = el('div', '');
  fill.style.width = `${Math.min(100, Math.max(0, args.share * 100))}%`;
  fill.style.background = `var(${args.colorVar})`;
  meter.append(fill);
  row.append(el('span', '', args.name), el('span', 'amount', args.amount), meter);
  return row;
}

function fillMeters(container: HTMLElement, meters: readonly MeterArgs[]): void {
  replaceIfChanged(container, JSON.stringify(meters.map((m) => [m.name, m.amount, m.share.toFixed(3), m.colorVar])), () => meters.map(meterRow));
}

function legendChip(colorVar: string, text: string): HTMLElement {
  const chip = el('span', 'chip');
  const swatch = el('span', 'swatch');
  swatch.style.background = `var(${colorVar})`;
  chip.append(swatch, document.createTextNode(text));
  return chip;
}

function delayLevel(delay: number): Level {
  return delay >= 100 ? 'bad' : delay >= 20 ? 'warn' : 'ok';
}

/** Chart markers per kind of finding, once per insights array (the timeline memoises it per version). */
const markerCache = new WeakMap<readonly Insight[], Map<string, number[]>>();

function markers(insights: readonly Insight[], ...kinds: InsightKind[]): number[] {
  let byKinds = markerCache.get(insights);
  if (byKinds === undefined) {
    byKinds = new Map();
    markerCache.set(insights, byKinds);
  }
  const key = kinds.join(',');
  let times = byKinds.get(key);
  if (times === undefined) {
    times = markerTimes(insights.flatMap((i) => (kinds.includes(i.kind) && 't' in i ? [i.t] : [])), MARKER_GAP_MS);
    byKinds.set(key, times);
  }
  return times;
}

/** Everything a page renders from. */
interface View {
  readonly entry: SourceEntry;
  /** The source's data, cut at the pause when paused. */
  readonly data: Snapshot;
  readonly frames: readonly Frame[];
  readonly latest: Frame | undefined;
  /** Epoch ms where the chart window starts; 0 = everything kept. */
  readonly from: number;
  /** Findings in the chart window. */
  readonly findings: readonly InsightSummary[];
}

// ---- shell --------------------------------------------------------------------------------

function renderHeader(): void {
  const entry = current();
  const options = [...store.sources.values()];
  const label = (s: SourceEntry): string => `${sourceLabel(s.hello)}${s.ended ? ' · ended' : ''}`;
  const wanted = options.map((s) => `${s.id}|${label(s)}`).join('\n');
  if (ui.source.dataset['options'] !== wanted) {
    ui.source.dataset['options'] = wanted;
    ui.source.replaceChildren(
      ...options.map((s) => {
        const option = el('option', '', label(s));
        option.value = s.id;
        return option;
      }),
    );
  }
  if (state.selected !== null && ui.source.value !== state.selected) ui.source.value = state.selected;
  ui.source.hidden = options.length === 0;

  const header = headerState(store.status, store.connection);
  const className = header.tone === 'neutral' ? 'pill' : `pill ${header.tone}`;
  if (ui.status.className !== className) ui.status.className = className;
  setText(ui.status, header.text);
  ui.status.title = header.text;
  setText(ui.pause, state.pausedAt === null ? 'Pause' : 'Resume');
  ui.pause.setAttribute('aria-pressed', String(state.pausedAt !== null));
  // Commands need a live agent: not after exit or detach, never in a replay, not without the CLI.
  const live = header.live && entry?.ended !== true;
  const why = !header.live ? 'nothing to send to: this view is a recording, the process is gone or the CLI cannot be reached' : live ? '' : 'this thread has ended';
  for (const button of [ui.trace, ui.cpuToggle, ui.heapToggle, ui.fsToggle]) {
    button.disabled = !live;
    button.title = why;
  }
}

function showPage(): void {
  for (const [page, section] of ui.pages) if (section !== null) section.hidden = page !== state.page;
  for (const item of ui.navItems) {
    if (item.dataset['page'] === state.page) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  document.title = state.page === 'overview' ? 'xray' : `${PAGE_LABEL[state.page]} · xray`;
}

/** What the chart window covers, for the lede: "all" is what is kept, not the whole run. */
function windowLabel(frames: readonly Frame[]): string {
  const span = state.windowMs === 0 ? `All kept · last ${formatMs(keptSpan(frames))}` : `Last ${formatMs(state.windowMs)}`;
  return state.pausedAt === null ? span : `Paused · ${span}`;
}

function renderShell(view: View | null): void {
  const alerts = pageAlerts(view?.findings ?? []);
  for (const item of ui.navItems) {
    const dot = item.querySelector<HTMLElement>('.nav-dot');
    if (dot === null) continue;
    const level = alerts.get(parseRoute(`#/${item.dataset['page'] ?? ''}`));
    dot.hidden = level === undefined;
    dot.classList.toggle('bad', level === 'bad');
  }
  ui.windowAll.title = view === null ? 'everything kept' : `everything kept: the last ${formatMs(keptSpan(view.frames))}`;
  ui.proc.hidden = view === null;
  if (view === null) return;
  const hello = view.entry.hello;
  setText(ui.procCmd, commandLabel(hello));
  ui.procCmd.title = hello.argv.join(' ');
  fillFacts(ui.procFacts, [
    ['pid', hello.threadId === 0 ? String(hello.pid) : `${hello.pid} · worker ${hello.threadId}`],
    ['node', hello.nodeVersion],
    ['uptime', view.latest === undefined ? '—' : formatMs(view.latest.t - hello.timeOrigin)],
    ['overhead', view.latest === undefined ? '—' : formatPercent(view.latest.overhead)],
  ]);
}

// ---- overview -----------------------------------------------------------------------------

interface HttpPoint {
  readonly t: number;
  readonly server: HttpRates;
  readonly client: HttpRates;
}

const httpPoints = new PointCache<HttpMessage, HttpPoint>((w) => ({ t: w.end, server: httpRates(w.server, w), client: httpRates(w.client, w) }));

function httpTiles(data: Snapshot): TileSpec[] {
  // Only the sparklines' worth of points: tiles show nothing older.
  const points = httpPoints.since(data.httpWindows, Number.POSITIVE_INFINITY, SPARK_POINTS);
  const last = points.at(-1);
  if (last === undefined) return [];
  const tiles: TileSpec[] = [];
  const level = (r: HttpRates): Level => (r.errorRate >= 0.05 ? 'bad' : r.p99 >= 1000 ? 'warn' : 'ok');
  if (last.server.rps > 0 || last.server.inFlight > 0) {
    tiles.push({ label: 'HTTP in', value: `${Math.round(last.server.rps)}/s`, detail: `p99 ${formatMs(last.server.p99)} · errors ${formatShare(last.server.errorRate)}`, level: level(last.server), spark: recent(points, (p) => p.server.rps) });
  }
  if (last.client.rps > 0 || last.client.inFlight > 0) {
    tiles.push({ label: 'HTTP out', value: `${Math.round(last.client.rps)}/s`, detail: `p99 ${formatMs(last.client.p99)} · errors ${formatShare(last.client.errorRate)}`, level: level(last.client), spark: recent(points, (p) => p.client.rps), color: '--s5' });
  }
  return tiles;
}

/** GC pause time over the last RECENT_MS (or as much as there is), as a share of that time. */
function recentGc(frames: readonly Frame[]): { readonly pause: number; readonly runs: number; readonly share: number; readonly coveredMs: number } {
  const pause = recentTotal(frames, { ms: RECENT_MS, pick: (f) => f.gc.pause });
  const runs = recentTotal(frames, { ms: RECENT_MS, pick: (f) => f.gc.count });
  return { pause: pause.total, runs: runs.total, share: pause.coveredMs > 0 ? pause.total / pause.coveredMs : 0, coveredMs: pause.coveredMs };
}

function renderOverview(view: View): void {
  const { frames, data, from } = view;
  const f = view.latest;
  if (f === undefined) {
    renderTiles('overview', [WAITING]);
    renderFindings(view);
    return;
  }
  const delay = f.loop.delay.p99;
  const gc = recentGc(frames);
  const handles = f.resources.reduce((n, r) => n + r.count, 0);
  const swap = f.os.processSwap;
  const hostSwap = snapshotOf(store.host, until()).hostSamples.at(-1)?.swap ?? null;
  renderTiles('overview', [
    { label: 'CPU', value: formatPercent(f.cpu.total), detail: `${formatPercent(f.cpu.ofMachine)} of machine`, level: f.cpu.total > 90 ? 'warn' : 'ok', spark: recent(frames, (x) => x.cpu.total) },
    { label: 'Loop delay p99', value: formatMs(delay), detail: `max ${formatMs(f.loop.delay.max)}`, level: delayLevel(delay), spark: recent(frames, (x) => x.loop.delay.p99), color: '--s2' },
    {
      label: 'Loop busy',
      value: formatShare(f.loop.utilization),
      detail: f.loop.iterationsPerSec === null ? 'iterations n/a' : `${Math.round(f.loop.iterationsPerSec)} iterations/s`,
      level: f.loop.utilization > 0.9 ? 'warn' : 'ok',
      spark: recent(frames, (x) => x.loop.utilization),
      color: '--s4',
    },
    ...httpTiles(data),
    { label: 'RSS', value: formatBytes(f.memory.rss), detail: `${formatShare(f.os.memoryShare)} of ${formatBytes(f.os.memoryLimit)}`, level: f.os.memoryShare > 0.9 ? 'bad' : 'ok', spark: recent(frames, (x) => x.memory.rss), color: '--s3' },
    { label: 'Heap used', value: formatBytes(f.memory.heapUsed), detail: `of ${formatBytes(f.heap.limit)} limit`, level: f.memory.heapUsed > f.heap.limit * 0.9 ? 'bad' : 'ok', spark: recent(frames, (x) => x.memory.heapUsed), color: '--s5' },
    { label: 'GC, last 10 s', value: formatMs(gc.pause), detail: `${gc.runs} runs · ${formatShare(gc.share)} of the time`, level: gcLevel(gc.share), spark: recent(frames, (x) => x.gc.pause) },
    {
      label: 'Swap',
      value: swap !== null ? formatBytes(swap) : hostSwap !== null ? formatBytes(hostSwap.used) : 'n/a',
      detail: `${swap !== null ? 'this process' : hostSwap !== null ? 'whole system' : ''} · ${f.os.majorFaultsPerSec.toFixed(0)} major faults/s`,
      level: f.os.majorFaultsPerSec >= 100 ? 'bad' : 'ok',
    },
    { label: 'Handles', value: String(handles), detail: f.resources.slice(0, 2).map((r) => `${r.type} ${r.count}`).join(' · '), spark: recent(frames, (x) => x.resources.reduce((n, r) => n + r.count, 0)), color: '--muted' },
  ]);
  renderFindings(view);

  charts.overviewLoop.setMarkers(markers(data.insights, 'loop-stall'));
  charts.overviewLoop.setData(columns(frames, from, [(x) => x.loop.delay.p99, (x) => x.loop.delay.max, (x) => x.loop.utilization * 100]));
  charts.overviewCpu.setData(columns(frames, from, [(x) => x.cpu.user, (x) => x.cpu.system]));
  charts.overviewMemory.setData(columns(frames, from, [(x) => x.memory.rss, (x) => x.memory.heapUsed]));
  charts.overviewGc.setData(columns(frames, from, [(x) => (x.gc.pause > 0 ? x.gc.pause : null), (x) => (x.gc.byKind.major.pause > 0 ? x.gc.byKind.major.pause : null)]));
}

interface FindingLine {
  readonly summary: InsightSummary;
  readonly title: string;
  readonly culprit: string;
  /** Callee first. */
  readonly stack: readonly FlameFrame[];
}

function renderFindings({ findings, data, entry, frames }: View): void {
  const lines = [...findings]
    .sort((a, b) => Number(insightLevel(b.kind) === 'bad') - Number(insightLevel(a.kind) === 'bad'))
    .map(
      (summary): FindingLine => ({
        summary,
        // Times from the process start, as the sidebar's uptime counts.
        title: describeInsight(summary.worst, entry.hello.timeOrigin),
        culprit: summary.culprit === null ? '' : `likely in ${summary.culprit.name} ${where(summary.culprit)} · ${formatShare(summary.culprit.selfShare)} of CPU in that window`,
        stack: summary.culpritStack !== null && summary.culpritStack.frames.length > 1 ? [...summary.culpritStack.frames].reverse() : [],
      }),
    );
  const errors = data.errors.slice(-3);
  const total = lines.length + errors.length;
  ui.findingsPanel.hidden = total === 0;
  setText(ui.findingsCount, String(total));
  const span = windowLabel(frames);
  setText(ui.overviewLede, total === 0 ? `${span} · no findings` : `${span} · ${total} finding${total === 1 ? '' : 's'} need attention`);
  const signature = JSON.stringify([lines.map((l) => [l.summary.kind, l.title, l.culprit, l.summary.count, stackSignature({ frames: l.stack })]), errors, canOpen]);
  replaceIfChanged(ui.findings, signature, () => [
    ...lines.map(({ summary, title, culprit, stack }) => {
      const page = insightPage(summary.kind);
      const row = el('div', `finding ${insightLevel(summary.kind)}`);
      const text = el('div', '');
      text.append(el('div', 'title', title));
      if (culprit !== '') text.append(el('div', 'culprit', culprit));
      if (stack.length > 0) text.append(stackDetails(summary.kind, stack));
      const open = el('a', 'button ghost', `${PAGE_LABEL[page]} →`);
      open.href = `#/${page}`;
      row.append(el('span', 'sev'), text, el('span', 'when', summary.count > 1 ? `×${summary.count}, worst shown` : ''), open);
      return row;
    }),
    ...errors.map((error) => {
      const row = el('div', 'finding warn');
      row.append(el('span', 'sev'), el('div', 'title', `agent: ${error}`));
      return row;
    }),
  ]);
}

/** A finding's call stack (callee first), folded; stays open across redraws. */
function stackDetails(id: string, frames: readonly FlameFrame[]): HTMLElement {
  const details = el('details', 'stack-details');
  details.open = state.openStacks.has(id);
  details.addEventListener('toggle', () => {
    if (details.open) state.openStacks.add(id);
    else state.openStacks.delete(id);
  });
  details.append(el('summary', '', `call stack · ${frames.length} frames`), stackList({ frames }));
  return details;
}

// ---- event loop ---------------------------------------------------------------------------

const PHASE_COLOR: Readonly<Record<LoopPhase, string>> = { timers: '--c-timer', poll: '--c-io', check: '--c-immediate', microtasks: '--c-microtask' };

const longestCallback = lastResult((events: readonly LoopEvent[]): LoopEvent | null => {
  let longest: LoopEvent | null = null;
  for (const e of events) if (longest === null || e.duration > longest.duration) longest = e;
  return longest;
});

function renderLoop({ data, frames, from, latest }: View): void {
  const events = data.loopEvents;
  const windows = data.traceWindows;
  const lastWindow = windows[windows.length - 1];
  const tracing = toggleState('trace', lastWindow !== undefined && latest !== undefined && lastWindow.end >= latest.t - 1500);
  showToggle(ui.trace, tracing, { on: 'Stop tracing', off: 'Trace callbacks 10 s' });

  const longest = longestCallback(events);
  renderTiles('loop', [
    { label: 'Delay p99', value: latest ? formatMs(latest.loop.delay.p99) : '—', detail: latest ? `p50 ${formatMs(latest.loop.delay.p50)} · max ${formatMs(latest.loop.delay.max)}` : '', level: delayLevel(latest?.loop.delay.p99 ?? 0), spark: recent(frames, (f) => f.loop.delay.p99), color: '--s2' },
    { label: 'Loop busy', value: latest ? formatShare(latest.loop.utilization) : '—', detail: latest ? `idle ${formatShare(1 - latest.loop.utilization)}` : '', level: (latest?.loop.utilization ?? 0) > 0.9 ? 'warn' : 'ok', spark: recent(frames, (f) => f.loop.utilization), color: '--s4' },
    {
      label: 'Iterations',
      value: latest?.loop.iterationsPerSec == null ? 'n/a' : `${Math.round(latest.loop.iterationsPerSec)}/s`,
      detail: latest?.loop.eventsPerSec == null ? '' : `${Math.round(latest.loop.eventsPerSec)} libuv events/s`,
      spark: recent(frames, (f) => f.loop.iterationsPerSec),
    },
    longest === null
      ? { label: 'Longest callback', value: '—', detail: 'start a trace to see callbacks' }
      : { label: 'Longest callback', value: formatMs(longest.duration), detail: `${ROW_LABEL[longest.category]} · ${longest.name === '' ? '(anonymous)' : longest.name}`, level: delayLevel(longest.duration) },
  ]);

  const hasTrace = events.length > 0;
  ui.laneEmpty.hidden = hasTrace;
  ui.laneWrap.hidden = !hasTrace;
  ui.iterWrap.hidden = !hasTrace;
  if (hasTrace) {
    const lastEvent = events[events.length - 1];
    const end = Math.max(lastWindow?.end ?? 0, lastEvent ? lastEvent.start + lastEvent.duration : 0);
    const iterations = data.iterations;
    lane.render({ events, gc: data.gcEvents, iterations, end, spanMs: state.spanMs });

    // Legend with counts in the visible span.
    const counts = new Map<string, number>();
    for (const e of events) if (e.start >= end - state.spanMs) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
    const chips = TASK_CATEGORIES.map((category) => [ROW_COLOR[category], `${CATEGORY_LABEL[category]} ${counts.get(category) ?? 0}`] as const);
    replaceIfChanged(ui.legend, JSON.stringify(chips), () => [...chips.map(([color, text]) => legendChip(color, text)), legendChip(ROW_COLOR.gc, ROW_LABEL.gc)]);

    strip.render(iterations, state.selectedIteration);
    renderIteration(iterations, events);
  } else {
    replaceIfChanged(ui.legend, '', () => []);
  }

  charts.loopDelay.setMarkers(markers(data.insights, 'loop-stall'));
  charts.loopDelay.setData(columns(frames, from, [(f) => f.loop.delay.p50, (f) => f.loop.delay.p99, (f) => f.loop.delay.max, (f) => f.loop.utilization * 100]));
  charts.loopRate.setData(columns(frames, from, [(f) => f.loop.iterationsPerSec, (f) => f.loop.eventsPerSec]));

  fillTable(ui.queues, {
    rows: data.queues
      .slice(0, 12)
      .map((q) => [{ text: q.resource }, { text: CATEGORY_LABEL[q.category] }, { text: String(q.pending), numeric: true }, { text: String(q.executed), numeric: true }, { text: formatMs(q.busy), numeric: true }]),
    empty: 'start a trace to see queued work',
  });
}

function renderIteration(iterations: readonly Iteration[], events: readonly LoopEvent[]): void {
  const selected = iterations.find((it) => it.index === state.selectedIteration) ?? iterations[iterations.length - 1];
  if (selected === undefined) {
    setText(ui.iterationDetail, '');
    replaceIfChanged(ui.phaseBar, '', () => []);
    return;
  }
  const busy = LOOP_PHASES.reduce((sum, phase) => sum + selected.phaseBusy[phase], 0);
  const phases = LOOP_PHASES.filter((phase) => selected.phaseBusy[phase] > 0).map((phase) => ({ phase, text: `${phase} ${formatMs(selected.phaseBusy[phase])}`, flex: selected.phaseBusy[phase] / Math.max(busy, 1e-9) }));
  replaceIfChanged(ui.phaseBar, JSON.stringify(phases), () =>
    phases.map(({ phase, text, flex }) => {
      const part = el('span', '', text);
      part.style.flex = `${flex} 1 0`;
      part.style.background = `var(${PHASE_COLOR[phase]})`;
      part.title = text;
      return part;
    }),
  );

  const detail = iterationDetail(events, selected);
  const head = `#${selected.index}${selected.inferred ? ' (inferred)' : ''}`;
  const rest = ` · ${iterationSummary(selected) || 'nothing traced'} · busy ${formatMs(selected.busy)}`;
  const groups = detail.groups.slice(0, 16).map((group) => [group.category, `${group.label} ×${group.count} · ${formatMs(group.total)}${group.count > 1 ? ` (longest ${formatMs(group.longest)})` : ''}`] as const);
  const more = detail.groups.length > 16 ? `+${detail.groups.length - 16} more kinds` : '';
  replaceIfChanged(ui.iterationDetail, JSON.stringify([head, rest, groups, more]), () => {
    const line = el('div', '');
    line.append(el('b', '', head), document.createTextNode(rest));
    const list = el('div', 'groups');
    for (const [category, text] of groups) {
      const chip = legendChip(ROW_COLOR[category], text);
      chip.title = CATEGORY_LABEL[category];
      list.append(chip);
    }
    if (more !== '') list.append(document.createTextNode(more));
    return [line, list];
  });
}

// ---- HTTP ---------------------------------------------------------------------------------

function routeRows(routes: readonly HttpRoute[]): Cell[][] {
  return routes.map((r) => [
    { text: r.key },
    { text: String(r.count), numeric: true },
    { text: formatMs(r.totalMs / Math.max(1, r.count)), numeric: true },
    { text: formatMs(r.maxMs), numeric: true },
    { text: r.errors > 0 ? String(r.errors) : '', numeric: true, className: r.errors > 0 ? 'up' : '' },
    { text: formatMs(r.totalMs), numeric: true },
  ]);
}

/** HTTP windows that end in the chart window. */
function inWindow<W extends { readonly end: number }>(windows: readonly W[], from: number): readonly W[] {
  return from > 0 ? windows.filter((w) => w.end >= from) : windows;
}

const httpSummaries = lastResult((windows: readonly HttpMessage[], from: number) => {
  const recentWindows = inWindow(windows, from);
  return { served: summarizeHttp(recentWindows, 'server', 15), made: summarizeHttp(recentWindows, 'client', 15) };
});

function renderHttp({ data, from }: View): void {
  const windows = data.httpWindows;
  ui.httpEmpty.hidden = windows.length > 0;
  ui.httpBody.hidden = windows.length === 0;
  if (windows.length === 0) return;
  const points = httpPoints.since(windows, from, SPARK_POINTS);
  const last = windows[windows.length - 1];
  const now = points[points.length - 1];
  if (last !== undefined && now !== undefined) {
    const oldest = [...last.server.stuck].sort((a, b) => b.ageMs - a.ageMs)[0];
    renderTiles('http', [
      { label: 'Served', value: `${Math.round(now.server.rps)}/s`, detail: `p50 ${formatMs(now.server.p50)} · p99 ${formatMs(now.server.p99)}`, level: now.server.p99 >= 1000 ? 'warn' : 'ok', spark: recent(points, (p) => p.server.rps) },
      { label: 'Server errors', value: formatShare(now.server.errorRate), detail: '5xx and failed, of finished', level: now.server.errorRate >= 0.05 ? 'bad' : now.server.errorRate > 0 ? 'warn' : 'ok', spark: recent(points, (p) => p.server.errorRate), color: '--s4' },
      { label: 'In flight', value: String(now.server.inFlight), detail: oldest === undefined ? 'none open over a second' : `longest ${formatMs(oldest.ageMs)} · ${oldest.route}`, level: oldest !== undefined && oldest.ageMs >= 10_000 ? 'bad' : oldest !== undefined ? 'warn' : 'ok', spark: recent(points, (p) => p.server.inFlight), color: '--s2' },
      { label: 'Made (outgoing)', value: `${Math.round(now.client.rps)}/s`, detail: `p99 ${formatMs(now.client.p99)} · errors ${formatShare(now.client.errorRate)}`, level: now.client.errorRate >= 0.05 ? 'bad' : now.client.p99 >= 1000 ? 'warn' : 'ok', spark: recent(points, (p) => p.client.rps), color: '--s5' },
    ]);
  }
  charts.httpRate.setMarkers(markers(data.insights, 'http-errors'));
  charts.httpRate.setData(columns(points, from, [(p) => p.server.rps, (p) => p.client.rps, (p) => p.server.errorRate * 100, (p) => p.client.errorRate * 100]));
  charts.httpLatency.setMarkers(markers(data.insights, 'http-slow', 'http-stuck'));
  const latency = (r: HttpRates): number | null => (r.rps > 0 ? r.p50 : null);
  const tail = (r: HttpRates): number | null => (r.rps > 0 ? r.p99 : null);
  charts.httpLatency.setData(columns(points, from, [(p) => latency(p.server), (p) => tail(p.server), (p) => latency(p.client), (p) => tail(p.client)]));

  const { served, made } = httpSummaries(windows, from);
  fillTable(ui.httpRoutes, { rows: routeRows(served?.routes ?? []), empty: 'no requests served' });
  fillTable(ui.httpCalls, { rows: routeRows(made?.routes ?? []), empty: 'no requests made' });
  const slowest = [...(served?.slowest ?? []).map((e) => ({ ...e, side: 'in' })), ...(made?.slowest ?? []).map((e) => ({ ...e, side: 'out' }))]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 10);
  fillTable(ui.httpSlowest, {
    rows: slowest.map((e) => [{ text: `${e.side === 'in' ? '→' : '←'} ${e.route}` }, { text: e.status === 0 ? 'failed' : String(e.status), numeric: true, className: e.status === 0 || e.status >= 500 ? 'up' : '' }, { text: formatMs(e.ms), numeric: true, className: e.ms >= 1000 ? 'warn' : '' }]),
    empty: 'nothing yet',
  });
  const running = last === undefined ? [] : [...last.server.stuck.map((r) => ({ ...r, side: '→' })), ...last.client.stuck.map((r) => ({ ...r, side: '←' }))];
  fillTable(ui.httpRunning, {
    rows: running.sort((a, b) => b.ageMs - a.ageMs).map((r) => [{ text: `${r.side} ${r.route}` }, { text: formatMs(r.ageMs), numeric: true, className: r.ageMs >= 10_000 ? 'up' : 'warn' }]),
    empty: 'nothing running long',
  });
}

// ---- files & DNS --------------------------------------------------------------------------

interface IoPoint {
  readonly t: number;
  readonly fs: IoRates;
  readonly sync: IoRates;
  readonly dns: IoRates;
}

const ioPoints = new PointCache<IoMessage, IoPoint>((w) => ({ t: w.end, fs: ioRates(w.fs, w), sync: ioRates(w.fsSync, w), dns: ioRates(w.dns, w) }));

function ioRows(operations: readonly IoOperation[]): Cell[][] {
  return operations.map((op) => [
    { text: shortIoKey(op.key), title: op.key },
    { text: String(op.count), numeric: true },
    { text: formatMs(op.totalMs / Math.max(1, op.count)), numeric: true },
    { text: formatMs(op.maxMs), numeric: true },
    { text: op.errors > 0 ? String(op.errors) : '', numeric: true, className: op.errors > 0 ? 'up' : '' },
    { text: formatMs(op.totalMs), numeric: true },
  ]);
}

const ioSummaries = lastResult((windows: readonly IoMessage[], from: number) => {
  const recentWindows = inWindow(windows, from);
  return { fs: summarizeIo(recentWindows, 'fs', 15), sync: summarizeIo(recentWindows, 'fsSync', 15), dns: summarizeIo(recentWindows, 'dns', 15) };
});

function renderIo({ data, from, latest }: View): void {
  const windows = data.ioWindows;
  const last = windows[windows.length - 1];
  const fsSeen = last !== undefined && latest !== undefined && last.end >= latest.t - 3000 && last.fs.calls + last.fsSync.calls > 0;
  const timing = toggleState('fs', fsSeen);
  showToggle(ui.fsToggle, timing, { on: 'Stop fs timing', off: 'Start fs timing' });

  const points = ioPoints.since(windows, from, SPARK_POINTS);
  const now = points[points.length - 1];
  renderTiles(
    'io',
    now === undefined
      ? [{ label: 'File system', value: '—', detail: 'no calls timed yet' }]
      : [
          { label: 'fs calls', value: perSec(now.fs.perSec), detail: `p99 ${formatMs(now.fs.p99)}`, spark: recent(points, (p) => p.fs.perSec) },
          { label: 'Sync calls', value: perSec(now.sync.perSec), detail: `p99 ${formatMs(now.sync.p99)}`, level: now.sync.perSec > 0 ? 'warn' : 'ok', spark: recent(points, (p) => p.sync.perSec), color: '--s3' },
          { label: 'Loop blocked by sync fs', value: `${formatMs(now.sync.msPerSec)}/s`, detail: `${formatShare(now.sync.msPerSec / 1000)} of wall time`, level: now.sync.msPerSec >= 100 ? 'bad' : now.sync.msPerSec >= 10 ? 'warn' : 'ok', spark: recent(points, (p) => p.sync.msPerSec), color: '--s2' },
          { label: 'DNS lookups', value: perSec(now.dns.perSec), detail: `p99 ${formatMs(now.dns.p99)}`, level: now.dns.p99 >= 500 ? 'warn' : 'ok', spark: recent(points, (p) => p.dns.perSec), color: '--s5' },
        ],
  );

  const p99 = (r: IoRates): number | null => (r.perSec > 0 ? r.p99 : null);
  charts.ioRate.setMarkers(markers(data.insights, 'fs-blocking'));
  charts.ioRate.setData(columns(points, from, [(p) => p.fs.perSec, (p) => p.sync.perSec, (p) => p.dns.perSec, (p) => p.sync.msPerSec]));
  charts.ioLatency.setMarkers(markers(data.insights, 'dns-slow'));
  charts.ioLatency.setData(columns(points, from, [(p) => p99(p.fs), (p) => p99(p.sync), (p) => p99(p.dns)]));

  const summaries = ioSummaries(windows, from);
  fillTable(ui.ioFs, { rows: ioRows(summaries.fs?.operations ?? []), empty: timing ? 'no file system calls yet' : 'start fs timing to see file system calls' });
  fillTable(ui.ioSync, { rows: ioRows(summaries.sync?.operations ?? []), empty: timing ? 'no *Sync calls: nothing blocked the loop' : 'start fs timing to see blocking calls' });
  fillTable(ui.ioDns, { rows: ioRows(summaries.dns?.operations ?? []), empty: 'no DNS lookups yet' });
}

// ---- CPU ----------------------------------------------------------------------------------

let flameMemo: { readonly last: FlameTree; readonly agent: string; readonly tree: FlameTree | null } | null = null;

/** The last FLAME_WINDOWS CPU windows merged, the agent's own frames left out; merged again only when a window arrives. */
function recentFlame(windows: readonly FlameTree[], agent: string): FlameTree | null {
  const last = windows[windows.length - 1];
  if (last === undefined) return null;
  if (flameMemo?.last !== last || flameMemo.agent !== agent) {
    const merged = mergeFlames(windows.slice(-FLAME_WINDOWS));
    flameMemo = { last, agent, tree: merged === null ? null : withoutScript(merged, agent) };
  }
  return flameMemo.tree;
}

const hotCpu = lastResult((tree: FlameTree) => hotFunctions(tree, 15));
const hotAllocations = lastResult((tree: FlameTree) => hotFunctions(tree, 12));
const allocationTree = lastResult((tree: FlameTree, agent: string) => withoutScript(tree, agent));
const diffAgainst = lastResult((baseline: FlameTree, tree: FlameTree) => diffFlames(baseline, tree));
const changesAgainst = lastResult((baseline: FlameTree, tree: FlameTree) => changedFunctions(baseline, tree, 15));

function renderCpu({ data, entry, frames, from, latest }: View): void {
  renderTiles('cpu', [
    { label: 'CPU', value: latest ? formatPercent(latest.cpu.total) : '—', detail: 'of one core', level: (latest?.cpu.total ?? 0) > 90 ? 'warn' : 'ok', spark: recent(frames, (f) => f.cpu.total) },
    { label: 'User', value: latest ? formatPercent(latest.cpu.user) : '—', detail: 'JavaScript and native code', spark: recent(frames, (f) => f.cpu.user) },
    { label: 'System', value: latest ? formatPercent(latest.cpu.system) : '—', detail: 'kernel on behalf of the process', spark: recent(frames, (f) => f.cpu.system), color: '--s3' },
    { label: 'Of the machine', value: latest ? formatPercent(latest.cpu.ofMachine) : '—', detail: `${entry.hello.cpus} cores`, spark: recent(frames, (f) => f.cpu.ofMachine), color: '--s4' },
  ]);
  charts.cpu.setData(columns(frames, from, [(f) => f.cpu.user, (f) => f.cpu.system, (f) => f.cpu.ofMachine, (f) => f.overhead]));
  const windows = data.cpuWindows;
  const last = windows[windows.length - 1];
  const profiling = toggleState('cpu', last !== undefined && latest !== undefined && last.end >= latest.t - 3000);
  showToggle(ui.cpuToggle, profiling, { on: 'Stop CPU profile', off: 'Start CPU profile' });

  const tree = recentFlame(windows, entry.hello.agentScript);
  ui.flameWrap.hidden = tree === null;
  ui.baseline.hidden = tree === null && state.baseline === null;
  ui.cpuDownload.hidden = tree === null || state.selected === null;
  if (state.selected !== null) ui.cpuDownload.href = exportUrl({ token, source: state.selected, kind: 'cpu' });
  setText(ui.baseline, state.baseline === null ? 'Pin as baseline' : 'Clear baseline');
  ui.baseline.className = state.baseline === null ? 'ghost' : 'on';
  if (tree === null) {
    setText(ui.flameNote, 'start the CPU profile to see where time goes');
    ui.hot.hidden = true;
    ui.changes.hidden = true;
    ui.flameStack.hidden = true;
    return;
  }
  const baseline = state.baseline;
  const full = baseline === null ? tree.root : diffAgainst(baseline, tree);
  const focus = findByPath(full, state.flamePath);
  if (focus === null) state.flamePath = [];
  ui.flameReset.hidden = state.flamePath.length === 0;
  renderFlameStack(full, focus ?? full);
  setText(
    ui.flameNote,
    baseline === null ? `last ${FLAME_WINDOWS} windows · click a frame to zoom and see its stack${canOpen ? ' · double-click to open the code' : ''}` : 'now vs pinned baseline: red got heavier, blue got lighter; share of CPU work',
  );
  flame.render({ root: full, path: state.flamePath });

  ui.hot.hidden = baseline !== null;
  ui.changes.hidden = baseline === null;
  if (baseline === null) {
    fillFunctions(ui.hot, { tree, functions: hotCpu(tree), weight: (fn) => formatShare(fn.selfShare), empty: 'no samples yet' });
    return;
  }
  fillTable(ui.changes, {
    rows: changesAgainst(baseline, tree).map((c): Cell[] => [
      { text: `${c.delta >= 0 ? '+' : '−'}${Math.abs(c.delta * 100).toFixed(1)} pts`, numeric: true, className: c.delta > 0.001 ? 'up' : c.delta < -0.001 ? 'down' : '' },
      { text: formatShare(c.now), numeric: true },
      { text: formatShare(c.before), numeric: true },
      { text: c.name },
      whereCell(c),
    ]),
    empty: 'no change yet',
  });
}

/** The stack of the zoomed frame, the frame first; picking a caller zooms out to it. Shares are of the whole profile. */
function renderFlameStack(full: FlameNode, focus: FlameNode): void {
  const nodes = stackAlong(full, state.flamePath);
  ui.flameStack.hidden = nodes.length === 0;
  if (nodes.length === 0) return;
  const calleeFirst = [...nodes].reverse();
  const share = (node: FlameNode): string => (full.total > 0 ? formatShare(node.total / full.total) : '');
  const head = `Stack of ${focus.name} · ${share(focus)} of the profile · pick a caller to zoom out to it`;
  const list: StackListArgs = {
    frames: calleeFirst,
    notes: calleeFirst.map(share),
    onPick: (i) => {
      state.flamePath = state.flamePath.slice(0, nodes.length - i);
      render();
    },
  };
  // Shares move with every CPU window: rebuild only when the frames change, so a focused caller keeps focus.
  replaceIfChanged(ui.flameStack, stackSignature(list), () => [el('div', 'stack-head', head), stackList(list)]);
  setTexts(ui.flameStack, '.stack-head', [head]);
  setTexts(ui.flameStack, '.note', list.notes ?? []);
}

interface FunctionsTable {
  readonly tree: FlameTree;
  readonly functions: readonly HotFunction[];
  /** The weight column: share of CPU or bytes. */
  readonly weight: (fn: HotFunction) => string;
  readonly empty: string;
}

/** Call stacks that reach a function, once per tree. */
const stackCache = new WeakMap<FlameTree, Map<string, CallStack[]>>();

function stacksTo(tree: FlameTree, fn: HotFunction): CallStack[] {
  let byFunction = stackCache.get(tree);
  if (byFunction === undefined) {
    byFunction = new Map();
    stackCache.set(tree, byFunction);
  }
  const key = nodeKey(fn);
  let stacks = byFunction.get(key);
  if (stacks === undefined) {
    stacks = stacksOf(tree, fn, 3);
    byFunction.set(key, stacks);
  }
  return stacks;
}

/** Hot functions or allocation sites; a function's name unfolds the stacks that reach it. */
function fillFunctions(table: HTMLTableElement, { tree, functions, weight, empty }: FunctionsTable): void {
  const keyOf = (fn: HotFunction): string => `${table.id}:${nodeKey(fn)}`;
  const details: DetailRow[] = [];
  functions.forEach((fn, i) => {
    if (!state.expanded.has(keyOf(fn))) return;
    const boxes = stacksTo(tree, fn).map((stack) => ({
      head: `${formatShare(stack.share)} of ${fn.name}'s own ${tree.unit === 'bytes' ? 'allocations' : 'time'} came this way`,
      list: { frames: [...stack.frames].reverse() } satisfies StackListArgs,
    }));
    const heads = boxes.map((box) => box.head);
    details.push({
      after: i,
      key: JSON.stringify([keyOf(fn), canOpen, boxes.map((box) => stackSignature(box.list))]),
      update: (cell) => setTexts(cell, '.stack-head', heads),
      build: () => {
        const fragment = document.createDocumentFragment();
        for (const box of boxes) {
          const wrap = el('div', 'stack-box');
          wrap.append(el('div', 'stack-head', box.head), stackList(box.list));
          fragment.append(wrap);
        }
        return fragment;
      },
    });
  });
  fillTable(table, {
    rows: functions.map((fn): Cell[] => {
      const key = keyOf(fn);
      const open = state.expanded.has(key);
      return [
        { text: weight(fn), numeric: true },
        {
          text: `${open ? '▾' : '▸'} ${fn.name}`,
          title: open ? 'Hide the call stacks' : 'Show the call stacks that reach it',
          action: () => {
            if (state.expanded.has(key)) state.expanded.delete(key);
            else state.expanded.add(key);
            render();
          },
        },
        whereCell(fn),
      ];
    }),
    empty,
    details,
  });
}

// ---- memory -------------------------------------------------------------------------------

const SPACE_COLORS = ['--s1', '--s3', '--s5', '--s2', '--s4'];

function renderMemory({ data, entry, frames, from, latest }: View): void {
  renderTiles('memory', [
    { label: 'RSS', value: latest ? formatBytes(latest.memory.rss) : '—', detail: latest ? `${formatShare(latest.os.memoryShare)} of ${formatBytes(latest.os.memoryLimit)}` : '', level: (latest?.os.memoryShare ?? 0) > 0.9 ? 'bad' : 'ok', spark: recent(frames, (f) => f.memory.rss), color: '--s3' },
    { label: 'Heap used', value: latest ? formatBytes(latest.memory.heapUsed) : '—', detail: latest ? `of ${formatBytes(latest.heap.limit)} limit` : '', level: latest !== undefined && latest.memory.heapUsed > latest.heap.limit * 0.9 ? 'bad' : 'ok', spark: recent(frames, (f) => f.memory.heapUsed) },
    { label: 'External', value: latest ? formatBytes(latest.memory.external) : '—', detail: 'C++ objects bound to JS', spark: recent(frames, (f) => f.memory.external), color: '--s5' },
    { label: 'ArrayBuffers', value: latest ? formatBytes(latest.memory.arrayBuffers) : '—', detail: 'Buffers and typed arrays', spark: recent(frames, (f) => f.memory.arrayBuffers), color: '--s4' },
  ]);
  charts.memory.setData(columns(frames, from, [(f) => f.memory.rss, (f) => f.memory.heapTotal, (f) => f.memory.heapUsed, (f) => f.memory.external, (f) => f.memory.arrayBuffers]));
  // Spaces this V8 build does not use (shared, sandbox ones) stay at 0 B: leave them out.
  fillMeters(
    ui.spaces,
    (latest?.heapSpaces ?? [])
      .filter((space) => space.size > 0)
      .map((space, i) => ({ name: space.name.replace(/_space$/, ''), amount: `${formatBytes(space.used)} / ${formatBytes(space.size)}`, share: space.used / space.size, colorVar: SPACE_COLORS[i % SPACE_COLORS.length] ?? '--s1' })),
  );

  const allocations = data.allocations;
  const sampling = toggleState('heap', allocations !== null && latest !== undefined && allocations.end >= latest.t - 5000);
  showToggle(ui.heapToggle, sampling, { on: 'Stop allocation sampling', off: 'Start allocation sampling' });
  ui.heapDownload.hidden = allocations === null || state.selected === null;
  if (state.selected !== null) ui.heapDownload.href = exportUrl({ token, source: state.selected, kind: 'heap' });
  const tree = allocations === null ? null : allocationTree(allocations, entry.hello.agentScript);
  if (tree === null) fillTable(ui.allocations, { rows: [], empty: 'start allocation sampling to see who allocates' });
  else fillFunctions(ui.allocations, { tree, functions: hotAllocations(tree), weight: (fn) => formatBytes(fn.self), empty: 'no allocations sampled yet' });
}

// ---- garbage collector --------------------------------------------------------------------

function renderGc({ data, frames, from, latest }: View): void {
  const all = data.gcEvents;
  const events = from > 0 ? all.filter((e) => e.start >= from) : all;
  const gc = recentGc(frames);
  const runs = (pick: (f: Frame) => number): number => recentTotal(frames, { ms: RECENT_MS, pick }).total;
  let longest = 0;
  for (const e of events) longest = Math.max(longest, e.duration);
  renderTiles('gc', [
    { label: 'GC time, last 10 s', value: formatMs(gc.pause), detail: `${formatShare(gc.share)} of wall time${gc.coveredMs > 0 && gc.coveredMs < RECENT_MS ? ` over ${formatMs(gc.coveredMs)}` : ''}`, level: gcLevel(gc.share), spark: recent(frames, (f) => f.gc.pause) },
    { label: 'Longest pause', value: formatMs(longest), detail: 'in the chart window', level: delayLevel(longest), spark: recent(frames, (f) => f.gc.maxPause), color: '--s3' },
    { label: 'Runs, last 10 s', value: String(gc.runs), detail: `${runs((f) => f.gc.byKind.minor.count)} scavenge · ${runs((f) => f.gc.byKind.major.count)} mark-compact`, spark: recent(frames, (f) => f.gc.count) },
    { label: 'Heap used', value: latest ? formatBytes(latest.memory.heapUsed) : '—', detail: latest ? `of ${formatBytes(latest.heap.limit)} limit` : '', spark: recent(frames, (f) => f.memory.heapUsed), color: '--s5' },
  ]);

  charts.gc.setMarkers(markers(data.insights, 'gc-pressure'));
  charts.gc.setData(columns(frames, from, [(f) => (f.gc.pause > 0 ? f.gc.pause : null), (f) => (f.gc.byKind.major.pause > 0 ? f.gc.byKind.major.pause : null)]));

  // The GC ring holds fewer events than a busy minute of scavenges times the window: say what the tables cover.
  const coverageStart = gcCoverageStart(all, { from, capacity: DEFAULT_TIMELINE_OPTIONS.gcEvents });
  const covered = coverageStart === null || latest === undefined ? null : `only the last ${formatMs(latest.t - coverageStart)}: older pauses were dropped`;
  setText(ui.gcHistogramNote, covered === null ? 'pauses in the chart window' : `pauses in ${covered}`);
  setText(ui.gcKindsNote, covered ?? 'in the chart window');

  const counts = pauseHistogram(events);
  const most = Math.max(1, ...counts);
  replaceIfChanged(ui.gcHistogram, counts.join(','), () =>
    counts.map((n, i) => {
      const upper = PAUSE_BUCKETS[i];
      const lower = i === 0 ? 0 : (PAUSE_BUCKETS[i - 1] ?? 0);
      const bucket = el('div', `bucket${lower >= 50 ? ' bad' : lower >= 5 ? ' slow' : ''}`);
      const box = el('div', 'bar-box');
      const bar = el('div', 'bar');
      // Square root: one 200 ms pause stays visible next to hundreds of 1 ms scavenges.
      bar.style.height = n === 0 ? '2px' : `${Math.max(4, Math.sqrt(n / most) * 100)}%`;
      box.append(bar);
      bucket.append(el('span', 'n', String(n)), box, el('span', 'edge', upper === undefined ? `≥ ${lower} ms` : i === 0 ? `< ${upper} ms` : `${lower}–${upper}`));
      return bucket;
    }),
  );
  fillTable(ui.gcKinds, {
    rows: gcByKind(events).map((row) => [
      { text: GC_LABEL[row.kind] },
      { text: String(row.runs), numeric: true },
      { text: formatMs(row.avg), numeric: true },
      { text: formatMs(row.max), numeric: true, className: row.max >= 100 ? 'up' : row.max >= 20 ? 'warn' : '' },
      { text: formatMs(row.total), numeric: true },
    ]),
    empty: 'no GC yet',
  });
  const now = latest?.t ?? 0;
  fillTable(ui.gcList, {
    rows: all
      .slice(-15)
      .reverse()
      .map((e) => [{ text: `−${formatMs(Math.max(0, now - e.start))}` }, { text: GC_LABEL[e.kind] }, { text: formatMs(e.duration), numeric: true, className: e.duration >= 100 ? 'up' : e.duration >= 20 ? 'warn' : '' }]),
    empty: 'no GC yet',
  });
}

// ---- system -------------------------------------------------------------------------------

function renderSystem({ entry, frames, from, latest }: View): void {
  const host = snapshotOf(store.host, until()).hostSamples;
  const sample = host.at(-1);
  const gpu = sample?.gpus[0];
  const swap = sample?.swap ?? null;
  renderTiles('system', [
    { label: 'CPU, whole machine', value: latest ? formatPercent(latest.cpu.ofMachine) : '—', detail: latest ? `${entry.hello.cpus} cores · load ${latest.os.loadAvg1.toFixed(2)}` : '', spark: recent(frames, (f) => f.cpu.ofMachine) },
    { label: 'Memory share', value: latest ? formatShare(latest.os.memoryShare) : '—', detail: latest ? `${formatBytes(latest.os.rss)} of ${formatBytes(latest.os.memoryLimit)} limit` : '', level: (latest?.os.memoryShare ?? 0) > 0.9 ? 'bad' : (latest?.os.memoryShare ?? 0) > 0.75 ? 'warn' : 'ok', spark: recent(frames, (f) => f.os.memoryShare), color: '--s3' },
    {
      label: 'Swap used',
      value: swap === null || swap.total === 0 ? 'n/a' : formatShare(swap.used / swap.total),
      detail: `${swap === null ? 'no reading' : `${formatBytes(swap.used)} of ${formatBytes(swap.total)}`} · ${latest ? latest.os.majorFaultsPerSec.toFixed(0) : 0} faults/s`,
      level: (latest?.os.majorFaultsPerSec ?? 0) >= 100 ? 'bad' : 'ok',
      spark: recent(frames, (f) => f.os.majorFaultsPerSec),
      color: '--s2',
    },
    { label: 'GPU busy', value: gpu?.utilization == null ? 'n/a' : formatShare(gpu.utilization), detail: gpu === undefined ? 'no GPU readings' : gpu.name, spark: recent(host, (s) => s.gpus[0]?.utilization ?? null), color: '--s5' },
  ]);
  charts.os.setData(columns(frames, from, [(f) => f.os.majorFaultsPerSec, (f) => f.os.involuntarySwitchesPerSec, (f) => f.os.voluntarySwitchesPerSec]));
  charts.host.setData(
    columns(host, from, [
      (s) => (s.gpus[0]?.utilization === null || s.gpus[0] === undefined ? null : s.gpus[0].utilization * 100),
      (s) => (s.swap === null || s.swap.total === 0 ? null : (s.swap.used / s.swap.total) * 100),
    ]),
  );
  const hello = entry.hello;
  fillFacts(ui.hostFacts, [
    ['Platform', `${hello.platform} · ${hello.arch}`],
    ['CPUs', String(hello.cpus)],
    ['Memory', formatBytes(hello.totalMemory)],
    ['Memory limit', latest ? formatBytes(latest.os.memoryLimit) : '—'],
    ['Available', latest?.os.systemAvailable != null ? formatBytes(latest.os.systemAvailable) : '—'],
    ['Load (1 min)', latest ? latest.os.loadAvg1.toFixed(2) : '—'],
    ['GPU', gpu?.name ?? 'no readings'],
  ]);
  fillFacts(ui.processFacts, [
    ['Command', commandLabel(hello)],
    ['Node', hello.nodeVersion],
    ['pid', String(hello.pid)],
    ['Uptime', latest ? formatMs(latest.t - hello.timeOrigin) : '—'],
    ['Heap limit', latest ? formatBytes(latest.heap.limit) : '—'],
    ['Flags', hello.execArgv.join(' ') || 'none'],
    ['xray overhead', latest ? formatPercent(latest.overhead) : '—'],
  ]);
  const resources = latest?.resources ?? [];
  const most = Math.max(1, ...resources.map((r) => r.count));
  if (resources.length === 0) replaceIfChanged(ui.handles, 'none', () => [el('span', 'muted', 'no active handles')]);
  else fillMeters(ui.handles, resources.slice(0, 8).map((r, i) => ({ name: r.type, amount: String(r.count), share: r.count / most, colorVar: SPACE_COLORS[i % SPACE_COLORS.length] ?? '--s1' })));

  fillTable(ui.threads, {
    rows: [...store.sources.values()].map((source): Cell[] => {
      const threadFrames = snapshotOf(source.timeline, until()).frames;
      const f = threadFrames[threadFrames.length - 1];
      const selected = source.id === state.selected;
      return [
        { text: `${selected ? '● ' : ''}${sourceLabel(source.hello)}${source.ended ? ' · ended' : ''}`, title: selected ? 'Shown now' : 'Show this thread', action: () => selectSource(source.id) },
        { text: f ? formatPercent(f.cpu.total) : '—', numeric: true },
        { text: f ? formatMs(f.loop.delay.p99) : '—', numeric: true, className: f && f.loop.delay.p99 >= 20 ? 'warn' : '' },
        { text: f ? formatBytes(f.memory.heapUsed) : '—', numeric: true },
        { text: formatMs(recentTotal(threadFrames, { ms: RECENT_MS, pick: (x) => x.gc.pause }).total), numeric: true },
      ];
    }),
    empty: 'no threads yet',
  });
}

// ---- render loop --------------------------------------------------------------------------

let scheduled = false;
let lastRender = 0;
let renderedRevision = -1;
/** Something other than data changed (size, resolved source locations): draw even when paused. */
let dirty = false;

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  const wait = Math.max(0, RENDER_MS - (performance.now() - lastRender));
  setTimeout(() =>
    requestAnimationFrame(() => {
      scheduled = false;
      lastRender = performance.now();
      if (dirty || (state.pausedAt === null && store.revision !== renderedRevision)) render();
      else renderHeader();
    }),
  wait);
}

/** Draws on the next scheduled frame even if no data arrived. */
function invalidate(): void {
  dirty = true;
  schedule();
}

/** Only the open page is drawn: hidden canvases have no size, and hidden tables are wasted work. */
function render(): void {
  renderedRevision = store.revision;
  dirty = false;
  renderHeader();
  const entry = current();
  if (entry === undefined) {
    renderShell(null);
    renderTiles(state.page, [WAITING]);
    return;
  }
  const data = snapshotOf(entry.timeline, until());
  const frames = data.frames;
  const latest = data.latest;
  const from = state.windowMs > 0 && latest !== undefined ? latest.t - state.windowMs : 0;
  const view: View = { entry, data, frames, latest, from, findings: data.findings(from) };
  renderShell(view);
  switch (state.page) {
    case 'overview':
      return renderOverview(view);
    case 'loop':
      return renderLoop(view);
    case 'http':
      return renderHttp(view);
    case 'io':
      return renderIo(view);
    case 'cpu':
      return renderCpu(view);
    case 'memory':
      return renderMemory(view);
    case 'gc':
      return renderGc(view);
    case 'system':
      return renderSystem(view);
    default: {
      const unreachable: never = state.page;
      return unreachable;
    }
  }
}

// ---- wiring -------------------------------------------------------------------------------

function selectSource(id: SourceId): void {
  if (id === state.selected) return;
  useSource(id);
  render();
}

/** Where a pause cuts: the newest data of any source, so every page and thread stops at one moment. */
function pauseTime(): number {
  let latest = latestTime(store.host);
  for (const source of store.sources.values()) latest = Math.max(latest, latestTime(source.timeline));
  return latest;
}

function themeChanged(): void {
  for (const chart of Object.values(charts)) chart.rebuild();
  render();
}

ui.source.addEventListener('change', () => selectSource(ui.source.value as SourceId));
segmented(ui.window, (value) => {
  state.windowMs = Number(value);
  TimeChart.resetZooms();
  render();
});
segmented(ui.span, (value) => {
  state.spanMs = Number(value);
  render();
});
pressSegment(ui.window, String(state.windowMs));
pressSegment(ui.span, String(state.spanMs));
ui.pause.addEventListener('click', () => {
  state.pausedAt = state.pausedAt === null ? pauseTime() : null;
  render();
});
ui.trace.addEventListener('click', () => void toggle('trace', ui.trace, TRACE, { type: 'loop-trace-stop' }));
ui.cpuToggle.addEventListener('click', () => void toggle('cpu', ui.cpuToggle, CPU, { type: 'cpu-profile-stop' }));
ui.heapToggle.addEventListener('click', () => void toggle('heap', ui.heapToggle, HEAP, { type: 'heap-sampling-stop' }));
ui.fsToggle.addEventListener('click', () => void toggle('fs', ui.fsToggle, { type: 'fs-timing-start' }, { type: 'fs-timing-stop' }));
ui.baseline.addEventListener('click', () => {
  const entry = current();
  const tree = entry === undefined ? null : recentFlame(snapshotOf(entry.timeline, until()).cpuWindows, entry.hello.agentScript);
  state.baseline = state.baseline !== null ? null : tree;
  state.flamePath = [];
  render();
});
ui.flameReset.addEventListener('click', () => {
  state.flamePath = [];
  render();
});
window.addEventListener('hashchange', () => {
  state.page = parseRoute(location.hash);
  // uPlot syncs a zoom to every chart, also to hidden ones with stale scales: start each page unzoomed.
  TimeChart.resetZooms();
  showPage();
  window.scrollTo(0, 0);
  render();
});
window.addEventListener('resize', () => invalidate());
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  // A theme set by the extension wins over the system one.
  if (document.documentElement.dataset['theme'] === undefined) themeChanged();
});
window.addEventListener('message', (event) => {
  if (parentOrigin === null || event.origin !== parentOrigin) return;
  if (applyTheme(parseThemeMessage(event.data))) themeChanged();
});

connectStream(token, {
  onReset: () => {
    store.reset();
    schedule();
  },
  onRecord: (line) => {
    store.applyLine(line);
    schedule();
  },
  onStatus: (json) => {
    store.status = parseStatus(json);
    store.revision++;
    schedule();
  },
  onConnection: (open) => {
    store.setConnection(open ? 'open' : 'lost');
    schedule();
  },
});
showPage();
render();
