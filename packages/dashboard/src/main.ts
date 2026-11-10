// Dashboard entry: stream → Store → views, redrawn at most every RENDER_MS.

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
  type SourceId,
  type Timeline,
} from '@node-xray/core';
import { connectStream, exportUrl, resolvePositions, sendCommand } from './api.js';
import { TimeChart } from './charts.js';
import { byId, fillTable, shortLocation, type Cell } from './dom.js';
import { findByPath } from './flame-layout.js';
import { FlameView } from './flame-view.js';
import { iterationDetail } from './lane-layout.js';
import { IterationStrip, iterationSummary, LaneView, ROW_COLOR, ROW_LABEL } from './lane-view.js';
import { OriginalsCache } from './originals.js';
import { columns, markerTimes, shortIoKey } from './series.js';
import { parseStatus, sourceLabel, Store, type SourceEntry } from './store.js';

const RENDER_MS = 200;
/** Findings closer than this in time are one marker on the charts. */
const MARKER_GAP_MS = 2000;
/** Live flame graph: the last N CPU windows (1 s each when started from here). */
const FLAME_WINDOWS = 10;
const TRACE: AgentCommand = { type: 'loop-trace-start', flushMs: 250, maxEventsPerFlush: 5000, durationMs: 10_000 };
const CPU: AgentCommand = { type: 'cpu-profile-start', samplingIntervalUs: 1000, windowMs: 1000 };
const HEAP: AgentCommand = { type: 'heap-sampling-start', samplingIntervalBytes: 32 * 1024, windowMs: 2000 };

const params = new URLSearchParams(location.search);
const token = params.get('token') ?? '';
/** Inside the VS Code extension's webview: code locations open in the editor. */
const inVscode = params.get('host') === 'vscode' && window.parent !== window;
const store = new Store();

const ui = {
  source: byId('source', HTMLSelectElement),
  status: byId('status', HTMLElement),
  window: byId('window', HTMLSelectElement),
  pause: byId('pause', HTMLButtonElement),
  tiles: byId('tiles', HTMLElement),
  findings: byId('findings', HTMLElement),
  trace: byId('trace', HTMLButtonElement),
  span: byId('span', HTMLSelectElement),
  legend: byId('lane-legend', HTMLElement),
  laneEmpty: byId('lane-empty', HTMLElement),
  laneWrap: byId('lane-wrap', HTMLElement),
  iterWrap: byId('iter-wrap', HTMLElement),
  iterationDetail: byId('iteration-detail', HTMLElement),
  queues: byId('queues', HTMLTableElement),
  handles: byId('handles', HTMLTableElement),
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
  gcList: byId('gc-list', HTMLTableElement),
  hostFacts: byId('host-facts', HTMLElement),
  httpPanel: byId('http-panel', HTMLElement),
  fsToggle: byId('fs-toggle', HTMLButtonElement),
  ioFs: byId('io-fs', HTMLTableElement),
  ioSync: byId('io-sync', HTMLTableElement),
  ioDns: byId('io-dns', HTMLTableElement),
  httpRoutes: byId('http-routes', HTMLTableElement),
  httpCalls: byId('http-calls', HTMLTableElement),
  httpSlowest: byId('http-slowest', HTMLTableElement),
  httpRunning: byId('http-running', HTMLTableElement),
};

