// Dashboard entry: stream → Store → the open page, redrawn at most every RENDER_MS.

import {
  buildReport,
  describeInsight,
  formatBytes,
  formatMs,
  formatPercent,
  formatShare,
  changedFunctions,
  diffFlames,
  hotFunctions,
  httpRates,
  ioRates,
  summarizeIo,
  summarizeHttp,
  withoutScript,
  CATEGORY_LABEL,
  LOOP_PHASES,
  TASK_CATEGORIES,
  type AgentCommand,
  type FlameFrame,
  type FlameTree,
  type HttpRates,
  type HttpRoute,
  type IoOperation,
  type IoRates,
  type Frame,
  type Iteration,
  type LoopPhase,
  type SourceId,
  type SourceReport,
  type Timeline,
} from '@node-xray/core';
import { connectStream, exportUrl, resolvePositions, sendCommand } from './api.js';
import { TimeChart } from './charts.js';
import { byId, el, fillTable, pressSegment, segmented, shortLocation, sparkline, SPARK_BOX, type Cell } from './dom.js';
import { findByPath } from './flame-layout.js';
import { FlameView } from './flame-view.js';
import { iterationDetail } from './lane-layout.js';
import { IterationStrip, iterationSummary, LaneView, ROW_COLOR, ROW_LABEL } from './lane-view.js';
import { insightLevel, insightPage, PAGE_LABEL, PAGES, pageAlerts, parseRoute, type PageId } from './nav.js';
import { OriginalsCache } from './originals.js';
import { columns, gcByKind, GC_LABEL, markerTimes, PAUSE_BUCKETS, pauseHistogram, shortIoKey, sparkPath, type Timed } from './series.js';
import { commandLabel, parseStatus, sourceLabel, Store, type SourceEntry } from './store.js';

const RENDER_MS = 200;
/** Findings closer than this in time are one marker on the charts. */
const MARKER_GAP_MS = 2000;
/** Live flame graph: the last N CPU windows (1 s each when started from here). */
const FLAME_WINDOWS = 10;
/** Samples in a tile's sparkline. */
const SPARK_POINTS = 60;
const TRACE: AgentCommand = { type: 'loop-trace-start', flushMs: 250, maxEventsPerFlush: 5000, durationMs: 10_000 };
const CPU: AgentCommand = { type: 'cpu-profile-start', samplingIntervalUs: 1000, windowMs: 1000 };
const HEAP: AgentCommand = { type: 'heap-sampling-start', samplingIntervalBytes: 32 * 1024, windowMs: 2000 };

const params = new URLSearchParams(location.search);
const token = params.get('token') ?? '';
/** Inside the VS Code extension's webview: code locations open in the editor. */
const inVscode = params.get('host') === 'vscode' && window.parent !== window;
const store = new Store();

function pageTiles(page: PageId): HTMLElement {
  return byId(`tiles-${page}`, HTMLElement);
}

const ui = {
  source: byId('source', HTMLSelectElement),
  status: byId('status', HTMLElement),
  window: byId('window', HTMLElement),
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
  flameCrumb: byId('flame-crumb', HTMLElement),
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
  gcKinds: byId('gc-kinds', HTMLTableElement),
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
  paused: false,
  windowMs: 300_000,
  spanMs: 1000,
  selectedIteration: null as number | null,
  /** CPU tree pinned for comparison; the flame graph shows the change against it. */
  baseline: null as FlameTree | null,
  flamePath: [] as string[],
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
    schedule();
  },
);

/** Where a frame's code is: the original source when a source map says so, else the compiled file. */
function where(frame: FlameFrame): string {
  const original = originals.get(frame);
  return original === null ? shortLocation(frame) : shortLocation({ name: frame.name, url: original.file, line: original.line, column: original.column });
}

/** Asks the extension to open the code (the original source when a source map knows it). */
function openInEditor(frame: FlameFrame): void {
  const original = originals.get(frame);
  const target = original === null ? { url: frame.url, line: frame.line, column: frame.column } : { url: original.file, line: original.line, column: original.column };
  if (target.url === '' || target.url.startsWith('node:')) return;
  window.parent.postMessage({ type: 'xray.open', ...target }, '*');
}

function whereCell(frame: FlameFrame): Cell {
  const cell: Cell = { text: where(frame), title: frame.url === '' ? '' : `${frame.url}:${frame.line}` };
  return inVscode && frame.url !== '' && !frame.url.startsWith('node:') ? { ...cell, title: 'Open in editor', action: () => openInEditor(frame) } : cell;
}

const flame = new FlameView({
  canvas: byId('flame', HTMLCanvasElement),
  tip: byId('flame-tip', HTMLElement),
  onZoom: (relative) => {
    state.flamePath = relative === null ? state.flamePath.slice(0, -1) : [...state.flamePath, ...relative];
    render();
  },
  locate: where,
  onOpen: inVscode ? openInEditor : null,
});

// ---- helpers ------------------------------------------------------------------------------

