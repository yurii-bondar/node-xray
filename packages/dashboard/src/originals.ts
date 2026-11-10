// Source-mapped locations for the frames on screen, asked from the CLI in batches and kept.
// No DOM here: the fetch is injected.

import { positionKey, type Original, type SourcePosition } from '@node-xray/core';

/** At most this many positions per request (the CLI accepts 500). */
const BATCH = 200;

export type FetchOriginals = (positions: readonly SourcePosition[]) => Promise<unknown>;

/** `{ originals: { [positionKey]: { file, line, column, name } } }` → map; unknown shapes are dropped. */
export function parseOriginals(value: unknown): Map<string, Original> {
  const out = new Map<string, Original>();
  const originals: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, 'originals') : undefined;
  if (typeof originals !== 'object' || originals === null) return out;
  for (const [key, entry] of Object.entries(originals)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const file: unknown = Reflect.get(entry, 'file');
    const line: unknown = Reflect.get(entry, 'line');
    const column: unknown = Reflect.get(entry, 'column');
    const name: unknown = Reflect.get(entry, 'name');
    if (typeof file !== 'string' || typeof line !== 'number' || typeof column !== 'number') continue;
    out.set(key, { file, line, column, name: typeof name === 'string' ? name : null });
  }
  return out;
}

export class OriginalsCache {
  /** null: asked, nothing maps there. */
  readonly #known = new Map<string, Original | null>();
  readonly #queued = new Map<string, SourcePosition>();
  #flushing = false;

  constructor(
    private readonly fetchOriginals: FetchOriginals,
    /** Called when new answers arrived, so the views can redraw. */
    private readonly onUpdate: () => void,
  ) {}

  /** The original position, or null when there is none (yet). Unknown positions get queued. */
  get(position: SourcePosition): Original | null {
    if (position.url === '' || position.line <= 0 || position.url.startsWith('node:')) return null;
    const key = positionKey(position);
    const known = this.#known.get(key);
    if (known !== undefined) return known;
    if (!this.#queued.has(key)) {
      this.#queued.set(key, { url: position.url, line: position.line, column: position.column });
      queueMicrotask(() => void this.#flush());
    }
    return null;
  }

  async #flush(): Promise<void> {
    if (this.#flushing || this.#queued.size === 0) return;
    this.#flushing = true;
    try {
      while (this.#queued.size > 0) {
        const batch = [...this.#queued.entries()].slice(0, BATCH);
        for (const [key] of batch) this.#queued.delete(key);
        let answers = new Map<string, Original>();
        try {
          answers = parseOriginals(await this.fetchOriginals(batch.map(([, position]) => position)));
        } catch {
          // The CLI is gone or refused: treat these as unmapped instead of asking on every render.
          for (const [key] of batch) this.#known.set(key, null);
          continue;
        }
        let changed = false;
        for (const [key] of batch) {
          const original = answers.get(key) ?? null;
          this.#known.set(key, original);
          if (original !== null) changed = true;
        }
        if (changed) this.onUpdate();
      }
    } finally {
      this.#flushing = false;
    }
  }
}