const state = {
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

const charts = {
  loopDelay: new TimeChart(byId('chart-loop-delay', HTMLElement), {
    title: 'Loop delay and utilization',
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
    title: 'Loop throughput',
    left: perSec,
    series: [
      { label: 'iterations', color: '--s1', format: perSec },
      { label: 'libuv events', color: '--s5', format: perSec },
    ],
  }),
  cpu: new TimeChart(byId('chart-cpu', HTMLElement), {
    title: 'CPU (percent of one core)',
    left: pct,
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
    height: 200,
    series: [
      { label: 'RSS', color: '--s3', format: bytes },
      { label: 'heap total', color: '--s2', format: bytes },
      { label: 'heap used', color: '--s1', format: bytes, fill: true },
      { label: 'external', color: '--s5', format: bytes },
      { label: 'ArrayBuffers', color: '--s4', format: bytes },
    ],
  }),
  gc: new TimeChart(byId('chart-gc', HTMLElement), {
    title: 'GC pauses per sample',
    left: ms,
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
    title: 'HTTP requests per second',
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
    title: 'HTTP latency',
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

function tile(label: string, value: string, detail: string, level: 'ok' | 'warn' | 'bad' = 'ok'): HTMLElement {
  const el = document.createElement('div');
  el.className = `tile${level === 'ok' ? '' : ` ${level}`}`;
  const l = document.createElement('div');
  l.className = 'label';
  l.textContent = label;
  const v = document.createElement('div');
  v.className = 'value';
  v.textContent = value;
  const d = document.createElement('div');
  d.className = 'detail';
  d.textContent = detail;
  el.append(l, v, d);
  return el;
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

// ---- sections -----------------------------------------------------------------------------

function renderHeader(): void {
  const options = [...store.sources.values()];
  const wanted = options.map((s) => `${s.id}|${sourceLabel(s.hello)}`).join('\n');
  if (ui.source.dataset['options'] !== wanted) {
    ui.source.dataset['options'] = wanted;
    ui.source.replaceChildren(
      ...options.map((s) => {
        const option = document.createElement('option');
        option.value = s.id;
        option.textContent = sourceLabel(s.hello);
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
  ui.pause.textContent = state.paused ? 'Resume' : 'Pause';
  // Commands need a live agent: not after exit or detach, never in a replay.
  const live = status === null || status.state === 'running';
  for (const button of [ui.trace, ui.cpuToggle, ui.heapToggle, ui.fsToggle]) {
    button.disabled = !live;
    button.title = live ? '' : 'nothing is running: this view is a recording or the process is gone';
  }
}

function httpTiles(timeline: Timeline): HTMLElement[] {
  const last = timeline.httpWindows().at(-1);
  if (last === undefined) return [];
  const rates = httpRates(last.server, last);
  const out = httpRates(last.client, last);
  const tiles = [];
  if (rates.rps > 0 || last.server.inFlight > 0) tiles.push(tile('HTTP in', `${Math.round(rates.rps)}/s`, `p99 ${formatMs(rates.p99)} · errors ${formatShare(rates.errorRate)}`, rates.errorRate >= 0.05 ? 'bad' : rates.p99 >= 1000 ? 'warn' : 'ok'));
  if (out.rps > 0 || last.client.inFlight > 0) tiles.push(tile('HTTP out', `${Math.round(out.rps)}/s`, `p99 ${formatMs(out.p99)} · errors ${formatShare(out.errorRate)}`, out.errorRate >= 0.05 ? 'bad' : out.p99 >= 1000 ? 'warn' : 'ok'));
  return tiles;
}

function renderTiles(frames: readonly Frame[], timeline: Timeline | null): void {
  const f = frames[frames.length - 1];
  if (f === undefined) {
    ui.tiles.replaceChildren(tile('Waiting', '…', 'for the first samples'));
    return;
  }
  const delay = f.loop.delay.p99;
  const gcPause = sumRecent(frames, 10_000, (x) => x.gc.pause);
  const gcRuns = sumRecent(frames, 10_000, (x) => x.gc.count);
  const handles = f.resources.reduce((n, r) => n + r.count, 0);
  const swap = f.os.processSwap;
  const hostSwap = store.host.hostSamples().at(-1)?.swap ?? null;
  ui.tiles.replaceChildren(
    tile('CPU', formatPercent(f.cpu.total), `${formatPercent(f.cpu.ofMachine)} of machine`, f.cpu.total > 90 ? 'warn' : 'ok'),
    tile('Loop delay p99', formatMs(delay), `max ${formatMs(f.loop.delay.max)}`, delay >= 100 ? 'bad' : delay >= 20 ? 'warn' : 'ok'),
    tile('Loop busy', formatShare(f.loop.utilization), f.loop.iterationsPerSec === null ? 'iterations n/a' : `${Math.round(f.loop.iterationsPerSec)} iterations/s`, f.loop.utilization > 0.9 ? 'warn' : 'ok'),
    tile('RSS', formatBytes(f.memory.rss), `${formatShare(f.os.memoryShare)} of ${formatBytes(f.os.memoryLimit)}`, f.os.memoryShare > 0.9 ? 'bad' : 'ok'),
    tile('Heap used', formatBytes(f.memory.heapUsed), `of ${formatBytes(f.heap.limit)} limit`, f.memory.heapUsed > f.heap.limit * 0.9 ? 'bad' : 'ok'),
    tile('GC, last 10 s', formatMs(gcPause), `${gcRuns} runs`, gcPause > 1000 ? 'warn' : 'ok'),
    tile(
      'Swap',
      swap !== null ? formatBytes(swap) : hostSwap !== null ? formatBytes(hostSwap.used) : 'n/a',
      `${swap !== null ? 'this process' : hostSwap !== null ? 'whole system' : ''} · ${f.os.majorFaultsPerSec.toFixed(0)} major faults/s`,
      f.os.majorFaultsPerSec >= 100 ? 'bad' : 'ok',
    ),
    tile('Handles', String(handles), f.resources.slice(0, 2).map((r) => `${r.type} ${r.count}`).join(' · ')),
    ...(timeline === null ? [] : httpTiles(timeline)),
    tile('xray overhead', formatPercent(f.overhead), 'agent main-thread time'),
  );
}

function renderFindings(timeline: Timeline): void {
  const report = buildReport(timeline);
  const insights = report?.insights ?? [];
  ui.findings.hidden = insights.length === 0 && timeline.errors().length === 0;
  if (report === null) return;
  const rows = insights.map((summary) => {
    const div = document.createElement('div');
    div.className = 'finding';
    const times = summary.count > 1 ? ` (×${summary.count}, worst shown)` : '';
    div.textContent = `${describeInsight(summary.worst, report.from)}${times}`;
    if (summary.culprit !== null) {
      const c = document.createElement('div');
      c.className = 'culprit';
      c.textContent = `likely in ${summary.culprit.name} ${where(summary.culprit)} (${formatShare(summary.culprit.selfShare)} of CPU in that window)`;
      div.append(c);
    }
    return div;
  });
  for (const error of timeline.errors().slice(-3)) {
    const div = document.createElement('div');
    div.className = 'finding';
    div.textContent = `agent: ${error}`;
    rows.push(div);
  }
  ui.findings.replaceChildren(...rows);
}

function renderLoop(timeline: Timeline, frames: readonly Frame[], from: number): void {
  const latest = frames[frames.length - 1];
  const events = timeline.loopEvents();
  const windows = timeline.traceWindows();
  const lastWindow = windows[windows.length - 1];
  const tracing = toggleState('trace', lastWindow !== undefined && latest !== undefined && lastWindow.end >= latest.t - 1500);
  ui.trace.textContent = tracing ? 'Stop tracing' : 'Trace callbacks 10 s';
  ui.trace.className = tracing ? 'on' : '';

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
  fillTable(ui.handles, (latest?.resources ?? []).map((r) => [{ text: r.type }, { text: String(r.count), numeric: true }]), 'no active handles');
}

function legendChip(colorVar: string, text: string): HTMLElement {
  const chip = document.createElement('span');
  chip.className = 'chip';
  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  swatch.style.background = `var(${colorVar})`;
  chip.append(swatch, document.createTextNode(text));
  return chip;
}

function renderIteration(iterations: readonly Iteration[], events: Parameters<typeof iterationDetail>[0]): void {
  const selected = iterations.find((it) => it.index === state.selectedIteration) ?? iterations[iterations.length - 1];
  if (selected === undefined) {
    ui.iterationDetail.textContent = '';
    return;
  }
  const detail = iterationDetail(events, selected);
  const head = document.createElement('div');
  const title = document.createElement('b');
  title.textContent = `#${selected.index}${selected.inferred ? ' (inferred)' : ''}`;
  head.append(title, document.createTextNode(` · ${iterationSummary(selected) || 'nothing traced'} · busy ${formatMs(selected.busy)} · timers ${formatMs(selected.phaseBusy.timers)} / poll ${formatMs(selected.phaseBusy.poll)} / check ${formatMs(selected.phaseBusy.check)} / microtasks ${formatMs(selected.phaseBusy.microtasks)}`));
  const list = document.createElement('div');
  list.className = 'groups';
  for (const group of detail.groups.slice(0, 16)) {
    const chip = legendChip(ROW_COLOR[group.category], `${group.label} ×${group.count} · ${formatMs(group.total)}${group.count > 1 ? ` (longest ${formatMs(group.longest)})` : ''}`);
    chip.title = CATEGORY_LABEL[group.category];
    list.append(chip);
  }
  if (detail.groups.length > 16) list.append(document.createTextNode(`+${detail.groups.length - 16} more kinds`));
  ui.iterationDetail.replaceChildren(head, list);
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

interface HttpPoint {
  readonly t: number;
  readonly server: HttpRates;
  readonly client: HttpRates;
}

function renderHttp(timeline: Timeline, from: number): void {
  const windows = timeline.httpWindows();
  ui.httpPanel.hidden = windows.length === 0;
  if (windows.length === 0) return;
  const points: HttpPoint[] = windows.map((w) => ({ t: w.end, server: httpRates(w.server, w), client: httpRates(w.client, w) }));
  const insights = timeline.insights().filter((i) => i.kind === 'http-errors' || i.kind === 'http-slow' || i.kind === 'http-stuck');
  charts.httpRate.setMarkers(markerTimes(insights.filter((i) => i.kind === 'http-errors').map((i) => i.t), MARKER_GAP_MS));
  charts.httpRate.setData(columns(points, from, [(p) => p.server.rps, (p) => p.client.rps, (p) => p.server.errorRate * 100, (p) => p.client.errorRate * 100]));
  charts.httpLatency.setMarkers(markerTimes(insights.filter((i) => i.kind !== 'http-errors').map((i) => i.t), MARKER_GAP_MS));
  const latency = (r: HttpRates): number | null => (r.rps > 0 ? r.p50 : null);
  const tail = (r: HttpRates): number | null => (r.rps > 0 ? r.p99 : null);
  charts.httpLatency.setData(columns(points, from, [(p) => latency(p.server), (p) => tail(p.server), (p) => latency(p.client), (p) => tail(p.client)]));

  const recent = from > 0 ? windows.filter((w) => w.end >= from) : windows;
  const served = summarizeHttp(recent, 'server', 15);
  const made = summarizeHttp(recent, 'client', 15);
  fillTable(ui.httpRoutes, routeRows(served?.routes ?? []), 'no requests served');
  fillTable(ui.httpCalls, routeRows(made?.routes ?? []), 'no requests made');
  const slowest = [...(served?.slowest ?? []).map((e) => ({ ...e, side: 'in' })), ...(made?.slowest ?? []).map((e) => ({ ...e, side: 'out' }))]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 10);
  fillTable(
    ui.httpSlowest,
    slowest.map((e) => [{ text: `${e.side === 'in' ? '→' : '←'} ${e.route}` }, { text: e.status === 0 ? 'failed' : String(e.status), numeric: true, className: e.status === 0 || e.status >= 500 ? 'up' : '' }, { text: formatMs(e.ms), numeric: true }]),
    'nothing yet',
  );
  const last = windows[windows.length - 1];
  const running = last === undefined ? [] : [...last.server.stuck.map((r) => ({ ...r, side: '→' })), ...last.client.stuck.map((r) => ({ ...r, side: '←' }))];
  fillTable(
    ui.httpRunning,
    running.sort((a, b) => b.ageMs - a.ageMs).map((r) => [{ text: `${r.side} ${r.route}` }, { text: formatMs(r.ageMs), numeric: true, className: r.ageMs >= 10_000 ? 'up' : '' }]),
    'nothing running long',
  );
}

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

function renderIo(timeline: Timeline, from: number, latest: Frame | undefined): void {
  const windows = timeline.ioWindows();
  const last = windows[windows.length - 1];
  const fsSeen = last !== undefined && latest !== undefined && last.end >= latest.t - 3000 && last.fs.calls + last.fsSync.calls > 0;
  const timing = toggleState('fs', fsSeen);
  ui.fsToggle.textContent = timing ? 'Stop fs timing' : 'Start fs timing';
  ui.fsToggle.className = timing ? 'on' : '';

  const points: IoPoint[] = windows.map((w) => ({ t: w.end, fs: ioRates(w.fs, w), sync: ioRates(w.fsSync, w), dns: ioRates(w.dns, w) }));
  const p99 = (r: IoRates): number | null => (r.perSec > 0 ? r.p99 : null);
  const insights = timeline.insights();
  charts.ioRate.setMarkers(markerTimes(insights.flatMap((i) => (i.kind === 'fs-blocking' ? [i.t] : [])), MARKER_GAP_MS));
  charts.ioRate.setData(columns(points, from, [(p) => p.fs.perSec, (p) => p.sync.perSec, (p) => p.dns.perSec, (p) => p.sync.msPerSec]));
  charts.ioLatency.setMarkers(markerTimes(insights.flatMap((i) => (i.kind === 'dns-slow' ? [i.t] : [])), MARKER_GAP_MS));
  charts.ioLatency.setData(columns(points, from, [(p) => p99(p.fs), (p) => p99(p.sync), (p) => p99(p.dns)]));

  const recent = from > 0 ? windows.filter((w) => w.end >= from) : windows;
  fillTable(ui.ioFs, ioRows(summarizeIo(recent, 'fs', 15)?.operations ?? []), timing ? 'no file system calls yet' : 'start fs timing to see file system calls');
  fillTable(ui.ioSync, ioRows(summarizeIo(recent, 'fsSync', 15)?.operations ?? []), timing ? 'no *Sync calls: nothing blocked the loop' : 'start fs timing to see blocking calls');
  fillTable(ui.ioDns, ioRows(summarizeIo(recent, 'dns', 15)?.operations ?? []), 'no DNS lookups yet');
}

function renderCpu(timeline: Timeline, frames: readonly Frame[], from: number, latest: Frame | undefined): void {
  charts.cpu.setData(columns(frames, from, [(f) => f.cpu.user, (f) => f.cpu.system, (f) => f.cpu.ofMachine, (f) => f.overhead]));
  const windows = timeline.cpuWindows();
  const last = windows[windows.length - 1];
  const profiling = toggleState('cpu', last !== undefined && latest !== undefined && last.end >= latest.t - 3000);
  ui.cpuToggle.textContent = profiling ? 'Stop CPU profile' : 'Start CPU profile';
  ui.cpuToggle.className = profiling ? 'on' : '';

  const merged = timeline.cpuFlame(FLAME_WINDOWS);
  const agent = timeline.hello?.agentScript ?? '';
  ui.flameWrap.hidden = merged === null;
  ui.baseline.hidden = merged === null && state.baseline === null;
  ui.cpuDownload.hidden = merged === null || state.selected === null;
  if (state.selected !== null) ui.cpuDownload.href = exportUrl({ token, source: state.selected, kind: 'cpu' });
  ui.baseline.textContent = state.baseline === null ? 'Pin as baseline' : 'Clear baseline';
  ui.baseline.className = state.baseline === null ? 'ghost' : 'on';
  if (merged === null) {
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
    baseline === null ? `(last ${FLAME_WINDOWS} windows; click to zoom${inVscode ? ', double-click to open the code' : ''})` : '(now vs pinned baseline: red got heavier, blue got lighter; share of CPU work)';
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

function renderMemory(timeline: Timeline, frames: readonly Frame[], from: number, latest: Frame | undefined): void {
  charts.memory.setData(columns(frames, from, [(f) => f.memory.rss, (f) => f.memory.heapTotal, (f) => f.memory.heapUsed, (f) => f.memory.external, (f) => f.memory.arrayBuffers]));
  // Spaces this V8 build does not use (shared, sandbox ones) stay at 0 B: leave them out.
  const rows = (latest?.heapSpaces ?? []).filter((space) => space.size > 0).map((space) => {
    const row = document.createElement('div');
    row.className = 'space';
    const name = document.createElement('span');
    name.textContent = space.name.replace(/_space$/, '');
    const meter = document.createElement('div');
    meter.className = 'meter';
    const fill = document.createElement('div');
    fill.style.width = `${space.size > 0 ? Math.min(100, (space.used / space.size) * 100) : 0}%`;
    meter.append(fill);
    const amount = document.createElement('span');
    amount.className = 'amount';
    amount.textContent = `${formatBytes(space.used)} / ${formatBytes(space.size)}`;
    row.append(name, meter, amount);
    return row;
  });
  ui.spaces.replaceChildren(...rows);

  const allocations = timeline.allocations();
  const sampling = toggleState('heap', allocations !== null && latest !== undefined && allocations.end >= latest.t - 5000);
  ui.heapToggle.textContent = sampling ? 'Stop allocation sampling' : 'Start allocation sampling';
  ui.heapToggle.className = sampling ? 'on' : '';
  ui.heapDownload.hidden = allocations === null || state.selected === null;
  if (state.selected !== null) ui.heapDownload.href = exportUrl({ token, source: state.selected, kind: 'heap' });
  const tree = allocations === null ? null : withoutScript(allocations, timeline.hello?.agentScript ?? '');
  fillTable(
    ui.allocations,
    tree === null ? [] : hotFunctions(tree, 12).map((fn) => [{ text: formatBytes(fn.self), numeric: true }, { text: fn.name }, whereCell(fn)]),
    'start allocation sampling to see who allocates',
  );
}

function renderGc(timeline: Timeline, frames: readonly Frame[], from: number, latest: Frame | undefined): void {
  charts.gc.setMarkers(markerTimes(timeline.insights().flatMap((i) => (i.kind === 'gc-pressure' ? [i.t] : [])), MARKER_GAP_MS));
  charts.gc.setData(columns(frames, from, [(f) => (f.gc.pause > 0 ? f.gc.pause : null), (f) => (f.gc.byKind.major.pause > 0 ? f.gc.byKind.major.pause : null)]));
  const now = latest?.t ?? 0;
  fillTable(
    ui.gcList,
    timeline
      .gcEvents()
      .slice(-15)
      .reverse()
      .map((e) => [{ text: `−${formatMs(Math.max(0, now - e.start))}` }, { text: e.kind }, { text: formatMs(e.duration), numeric: true }]),
    'no GC yet',
  );
}

function renderSystem(frames: readonly Frame[], from: number, latest: Frame | undefined, entry: SourceEntry): void {
  charts.os.setData(columns(frames, from, [(f) => f.os.majorFaultsPerSec, (f) => f.os.involuntarySwitchesPerSec, (f) => f.os.voluntarySwitchesPerSec]));
  const host = store.host.hostSamples();
  charts.host.setData(
    columns(host, from, [
      (s) => (s.gpus[0]?.utilization === null || s.gpus[0] === undefined ? null : s.gpus[0].utilization * 100),
      (s) => (s.swap === null || s.swap.total === 0 ? null : (s.swap.used / s.swap.total) * 100),
    ]),
  );
  const gpu = host.at(-1)?.gpus[0];
  const facts = [
    `${entry.hello.platform}/${entry.hello.arch}`,
    `Node ${entry.hello.nodeVersion}`,
    `${entry.hello.cpus} CPUs`,
    `RAM ${formatBytes(entry.hello.totalMemory)}`,
    latest ? `limit ${formatBytes(latest.os.memoryLimit)}` : '',
    latest ? `load ${latest.os.loadAvg1.toFixed(2)}` : '',
    latest?.os.systemAvailable != null ? `available ${formatBytes(latest.os.systemAvailable)}` : '',
    gpu ? `GPU ${gpu.name}` : 'no GPU readings',
  ].filter((fact) => fact !== '');
  ui.hostFacts.replaceChildren(
    ...facts.map((fact) => {
      const span = document.createElement('span');
      span.textContent = fact;
      return span;
    }),
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

function render(): void {
  renderedRevision = store.revision;
  renderHeader();
  const entry = current();
  if (entry === undefined) {
    renderTiles([], null);
    return;
  }
  const timeline = entry.timeline;
  const frames = timeline.frames();
  const latest = frames[frames.length - 1];
  const from = state.windowMs > 0 && latest !== undefined ? latest.t - state.windowMs : 0;
  renderTiles(frames, timeline);
  renderFindings(timeline);
  renderLoop(timeline, frames, from);
  renderHttp(timeline, from);
  renderIo(timeline, from, latest);
  renderCpu(timeline, frames, from, latest);
  renderMemory(timeline, frames, from, latest);
  renderGc(timeline, frames, from, latest);
  renderSystem(frames, from, latest, entry);
}

// ---- wiring -------------------------------------------------------------------------------

ui.source.addEventListener('change', () => {
  state.selected = ui.source.value as SourceId;
  state.flamePath = [];
  state.selectedIteration = null;
  state.baseline = null;
  render();
});
ui.window.addEventListener('change', () => {
  state.windowMs = Number(ui.window.value);
  render();
});
ui.span.addEventListener('change', () => {
  state.spanMs = Number(ui.span.value);
  render();
});
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
render();