function current(): SourceEntry | undefined {
  if (state.selected !== null) {
    const entry = store.sources.get(state.selected);
    if (entry !== undefined) return entry;
  }
  const fallback = store.defaultSource();
  state.selected = fallback?.id ?? null;
  return fallback;
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
  button.textContent = on ? labels.on : labels.off;
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

function tile(spec: TileSpec): HTMLElement {
  const level = spec.level ?? 'ok';
  const box = el('div', level === 'ok' ? 'tile' : `tile ${level}`);
  box.append(el('div', 'label', spec.label), el('div', 'value', spec.value), el('div', 'detail', spec.detail));
  if (level !== 'ok') box.append(el('span', 'badge', level === 'bad' ? 'HIGH' : 'WATCH'));
  if (spec.spark !== undefined) {
    const color = level === 'bad' ? '--bad' : level === 'warn' ? '--warn' : (spec.color ?? '--s1');
    box.append(sparkline(sparkPath({ values: spec.spark, ...SPARK_BOX }), color));
  }
  return box;
}

function renderTiles(page: PageId, specs: readonly TileSpec[]): void {
  pageTiles(page).replaceChildren(...specs.map(tile));
}

/** The last SPARK_POINTS values of a series, for a sparkline. */
function recent<T extends Timed>(items: readonly T[], pick: (item: T) => number | null): (number | null)[] {
  return items.slice(-SPARK_POINTS).map(pick);
}

function sumRecent(frames: readonly Frame[], ms: number, pick: (f: Frame) => number): number {
  const last = frames[frames.length - 1];
  if (last === undefined) return 0;
  let sum = 0;
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i] as Frame;
    if (f.t < last.t - ms) break;
    sum += pick(f);
  }
  return sum;
}

function fillFacts(list: HTMLElement, facts: ReadonlyArray<readonly [string, string]>): void {
  list.replaceChildren(...facts.flatMap(([key, value]) => [el('dt', '', key), el('dd', '', value)]));
}

