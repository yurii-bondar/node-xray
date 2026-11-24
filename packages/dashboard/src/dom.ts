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
  /** Makes the cell's text a button (open in editor, unfold, switch thread). */
  readonly action?: () => void;
}

/** A full-width row under a data row (call stacks of a function). */
export interface DetailRow {
  /** Index of the data row it follows. */
  readonly after: number;
  /** The row is rebuilt only when this changes. */
  readonly key: string;
  readonly build: () => Node;
  /** Brings a kept row's text up to date (shares that move while the structure stays). */
  readonly update?: (cell: HTMLTableCellElement) => void;
}

export interface TableContent {
  readonly rows: ReadonlyArray<ReadonlyArray<Cell>>;
  /** Shown as one row when there are no rows. */
  readonly empty: string;
  readonly details?: readonly DetailRow[];
}

/** Sets text only when it differs: rewriting the same text would drop a selection in it. */
export function setText(node: Node, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/** A button that looks like a link: keyboard-reachable, unlike a click handler on a cell. */
export function linkButton(text: string, title: string): HTMLButtonElement {
  const button = el('button', 'link', text);
  button.type = 'button';
  if (title !== '') button.title = title;
  return button;
}

function className(cell: Cell): string {
  return [cell.numeric ? 'num' : '', cell.className ?? ''].filter((c) => c !== '').join(' ');
}

function updateCell(td: HTMLTableCellElement, cell: Cell): void {
  const wanted = className(cell);
  if (td.className !== wanted) td.className = wanted;
  const action = cell.action;
  if (action === undefined) {
    if (td.firstElementChild !== null) td.replaceChildren();
    setText(td, cell.text);
    if (td.title !== (cell.title ?? '')) td.title = cell.title ?? '';
    return;
  }
  const first = td.firstElementChild;
  let button: HTMLButtonElement;
  if (first instanceof HTMLButtonElement && td.childNodes.length === 1) button = first;
  else {
    button = linkButton(cell.text, '');
    td.replaceChildren(button);
  }
  setText(button, cell.text);
  if (button.title !== (cell.title ?? '')) button.title = cell.title ?? '';
  if (td.title !== '') td.title = '';
  button.onclick = action;
}

function dataRow(current: HTMLTableRowElement | undefined, cells: ReadonlyArray<Cell>): HTMLTableRowElement {
  let tr = current;
  if (tr === undefined || tr.dataset['kind'] !== 'data' || tr.cells.length !== cells.length) {
    tr = document.createElement('tr');
    tr.dataset['kind'] = 'data';
    for (let i = 0; i < cells.length; i++) tr.append(document.createElement('td'));
  }
  cells.forEach((cell, i) => {
    const td = tr.cells[i];
    if (td !== undefined) updateCell(td, cell);
  });
  return tr;
}

interface WideRow {
  readonly key: string;
  readonly rowClass: string;
  readonly cellClass: string;
  readonly build: () => Node;
  readonly update: ((cell: HTMLTableCellElement) => void) | null;
}

function wideRow(current: HTMLTableRowElement | undefined, slot: WideRow, span: number): HTMLTableRowElement {
  if (current !== undefined && current.dataset['kind'] === 'wide' && current.dataset['key'] === slot.key) {
    const cell = current.cells[0];
    if (cell !== undefined) slot.update?.(cell);
    return current;
  }
  const tr = el('tr', slot.rowClass);
  tr.dataset['kind'] = 'wide';
  tr.dataset['key'] = slot.key;
  const td = el('td', slot.cellClass);
  td.colSpan = span;
  td.append(slot.build());
  tr.append(td);
  return tr;
}

/**
 * Brings the table body to `rows` in place: cells that did not change keep their nodes, so
 * keyboard focus, text selection and hover survive the live updates.
 */
export function fillTable(table: HTMLTableElement, { rows, empty, details = [] }: TableContent): void {
  const body = table.tBodies[0] ?? table.createTBody();
  const span = table.tHead?.rows[0]?.cells.length ?? 1;
  const slots: Array<{ readonly cells: ReadonlyArray<Cell> } | WideRow> = [];
  if (rows.length === 0) slots.push({ key: `empty\u0000${empty}`, rowClass: '', cellClass: 'muted', build: () => document.createTextNode(empty), update: null });
  rows.forEach((cells, i) => {
    slots.push({ cells });
    for (const detail of details) if (detail.after === i) slots.push({ key: detail.key, rowClass: 'stacks', cellClass: '', build: detail.build, update: detail.update ?? null });
  });
  const existing = [...body.rows];
  slots.forEach((slot, i) => {
    const current = existing[i];
    const next = 'cells' in slot ? dataRow(current, slot.cells) : wideRow(current, slot, span);
    if (next === current) return;
    if (current === undefined) body.append(next);
    else current.replaceWith(next);
  });
  for (let i = slots.length; i < existing.length; i++) existing[i]?.remove();
}

/** Replaces the children only when `signature` (what they show) changed since the last time. */
export function replaceIfChanged(container: HTMLElement, signature: string, build: () => readonly Node[]): void {
  if (container.dataset['sig'] === signature) return;
  container.dataset['sig'] = signature;
  container.replaceChildren(...build());
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

/** An empty sparkline; `updateSparkline` draws it. */
export function sparkline(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('viewBox', `0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const area = document.createElementNS(SVG, 'path');
  area.setAttribute('class', 'spark-area');
  const line = document.createElementNS(SVG, 'path');
  line.setAttribute('class', 'spark-line');
  svg.append(area, line);
  return svg;
}

/** Draws `d` (from `sparkPath`) in `colorVar`, stretched to the box; touches only what changed. */
export function updateSparkline(svg: SVGSVGElement, d: string, colorVar: string): void {
  const color = `var(${colorVar})`;
  if (svg.style.color !== color) svg.style.color = color;
  const [area, line] = svg.children;
  const fill = d === '' ? '' : `${d} L${SPARK_WIDTH} ${SPARK_HEIGHT} L0 ${SPARK_HEIGHT} Z`;
  if (area !== undefined && area.getAttribute('d') !== fill) area.setAttribute('d', fill);
  if (line !== undefined && line.getAttribute('d') !== d) line.setAttribute('d', d);
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
