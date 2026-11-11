// Small DOM helpers. Text from the target process (function names, paths) only ever goes
// through textContent, never innerHTML.

import type { FlameFrame } from '@node-xray/core';

export function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`#${id} is missing or not a ${type.name}`);
  return element;
}

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888888';
}

/** `#rrggbb` + alpha → `#rrggbbaa`; other formats unchanged. */
export function withAlpha(color: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  return `${color}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
}

export interface Cell {
  readonly text: string;
  readonly numeric?: boolean;
  readonly title?: string;
  readonly className?: string;
  /** Makes the cell a link (open in editor). */
  readonly action?: () => void;
}

/** Replaces the table body; `empty` is shown as one row when there are no rows. */
export function fillTable(table: HTMLTableElement, rows: ReadonlyArray<ReadonlyArray<Cell>>, empty: string): void {
  const body = table.tBodies[0] ?? table.createTBody();
  const fragment = document.createDocumentFragment();
  if (rows.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = table.tHead?.rows[0]?.cells.length ?? 1;
    td.className = 'muted';
    td.textContent = empty;
    tr.append(td);
    fragment.append(tr);
  }
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement('td');
      td.textContent = cell.text;
      td.className = [cell.numeric ? 'num' : '', cell.className ?? ''].filter((c) => c !== '').join(' ');
      if (cell.title !== undefined) td.title = cell.title;
      const action = cell.action;
      if (action !== undefined) {
        td.classList.add('link');
        td.addEventListener('click', action);
      }
      tr.append(td);
    }
    fragment.append(tr);
  }
  body.replaceChildren(fragment);
}

/** `file:///srv/app/src/x.js` → `src/x.js:42` (last two segments): enough to recognise in a table. */
export function shortLocation(frame: FlameFrame): string {
  if (frame.url === '') return '';
  let file = frame.url;
  if (file.startsWith('file://')) {
    try {
      file = decodeURIComponent(new URL(file).pathname);
    } catch {
      // keep the URL as is
    }
  }
  const parts = file.split(/[\\/]/).filter((part) => part !== '');
  const short = parts.length > 2 ? parts.slice(-2).join('/') : file;
  return frame.line > 0 ? `${short}:${frame.line}` : short;
}

/** Canvas sized to its CSS box at device pixel ratio; returns the 2D context in CSS pixels. */
export function fitCanvas(canvas: HTMLCanvasElement, cssHeight?: number): CanvasRenderingContext2D {
  if (cssHeight !== undefined) canvas.style.height = `${cssHeight}px`;
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2D canvas is not available');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return ctx;
}

/** Positions a tooltip inside its relatively positioned parent, flipping at the edges. */
export function showTip(tip: HTMLElement, text: string, x: number, y: number): void {
  tip.textContent = text;
  tip.hidden = false;
  const parent = tip.parentElement;
  const maxX = (parent?.clientWidth ?? 0) - tip.offsetWidth - 4;
  tip.style.left = `${Math.max(4, Math.min(x + 12, maxX))}px`;
  tip.style.top = `${y + 14}px`;
}

/** An element with a class and text (textContent: safe for names from the target). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className !== '') element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const SVG = 'http://www.w3.org/2000/svg';
const SPARK_WIDTH = 120;
const SPARK_HEIGHT = 24;

/** A sparkline drawn in `colorVar`, stretched to its box; the path data comes from `sparkPath`. */
export function sparkline(d: string, colorVar: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('viewBox', `0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.color = `var(${colorVar})`;
  const area = document.createElementNS(SVG, 'path');
  area.setAttribute('class', 'spark-area');
  area.setAttribute('d', d === '' ? '' : `${d} L${SPARK_WIDTH} ${SPARK_HEIGHT} L0 ${SPARK_HEIGHT} Z`);
  const line = document.createElementNS(SVG, 'path');
  line.setAttribute('class', 'spark-line');
  line.setAttribute('d', d);
  svg.append(area, line);
  return svg;
}

export const SPARK_BOX = { width: SPARK_WIDTH, height: SPARK_HEIGHT } as const;

/** A group of `button[data-value]`: one is pressed; a click reports the value. */
export function segmented(group: HTMLElement, onPick: (value: string) => void): void {
  group.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) return;
    const value = target.dataset['value'];
    if (value === undefined) return;
    pressSegment(group, value);
    onPick(value);
  });
}

export function pressSegment(group: HTMLElement, value: string): void {
  for (const button of group.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset['value'] === value));
}