function meterRow(args: { readonly name: string; readonly amount: string; readonly share: number; readonly colorVar: string }): HTMLElement {
  const row = el('div', 'meter-row');
  const meter = el('div', 'meter');
  const fill = el('div', '');
  fill.style.width = `${Math.min(100, Math.max(0, args.share * 100))}%`;
  fill.style.background = `var(${args.colorVar})`;
  meter.append(fill);
  row.append(el('span', '', args.name), el('span', 'amount', args.amount), meter);
  return row;
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

/** Everything a page renders from. */
interface View {
  readonly entry: SourceEntry;
  readonly timeline: Timeline;
  readonly frames: readonly Frame[];
  readonly latest: Frame | undefined;
  /** Epoch ms where the chart window starts; 0 = everything. */
  readonly from: number;
  readonly report: SourceReport | null;
}

// ---- shell --------------------------------------------------------------------------------

function renderHeader(): void {
  const options = [...store.sources.values()];
  const wanted = options.map((s) => `${s.id}|${sourceLabel(s.hello)}`).join('\n');
  if (ui.source.dataset['options'] !== wanted) {
    ui.source.dataset['options'] = wanted;
    ui.source.replaceChildren(
      ...options.map((s) => {
        const option = el('option', '', sourceLabel(s.hello));
        option.value = s.id;
        return option;
      }),
    );
  }
  if (state.selected !== null) ui.source.value = state.selected;
  ui.source.hidden = options.length === 0;

  const status = store.status;
  ui.status.className = 'pill';
  if (status === null) ui.status.textContent = 'connecting…';
  else if (status.state === 'running') {
    ui.status.textContent = `live · ${status.command}`;
    ui.status.classList.add('live');
  } else if (status.state === 'detached' || status.state === 'replay') {
    ui.status.textContent = status.state === 'replay' ? status.command : `detached · ${status.command}`;
    ui.status.classList.add('done');
  } else {
    ui.status.textContent = `exited ${status.code} · ${status.command}`;
    ui.status.classList.add('done');
  }
  ui.status.title = ui.status.textContent;
  ui.pause.textContent = state.paused ? 'Resume' : 'Pause';
  // Commands need a live agent: not after exit or detach, never in a replay.
  const live = status === null || status.state === 'running';
  for (const button of [ui.trace, ui.cpuToggle, ui.heapToggle, ui.fsToggle]) {
    button.disabled = !live;
    button.title = live ? '' : 'nothing is running: this view is a recording or the process is gone';
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

function renderShell(view: View | null): void {
  const alerts = pageAlerts(view?.report?.insights ?? []);
  for (const item of ui.navItems) {
    const dot = item.querySelector<HTMLElement>('.nav-dot');
    if (dot === null) continue;
    const level = alerts.get(parseRoute(`#/${item.dataset['page'] ?? ''}`));
    dot.hidden = level === undefined;
    dot.classList.toggle('bad', level === 'bad');
  }
  ui.proc.hidden = view === null;
  if (view === null) return;
  const hello = view.entry.hello;
  ui.procCmd.textContent = commandLabel(hello);
  ui.procCmd.title = hello.argv.join(' ');
  fillFacts(ui.procFacts, [
    ['pid', hello.threadId === 0 ? String(hello.pid) : `${hello.pid} · worker ${hello.threadId}`],
    ['node', hello.nodeVersion],
    ['uptime', view.latest === undefined ? '—' : formatMs(view.latest.t - hello.timeOrigin)],
    ['overhead', view.latest === undefined ? '—' : formatPercent(view.latest.overhead)],
  ]);
}

// ---- overview -----------------------------------------------------------------------------

function httpTiles(timeline: Timeline): TileSpec[] {
  const points = httpPoints(timeline);
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

function renderOverview(view: View): void {
  const { frames, timeline, from } = view;
  const f = view.latest;
  if (f === undefined) {
    renderTiles('overview', [{ label: 'Waiting', value: '…', detail: 'for the first samples' }]);
    return;
  }
  const delay = f.loop.delay.p99;
  const gcPause = sumRecent(frames, 10_000, (x) => x.gc.pause);
  const gcRuns = sumRecent(frames, 10_000, (x) => x.gc.count);
  const handles = f.resources.reduce((n, r) => n + r.count, 0);
  const swap = f.os.processSwap;
  const hostSwap = store.host.hostSamples().at(-1)?.swap ?? null;
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
    ...httpTiles(timeline),
    { label: 'RSS', value: formatBytes(f.memory.rss), detail: `${formatShare(f.os.memoryShare)} of ${formatBytes(f.os.memoryLimit)}`, level: f.os.memoryShare > 0.9 ? 'bad' : 'ok', spark: recent(frames, (x) => x.memory.rss), color: '--s3' },
    { label: 'Heap used', value: formatBytes(f.memory.heapUsed), detail: `of ${formatBytes(f.heap.limit)} limit`, level: f.memory.heapUsed > f.heap.limit * 0.9 ? 'bad' : 'ok', spark: recent(frames, (x) => x.memory.heapUsed), color: '--s5' },
    { label: 'GC, last 10 s', value: formatMs(gcPause), detail: `${gcRuns} runs`, level: gcPause > 1000 ? 'warn' : 'ok', spark: recent(frames, (x) => x.gc.pause) },
    {
      label: 'Swap',
      value: swap !== null ? formatBytes(swap) : hostSwap !== null ? formatBytes(hostSwap.used) : 'n/a',
      detail: `${swap !== null ? 'this process' : hostSwap !== null ? 'whole system' : ''} · ${f.os.majorFaultsPerSec.toFixed(0)} major faults/s`,
      level: f.os.majorFaultsPerSec >= 100 ? 'bad' : 'ok',
    },
    { label: 'Handles', value: String(handles), detail: f.resources.slice(0, 2).map((r) => `${r.type} ${r.count}`).join(' · '), spark: recent(frames, (x) => x.resources.reduce((n, r) => n + r.count, 0)), color: '--muted' },
  ]);
  renderFindings(view);

  charts.overviewLoop.setMarkers(markerTimes(timeline.insights().flatMap((i) => (i.kind === 'loop-stall' ? [i.t] : [])), MARKER_GAP_MS));
  charts.overviewLoop.setData(columns(frames, from, [(x) => x.loop.delay.p99, (x) => x.loop.delay.max, (x) => x.loop.utilization * 100]));
  charts.overviewCpu.setData(columns(frames, from, [(x) => x.cpu.user, (x) => x.cpu.system]));
  charts.overviewMemory.setData(columns(frames, from, [(x) => x.memory.rss, (x) => x.memory.heapUsed]));
  charts.overviewGc.setData(columns(frames, from, [(x) => (x.gc.pause > 0 ? x.gc.pause : null), (x) => (x.gc.byKind.major.pause > 0 ? x.gc.byKind.major.pause : null)]));
}

function renderFindings({ report, timeline }: View): void {
  const insights = [...(report?.insights ?? [])].sort((a, b) => Number(insightLevel(b.kind) === 'bad') - Number(insightLevel(a.kind) === 'bad'));
  const errors = timeline.errors().slice(-3);
  const total = insights.length + errors.length;
  ui.findingsPanel.hidden = total === 0;
  ui.findingsCount.textContent = String(total);
  const span = state.windowMs === 0 ? 'Whole run' : `Last ${formatMs(state.windowMs)}`;
  ui.overviewLede.textContent = total === 0 ? `${span} · no findings so far` : `${span} · ${total} finding${total === 1 ? '' : 's'} need attention`;
  if (report === null) return;
  const rows = insights.map((summary) => {
    const page = insightPage(summary.kind);
    const row = el('div', `finding ${insightLevel(summary.kind)}`);
    const text = el('div', '');
    text.append(el('div', 'title', describeInsight(summary.worst, report.from)));
    if (summary.culprit !== null) {
      text.append(el('div', 'culprit', `likely in ${summary.culprit.name} ${where(summary.culprit)} · ${formatShare(summary.culprit.selfShare)} of CPU in that window`));
    }
    const open = el('a', 'button ghost', `${PAGE_LABEL[page]} →`);
    open.href = `#/${page}`;
    row.append(el('span', 'sev'), text, el('span', 'when', summary.count > 1 ? `×${summary.count}, worst shown` : ''), open);
    return row;
  });
  for (const error of errors) {
    const row = el('div', 'finding warn');
    row.append(el('span', 'sev'), el('div', 'title', `agent: ${error}`));
    rows.push(row);
  }
  ui.findings.replaceChildren(...rows);
}

// ---- event loop ---------------------------------------------------------------------------

const PHASE_COLOR: Readonly<Record<LoopPhase, string>> = { timers: '--c-timer', poll: '--c-io', check: '--c-immediate', microtasks: '--c-microtask' };

function renderLoop({ timeline, frames, from, latest }: View): void {
  const events = timeline.loopEvents();
  const windows = timeline.traceWindows();
  const lastWindow = windows[windows.length - 1];
  const tracing = toggleState('trace', lastWindow !== undefined && latest !== undefined && lastWindow.end >= latest.t - 1500);
  showToggle(ui.trace, tracing, { on: 'Stop tracing', off: 'Trace callbacks 10 s' });

  let longest = null as (typeof events)[number] | null;
  for (const e of events) if (longest === null || e.duration > longest.duration) longest = e;
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
    const iterations = timeline.iterations();
    lane.render({ events, gc: timeline.gcEvents(), iterations, end, spanMs: state.spanMs });

    // Legend with counts in the visible span.
    const counts = new Map<string, number>();
    for (const e of events) if (e.start >= end - state.spanMs) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
    ui.legend.replaceChildren(
      ...TASK_CATEGORIES.map((category) => legendChip(ROW_COLOR[category], `${CATEGORY_LABEL[category]} ${counts.get(category) ?? 0}`)),
      legendChip(ROW_COLOR.gc, ROW_LABEL.gc),
    );

    strip.render(iterations, state.selectedIteration);
    renderIteration(iterations, events);
  } else {
    ui.legend.replaceChildren();
  }

  const insights = timeline.insights();
  charts.loopDelay.setMarkers(markerTimes(insights.flatMap((i) => (i.kind === 'loop-stall' ? [i.t] : [])), MARKER_GAP_MS));
  charts.loopDelay.setData(columns(frames, from, [(f) => f.loop.delay.p50, (f) => f.loop.delay.p99, (f) => f.loop.delay.max, (f) => f.loop.utilization * 100]));
  charts.loopRate.setData(columns(frames, from, [(f) => f.loop.iterationsPerSec, (f) => f.loop.eventsPerSec]));

  fillTable(
    ui.queues,
    timeline
      .queues()
      .slice(0, 12)
      .map((q) => [{ text: q.resource }, { text: CATEGORY_LABEL[q.category] }, { text: String(q.pending), numeric: true }, { text: String(q.executed), numeric: true }, { text: formatMs(q.busy), numeric: true }]),
    'start a trace to see queued work',
  );
}

function renderIteration(iterations: readonly Iteration[], events: Parameters<typeof iterationDetail>[0]): void {
  const selected = iterations.find((it) => it.index === state.selectedIteration) ?? iterations[iterations.length - 1];
  if (selected === undefined) {
    ui.iterationDetail.textContent = '';
    ui.phaseBar.replaceChildren();
    return;
  }
  const busy = LOOP_PHASES.reduce((sum, phase) => sum + selected.phaseBusy[phase], 0);
  ui.phaseBar.replaceChildren(
    ...LOOP_PHASES.filter((phase) => selected.phaseBusy[phase] > 0).map((phase) => {
      const part = el('span', '', `${phase} ${formatMs(selected.phaseBusy[phase])}`);
      part.style.flex = `${selected.phaseBusy[phase] / Math.max(busy, 1e-9)} 1 0`;
      part.style.background = `var(${PHASE_COLOR[phase]})`;
      part.title = part.textContent ?? '';
      return part;
    }),
  );

  const detail = iterationDetail(events, selected);
  const head = el('div', '');
  head.append(el('b', '', `#${selected.index}${selected.inferred ? ' (inferred)' : ''}`), document.createTextNode(` · ${iterationSummary(selected) || 'nothing traced'} · busy ${formatMs(selected.busy)}`));
  const list = el('div', 'groups');
  for (const group of detail.groups.slice(0, 16)) {
    const chip = legendChip(ROW_COLOR[group.category], `${group.label} ×${group.count} · ${formatMs(group.total)}${group.count > 1 ? ` (longest ${formatMs(group.longest)})` : ''}`);
    chip.title = CATEGORY_LABEL[group.category];
    list.append(chip);
  }
  if (detail.groups.length > 16) list.append(document.createTextNode(`+${detail.groups.length - 16} more kinds`));
  ui.iterationDetail.replaceChildren(head, list);
}

// ---- HTTP ---------------------------------------------------------------------------------

interface HttpPoint {
  readonly t: number;
  readonly server: HttpRates;
  readonly client: HttpRates;
}

function httpPoints(timeline: Timeline): HttpPoint[] {
  return timeline.httpWindows().map((w) => ({ t: w.end, server: httpRates(w.server, w), client: httpRates(w.client, w) }));
}

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

function renderHttp({ timeline, from }: View): void {
  const windows = timeline.httpWindows();
  ui.httpEmpty.hidden = windows.length > 0;
  ui.httpBody.hidden = windows.length === 0;
  if (windows.length === 0) return;
  const points = httpPoints(timeline);
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
  const insights = timeline.insights().filter((i) => i.kind === 'http-errors' || i.kind === 'http-slow' || i.kind === 'http-stuck');
  charts.httpRate.setMarkers(markerTimes(insights.filter((i) => i.kind === 'http-errors').map((i) => i.t), MARKER_GAP_MS));
  charts.httpRate.setData(columns(points, from, [(p) => p.server.rps, (p) => p.client.rps, (p) => p.server.errorRate * 100, (p) => p.client.errorRate * 100]));
  charts.httpLatency.setMarkers(markerTimes(insights.filter((i) => i.kind !== 'http-errors').map((i) => i.t), MARKER_GAP_MS));
  const latency = (r: HttpRates): number | null => (r.rps > 0 ? r.p50 : null);
  const tail = (r: HttpRates): number | null => (r.rps > 0 ? r.p99 : null);
  charts.httpLatency.setData(columns(points, from, [(p) => latency(p.server), (p) => tail(p.server), (p) => latency(p.client), (p) => tail(p.client)]));

  const recentWindows = from > 0 ? windows.filter((w) => w.end >= from) : windows;
  const served = summarizeHttp(recentWindows, 'server', 15);
  const made = summarizeHttp(recentWindows, 'client', 15);
  fillTable(ui.httpRoutes, routeRows(served?.routes ?? []), 'no requests served');
  fillTable(ui.httpCalls, routeRows(made?.routes ?? []), 'no requests made');
  const slowest = [...(served?.slowest ?? []).map((e) => ({ ...e, side: 'in' })), ...(made?.slowest ?? []).map((e) => ({ ...e, side: 'out' }))]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 10);
  fillTable(
    ui.httpSlowest,
    slowest.map((e) => [{ text: `${e.side === 'in' ? '→' : '←'} ${e.route}` }, { text: e.status === 0 ? 'failed' : String(e.status), numeric: true, className: e.status === 0 || e.status >= 500 ? 'up' : '' }, { text: formatMs(e.ms), numeric: true, className: e.ms >= 1000 ? 'warn' : '' }]),
    'nothing yet',
  );
  const running = last === undefined ? [] : [...last.server.stuck.map((r) => ({ ...r, side: '→' })), ...last.client.stuck.map((r) => ({ ...r, side: '←' }))];
  fillTable(
    ui.httpRunning,
    running.sort((a, b) => b.ageMs - a.ageMs).map((r) => [{ text: `${r.side} ${r.route}` }, { text: formatMs(r.ageMs), numeric: true, className: r.ageMs >= 10_000 ? 'up' : 'warn' }]),
    'nothing running long',
  );
}

