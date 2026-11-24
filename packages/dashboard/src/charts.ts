// Live time-series charts on uPlot. One shared cursor across all charts (sync key). A drag
// zooms the charts into a time range (uPlot syncs it), which stays while new data arrives; a
// double-click on any chart sends them all back to following the data.

import uPlot from 'uplot';
import { cssVar, withAlpha } from './dom.js';
import type { Column } from './series.js';

export interface SeriesSpec {
  readonly label: string;
  /** CSS custom property, e.g. `--s1`. */
  readonly color: string;
  readonly format: (value: number) => string;
  /** Right-hand axis. */
  readonly right?: boolean;
  readonly bars?: boolean;
  readonly fill?: boolean;
}

export interface ChartSpec {
  readonly title: string;
  readonly series: readonly SeriesSpec[];
  readonly left: (value: number) => string;
  readonly right?: (value: number) => string;
  readonly height?: number;
}

export type ChartData = [number[], ...Column[]];

const fromZero: uPlot.Range.Function = (_u, _min, max) => [0, max > 0 ? max * 1.08 : 1];

interface XRange {
  readonly min: number;
  readonly max: number;
}

/** Every chart: uPlot syncs a zoom to all of them, so a reset goes to all of them too. */
const charts = new Set<TimeChart>();

export class TimeChart {
  #plot: uPlot | null = null;
  #data: ChartData;
  /** Epoch ms of findings, drawn as dashed lines across the plot. */
  #markers: readonly number[] = [];
  #markerColor = '';
  /** The time range the user zoomed into (seconds); null = follow the data. */
  #zoom: XRange | null = null;
  readonly #observer: ResizeObserver;

  constructor(
    private readonly host: HTMLElement,
    private readonly spec: ChartSpec,
  ) {
    this.#data = [[], ...spec.series.map((): Column => [])];
    this.#build();
    this.#observer = new ResizeObserver(() => this.#plot?.setSize({ width: this.#width(), height: this.spec.height ?? 170 }));
    charts.add(this);
    this.#observer.observe(host);
  }

  /** Every chart back to following the data: after a double-click, or when the page or the window changes. */
  static resetZooms(): void {
    for (const chart of charts) chart.#follow();
  }

  /** Takes effect on the next draw (`setData` redraws). */
  setMarkers(times: readonly number[]): void {
    this.#markers = times;
  }

  setData(data: ChartData): void {
    this.#data = data;
    const plot = this.#plot;
    const zoom = this.#zoom;
    if (plot === null) return;
    if (zoom === null) {
      plot.setData(data as uPlot.AlignedData);
      return;
    }
    // Keep the user's range: setData would reset the scales to the whole data.
    plot.setData(data as uPlot.AlignedData, false);
    plot.setScale('x', { ...zoom });
  }

  #follow(): void {
    if (this.#zoom === null) return;
    this.#zoom = null;
    this.setData(this.#data);
  }

  /** After a theme change: colours are read when the chart is built. */
  rebuild(): void {
    this.#plot?.destroy();
    this.#build();
  }

  /** A finished drag (here, or synced from another chart): remember the range it zoomed into. */
  #onSelect(u: uPlot): void {
    const { left, width } = u.select;
    if (width <= 0) return;
    this.#zoom = { min: u.posToVal(left, 'x'), max: u.posToVal(left + width, 'x') };
  }

  #width(): number {
    return Math.max(200, this.host.clientWidth);
  }

  #drawMarkers(u: uPlot): void {
    if (this.#markers.length === 0) return;
    const ctx = u.ctx;
    const { left, top, width, height } = u.bbox;
    ctx.save();
    ctx.strokeStyle = this.#markerColor;
    ctx.lineWidth = Math.max(1, devicePixelRatio);
    ctx.setLineDash([4 * devicePixelRatio, 3 * devicePixelRatio]);
    ctx.beginPath();
    for (const t of this.#markers) {
      const x = u.valToPos(t / 1000, 'x', true);
      if (x < left || x > left + width) continue;
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + height);
    }
    ctx.stroke();
    ctx.restore();
  }

  #build(): void {
    const muted = cssVar('--muted');
    this.#markerColor = cssVar('--warn');
    const grid = cssVar('--grid');
    const axis = (values: (value: number) => string, side: 1 | 3, show = true): uPlot.Axis => ({
      scale: side === 1 ? 'right' : 'y',
      side,
      stroke: muted,
      size: 64,
      grid: { show, stroke: grid, width: 1 },
      ticks: { show: false },
      values: (_u, splits) => splits.map((v) => values(v)),
    });
    const axes: uPlot.Axis[] = [{ stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { show: false } }, axis(this.spec.left, 3)];
    if (this.spec.right) axes.push(axis(this.spec.right, 1, false));

    const bars = uPlot.paths.bars?.({ size: [0.7, 14] });
    const series: uPlot.Series[] = [
      {},
      ...this.spec.series.map((s): uPlot.Series => {
        const color = cssVar(s.color);
        return {
          label: s.label,
          stroke: color,
          width: 1.5,
          scale: s.right ? 'right' : 'y',
          points: { show: false },
          value: (_u, v) => (v === null || v === undefined ? '—' : s.format(v)),
          ...(s.fill ? { fill: withAlpha(color, 0.12) } : {}),
          ...(s.bars && bars ? { paths: bars, fill: withAlpha(color, 0.6) } : {}),
        };
      }),
    ];

    this.#plot = new uPlot(
      {
        title: this.spec.title,
        width: this.#width(),
        height: this.spec.height ?? 170,
        cursor: { sync: { key: 'xray' }, drag: { x: true, y: false } },
        scales: { x: { time: true }, y: { range: fromZero }, right: { range: fromZero } },
        axes,
        series,
        legend: { live: true },
        hooks: { draw: [(u) => this.#drawMarkers(u)], setSelect: [(u) => this.#onSelect(u)] },
      },
      this.#data as uPlot.AlignedData,
      this.host,
    );
    this.#plot.over.addEventListener('dblclick', () => TimeChart.resetZooms());
    // Rebuilt for a theme change while zoomed: keep the range.
    if (this.#zoom !== null) this.setData(this.#data);
  }
}