// ---- files & DNS --------------------------------------------------------------------------

interface IoPoint {
  readonly t: number;
  readonly fs: IoRates;
  readonly sync: IoRates;
  readonly dns: IoRates;
}

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

function renderIo({ timeline, from, latest }: View): void {
  const windows = timeline.ioWindows();
  const last = windows[windows.length - 1];
  const fsSeen = last !== undefined && latest !== undefined && last.end >= latest.t - 3000 && last.fs.calls + last.fsSync.calls > 0;
  const timing = toggleState('fs', fsSeen);
  showToggle(ui.fsToggle, timing, { on: 'Stop fs timing', off: 'Start fs timing' });

  const points: IoPoint[] = windows.map((w) => ({ t: w.end, fs: ioRates(w.fs, w), sync: ioRates(w.fsSync, w), dns: ioRates(w.dns, w) }));
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
  const insights = timeline.insights();
  charts.ioRate.setMarkers(markerTimes(insights.flatMap((i) => (i.kind === 'fs-blocking' ? [i.t] : [])), MARKER_GAP_MS));
  charts.ioRate.setData(columns(points, from, [(p) => p.fs.perSec, (p) => p.sync.perSec, (p) => p.dns.perSec, (p) => p.sync.msPerSec]));
  charts.ioLatency.setMarkers(markerTimes(insights.flatMap((i) => (i.kind === 'dns-slow' ? [i.t] : [])), MARKER_GAP_MS));
  charts.ioLatency.setData(columns(points, from, [(p) => p99(p.fs), (p) => p99(p.sync), (p) => p99(p.dns)]));

  const recentWindows = from > 0 ? windows.filter((w) => w.end >= from) : windows;
  fillTable(ui.ioFs, ioRows(summarizeIo(recentWindows, 'fs', 15)?.operations ?? []), timing ? 'no file system calls yet' : 'start fs timing to see file system calls');
  fillTable(ui.ioSync, ioRows(summarizeIo(recentWindows, 'fsSync', 15)?.operations ?? []), timing ? 'no *Sync calls: nothing blocked the loop' : 'start fs timing to see blocking calls');
  fillTable(ui.ioDns, ioRows(summarizeIo(recentWindows, 'dns', 15)?.operations ?? []), 'no DNS lookups yet');
}

// ---- CPU ----------------------------------------------------------------------------------

function renderCpu({ timeline, frames, from, latest }: View): void {
  renderTiles('cpu', [
    { label: 'CPU', value: latest ? formatPercent(latest.cpu.total) : '—', detail: 'of one core', level: (latest?.cpu.total ?? 0) > 90 ? 'warn' : 'ok', spark: recent(frames, (f) => f.cpu.total) },
    { label: 'User', value: latest ? formatPercent(latest.cpu.user) : '—', detail: 'JavaScript and native code', spark: recent(frames, (f) => f.cpu.user) },
    { label: 'System', value: latest ? formatPercent(latest.cpu.system) : '—', detail: 'kernel on behalf of the process', spark: recent(frames, (f) => f.cpu.system), color: '--s3' },
    { label: 'Of the machine', value: latest ? formatPercent(latest.cpu.ofMachine) : '—', detail: `${current()?.hello.cpus ?? '?'} cores`, spark: recent(frames, (f) => f.cpu.ofMachine), color: '--s4' },
  ]);
  charts.cpu.setData(columns(frames, from, [(f) => f.cpu.user, (f) => f.cpu.system, (f) => f.cpu.ofMachine, (f) => f.overhead]));
  const windows = timeline.cpuWindows();
  const last = windows[windows.length - 1];
  const profiling = toggleState('cpu', last !== undefined && latest !== undefined && last.end >= latest.t - 3000);
  showToggle(ui.cpuToggle, profiling, { on: 'Stop CPU profile', off: 'Start CPU profile' });

  const merged = timeline.cpuFlame(FLAME_WINDOWS);
  const agent = timeline.hello?.agentScript ?? '';
  ui.flameWrap.hidden = merged === null;
  ui.baseline.hidden = merged === null && state.baseline === null;
  ui.cpuDownload.hidden = merged === null || state.selected === null;
  if (state.selected !== null) ui.cpuDownload.href = exportUrl({ token, source: state.selected, kind: 'cpu' });
  ui.baseline.textContent = state.baseline === null ? 'Pin as baseline' : 'Clear baseline';
  ui.baseline.className = state.baseline === null ? 'ghost' : 'on';
  if (merged === null) {
    ui.flameNote.textContent = 'start the CPU profile to see where time goes';
    ui.hot.hidden = true;
    ui.changes.hidden = true;
    return;
  }
  const tree = withoutScript(merged, agent);
  const baseline = state.baseline;
  const full = baseline === null ? tree.root : diffFlames(baseline, tree);
  const focus = findByPath(full, state.flamePath);
  if (focus === null) state.flamePath = [];
  const root = focus ?? full;
  ui.flameCrumb.textContent = state.flamePath.length === 0 ? '' : `zoomed: ${root.name}`;
  ui.flameReset.hidden = state.flamePath.length === 0;
  ui.flameNote.textContent =
    baseline === null ? `last ${FLAME_WINDOWS} windows · click to zoom${inVscode ? ' · double-click to open the code' : ''}` : 'now vs pinned baseline: red got heavier, blue got lighter; share of CPU work';
  flame.render(root);

  ui.hot.hidden = baseline !== null;
  ui.changes.hidden = baseline === null;
  if (baseline === null) {
    fillTable(ui.hot, hotFunctions(tree, 15).map((fn) => [{ text: formatShare(fn.selfShare), numeric: true }, { text: fn.name }, whereCell(fn)]), 'no samples yet');
    return;
  }
  fillTable(
    ui.changes,
    changedFunctions(baseline, tree, 15).map((c): Cell[] => [
      { text: `${c.delta >= 0 ? '+' : '−'}${Math.abs(c.delta * 100).toFixed(1)} pts`, numeric: true, className: c.delta > 0.001 ? 'up' : c.delta < -0.001 ? 'down' : '' },
      { text: formatShare(c.now), numeric: true },
      { text: formatShare(c.before), numeric: true },
      { text: c.name },
      whereCell(c),
    ]),
    'no change yet',
  );
}

// ---- memory -------------------------------------------------------------------------------

const SPACE_COLORS = ['--s1', '--s3', '--s5', '--s2', '--s4'];

function renderMemory({ timeline, frames, from, latest }: View): void {
  renderTiles('memory', [
    { label: 'RSS', value: latest ? formatBytes(latest.memory.rss) : '—', detail: latest ? `${formatShare(latest.os.memoryShare)} of ${formatBytes(latest.os.memoryLimit)}` : '', level: (latest?.os.memoryShare ?? 0) > 0.9 ? 'bad' : 'ok', spark: recent(frames, (f) => f.memory.rss), color: '--s3' },
    { label: 'Heap used', value: latest ? formatBytes(latest.memory.heapUsed) : '—', detail: latest ? `of ${formatBytes(latest.heap.limit)} limit` : '', level: latest !== undefined && latest.memory.heapUsed > latest.heap.limit * 0.9 ? 'bad' : 'ok', spark: recent(frames, (f) => f.memory.heapUsed) },
    { label: 'External', value: latest ? formatBytes(latest.memory.external) : '—', detail: 'C++ objects bound to JS', spark: recent(frames, (f) => f.memory.external), color: '--s5' },
    { label: 'ArrayBuffers', value: latest ? formatBytes(latest.memory.arrayBuffers) : '—', detail: 'Buffers and typed arrays', spark: recent(frames, (f) => f.memory.arrayBuffers), color: '--s4' },
  ]);
  charts.memory.setData(columns(frames, from, [(f) => f.memory.rss, (f) => f.memory.heapTotal, (f) => f.memory.heapUsed, (f) => f.memory.external, (f) => f.memory.arrayBuffers]));
  // Spaces this V8 build does not use (shared, sandbox ones) stay at 0 B: leave them out.
  ui.spaces.replaceChildren(
    ...(latest?.heapSpaces ?? [])
      .filter((space) => space.size > 0)
      .map((space, i) =>
        meterRow({ name: space.name.replace(/_space$/, ''), amount: `${formatBytes(space.used)} / ${formatBytes(space.size)}`, share: space.used / space.size, colorVar: SPACE_COLORS[i % SPACE_COLORS.length] ?? '--s1' }),
      ),
  );

  const allocations = timeline.allocations();
  const sampling = toggleState('heap', allocations !== null && latest !== undefined && allocations.end >= latest.t - 5000);
  showToggle(ui.heapToggle, sampling, { on: 'Stop allocation sampling', off: 'Start allocation sampling' });
  ui.heapDownload.hidden = allocations === null || state.selected === null;
  if (state.selected !== null) ui.heapDownload.href = exportUrl({ token, source: state.selected, kind: 'heap' });
  const tree = allocations === null ? null : withoutScript(allocations, timeline.hello?.agentScript ?? '');
  fillTable(
    ui.allocations,
    tree === null ? [] : hotFunctions(tree, 12).map((fn) => [{ text: formatBytes(fn.self), numeric: true }, { text: fn.name }, whereCell(fn)]),
    'start allocation sampling to see who allocates',
  );
}

// ---- garbage collector --------------------------------------------------------------------

function renderGc({ timeline, frames, from, latest }: View): void {
  const all = timeline.gcEvents();
  const events = from > 0 ? all.filter((e) => e.start >= from) : all;
  const gcPause = sumRecent(frames, 10_000, (f) => f.gc.pause);
  let longest = 0;
  for (const e of events) longest = Math.max(longest, e.duration);
  renderTiles('gc', [
    { label: 'GC time, last 10 s', value: formatMs(gcPause), detail: `${formatShare(gcPause / 10_000)} of wall time`, level: gcPause > 1000 ? 'bad' : gcPause > 300 ? 'warn' : 'ok', spark: recent(frames, (f) => f.gc.pause) },
    { label: 'Longest pause', value: formatMs(longest), detail: 'in the chart window', level: delayLevel(longest), spark: recent(frames, (f) => f.gc.maxPause), color: '--s3' },
    { label: 'Runs, last 10 s', value: String(sumRecent(frames, 10_000, (f) => f.gc.count)), detail: `${sumRecent(frames, 10_000, (f) => f.gc.byKind.minor.count)} scavenge · ${sumRecent(frames, 10_000, (f) => f.gc.byKind.major.count)} mark-compact`, spark: recent(frames, (f) => f.gc.count) },
    { label: 'Heap used', value: latest ? formatBytes(latest.memory.heapUsed) : '—', detail: latest ? `of ${formatBytes(latest.heap.limit)} limit` : '', spark: recent(frames, (f) => f.memory.heapUsed), color: '--s5' },
  ]);

  charts.gc.setMarkers(markerTimes(timeline.insights().flatMap((i) => (i.kind === 'gc-pressure' ? [i.t] : [])), MARKER_GAP_MS));
  charts.gc.setData(columns(frames, from, [(f) => (f.gc.pause > 0 ? f.gc.pause : null), (f) => (f.gc.byKind.major.pause > 0 ? f.gc.byKind.major.pause : null)]));

  const counts = pauseHistogram(events);
  const most = Math.max(1, ...counts);
  ui.gcHistogram.replaceChildren(
    ...counts.map((n, i) => {
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
  fillTable(
    ui.gcKinds,
    gcByKind(events).map((row) => [
      { text: GC_LABEL[row.kind] },
      { text: String(row.runs), numeric: true },
      { text: formatMs(row.avg), numeric: true },
      { text: formatMs(row.max), numeric: true, className: row.max >= 100 ? 'up' : row.max >= 20 ? 'warn' : '' },
      { text: formatMs(row.total), numeric: true },
    ]),
    'no GC yet',
  );
  const now = latest?.t ?? 0;
  fillTable(
    ui.gcList,
    all
      .slice(-15)
      .reverse()
      .map((e) => [{ text: `−${formatMs(Math.max(0, now - e.start))}` }, { text: GC_LABEL[e.kind] }, { text: formatMs(e.duration), numeric: true, className: e.duration >= 100 ? 'up' : e.duration >= 20 ? 'warn' : '' }]),
    'no GC yet',
  );
}

// ---- system -------------------------------------------------------------------------------

function renderSystem({ entry, frames, from, latest }: View): void {
  const host = store.host.hostSamples();
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
  ui.handles.replaceChildren(...resources.slice(0, 8).map((r, i) => meterRow({ name: r.type, amount: String(r.count), share: r.count / most, colorVar: SPACE_COLORS[i % SPACE_COLORS.length] ?? '--s1' })));
  if (resources.length === 0) ui.handles.replaceChildren(el('span', 'muted', 'no active handles'));

  fillTable(
    ui.threads,
    [...store.sources.values()].map((source): Cell[] => {
      const frames = source.timeline.frames();
      const f = frames[frames.length - 1];
      const selected = source.id === state.selected;
      return [
        { text: `${selected ? '● ' : ''}${sourceLabel(source.hello)}`, className: selected ? '' : 'link', action: () => selectSource(source.id) },
        { text: f ? formatPercent(f.cpu.total) : '—', numeric: true },
        { text: f ? formatMs(f.loop.delay.p99) : '—', numeric: true, className: f && f.loop.delay.p99 >= 20 ? 'warn' : '' },
        { text: f ? formatBytes(f.memory.heapUsed) : '—', numeric: true },
        { text: formatMs(sumRecent(frames, 10_000, (x) => x.gc.pause)), numeric: true },
      ];
    }),
    'no threads yet',
  );
}

// ---- render loop --------------------------------------------------------------------------

let scheduled = false;
let lastRender = 0;
let renderedRevision = -1;

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  const wait = Math.max(0, RENDER_MS - (performance.now() - lastRender));
  setTimeout(() =>
    requestAnimationFrame(() => {
      scheduled = false;
      lastRender = performance.now();
      if (!state.paused && store.revision !== renderedRevision) render();
      else renderHeader();
    }),
  wait);
}

/** Only the open page is drawn: hidden canvases have no size, and hidden tables are wasted work. */
function render(): void {
  renderedRevision = store.revision;
  renderHeader();
  const entry = current();
  if (entry === undefined) {
    renderShell(null);
    pageTiles(state.page).replaceChildren(tile({ label: 'Waiting', value: '…', detail: 'for the first samples' }));
    return;
  }
  const timeline = entry.timeline;
  const frames = timeline.frames();
  const latest = frames[frames.length - 1];
  const from = state.windowMs > 0 && latest !== undefined ? latest.t - state.windowMs : 0;
  const view: View = { entry, timeline, frames, latest, from, report: buildReport(timeline) };
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
  state.selected = id;
  state.flamePath = [];
  state.selectedIteration = null;
  state.baseline = null;
  render();
}

ui.source.addEventListener('change', () => selectSource(ui.source.value as SourceId));
segmented(ui.window, (value) => {
  state.windowMs = Number(value);
  render();
});
segmented(ui.span, (value) => {
  state.spanMs = Number(value);
  render();
});
pressSegment(ui.window, String(state.windowMs));
pressSegment(ui.span, String(state.spanMs));
ui.pause.addEventListener('click', () => {
  state.paused = !state.paused;
  render();
});
ui.trace.addEventListener('click', () => void toggle('trace', ui.trace, TRACE, { type: 'loop-trace-stop' }));
ui.cpuToggle.addEventListener('click', () => void toggle('cpu', ui.cpuToggle, CPU, { type: 'cpu-profile-stop' }));
ui.heapToggle.addEventListener('click', () => void toggle('heap', ui.heapToggle, HEAP, { type: 'heap-sampling-stop' }));
ui.fsToggle.addEventListener('click', () => void toggle('fs', ui.fsToggle, { type: 'fs-timing-start' }, { type: 'fs-timing-stop' }));
ui.baseline.addEventListener('click', () => {
  const entry = current();
  const merged = entry?.timeline.cpuFlame(FLAME_WINDOWS) ?? null;
  state.baseline = state.baseline !== null || merged === null ? null : withoutScript(merged, entry?.hello.agentScript ?? '');
  state.flamePath = [];
  render();
});
ui.flameReset.addEventListener('click', () => {
  state.flamePath = [];
  render();
});
window.addEventListener('hashchange', () => {
  state.page = parseRoute(location.hash);
  showPage();
  window.scrollTo(0, 0);
  render();
});
window.addEventListener('resize', () => render());
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  for (const chart of Object.values(charts)) chart.rebuild();
  render();
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
    if (!open && store.status?.state !== 'exited') ui.status.textContent = 'reconnecting…';
  },
});
showPage();
render();
