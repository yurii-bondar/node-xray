// Everything the page knows, fed by the SSE stream: one Timeline per agent connection,
// the host probe, the status of the launched command and of the stream itself. No DOM here.

import { HOST_CONNECTION, parseRecord, Timeline, toSourceId, type Hello, type RecordEntry, type SourceId } from '@node-xray/core';

export type RunStatus =
  | { readonly state: 'running'; readonly command: string }
  | { readonly state: 'exited'; readonly command: string; readonly code: number }
  | { readonly state: 'detached'; readonly command: string }
  | { readonly state: 'replay'; readonly command: string };

export function parseStatus(text: string): RunStatus | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const state: unknown = Reflect.get(value, 'state');
  const command: unknown = Reflect.get(value, 'command');
  const code: unknown = Reflect.get(value, 'code');
  if (typeof command !== 'string') return null;
  if (state === 'running' || state === 'detached' || state === 'replay') return { state, command };
  if (state === 'exited' && typeof code === 'number') return { state, command, code };
  return null;
}

export interface SourceEntry {
  readonly id: SourceId;
  readonly hello: Hello;
  readonly timeline: Timeline;
  /** Its agent connection closed: the data stays for reading, commands cannot reach it. */
  readonly ended: boolean;
}

/** Ended sources kept for reading; older ones are dropped (live ones are always kept). */
export const MAX_ENDED_SOURCES = 16;

/** The SSE stream to the CLI: `lost` until the browser reconnects (the CLI may be gone). */
export type Connection = 'connecting' | 'open' | 'lost';

export type Tone = 'neutral' | 'live' | 'done';

export interface HeaderState {
  readonly text: string;
  readonly tone: Tone;
  /** Commands can reach an agent. */
  readonly live: boolean;
}

/** What the header says about the run, and whether commands make sense. */
export function headerState(status: RunStatus | null, connection: Connection): HeaderState {
  if (connection === 'lost' && status?.state !== 'replay') {
    return { text: status === null ? 'reconnecting…' : `reconnecting… · ${status.command}`, tone: 'done', live: false };
  }
  if (status === null) return { text: 'connecting…', tone: 'neutral', live: connection !== 'lost' };
  switch (status.state) {
    case 'running':
      return { text: `live · ${status.command}`, tone: 'live', live: true };
    case 'detached':
      return { text: `detached · ${status.command}`, tone: 'done', live: false };
    case 'replay':
      return { text: status.command, tone: 'done', live: false };
    case 'exited':
      return { text: `exited ${status.code} · ${status.command}`, tone: 'done', live: false };
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

/** `node server.js`: the script without its directory. */
export function commandLabel(hello: Hello): string {
  const script = hello.argv[1];
  return script === undefined ? 'node' : `node ${script.split(/[\\/]/).pop() ?? script}`;
}

/** `pid 4242 · node server.js` (`· worker 1` for threads). */
export function sourceLabel(hello: Hello): string {
  return `pid ${hello.pid}${hello.threadId === 0 ? '' : ` · worker ${hello.threadId}`} · ${commandLabel(hello)}`;
}

export class Store {
  readonly #byConnection = new Map<number, Timeline>();
  /** Ended sources, oldest first. */
  readonly #ended: SourceId[] = [];
  readonly sources = new Map<SourceId, SourceEntry>();
  host = new Timeline();
  status: RunStatus | null = null;
  connection: Connection = 'connecting';
  /** Bad records seen; shown, not thrown. */
  rejected = 0;
  /** Bumped on every change, so views can skip work when nothing moved. */
  revision = 0;

  reset(): void {
    this.#byConnection.clear();
    this.#ended.length = 0;
    this.sources.clear();
    this.host = new Timeline();
    this.rejected = 0;
    this.revision++;
  }

  applyLine(line: string): void {
    const parsed = parseRecord(line);
    if (parsed.ok) this.apply(parsed.value);
    else this.rejected++;
  }

  setConnection(connection: Connection): void {
    if (this.connection === connection) return;
    this.connection = connection;
    this.revision++;
  }

  apply(record: RecordEntry): void {
    this.revision++;
    if ('closed' in record) {
      this.#close(record.connection);
      return;
    }
    const { connection, message } = record;
    if (connection === HOST_CONNECTION) {
      this.host.apply(message);
      return;
    }
    let timeline = this.#byConnection.get(connection);
    if (timeline === undefined) {
      timeline = new Timeline();
      this.#byConnection.set(connection, timeline);
    }
    timeline.apply(message);
    if (message.type === 'hello') {
      const id = toSourceId(message.pid, message.threadId);
      this.sources.set(id, { id, hello: message, timeline, ended: false });
      const at = this.#ended.indexOf(id);
      if (at !== -1) this.#ended.splice(at, 1);
    }
  }

  #close(connection: number): void {
    const timeline = this.#byConnection.get(connection);
    if (timeline === undefined) return;
    this.#byConnection.delete(connection);
    for (const entry of this.sources.values()) {
      if (entry.timeline !== timeline || entry.ended) continue;
      this.sources.set(entry.id, { ...entry, ended: true });
      this.#ended.push(entry.id);
    }
    while (this.#ended.length > MAX_ENDED_SOURCES) {
      const oldest = this.#ended.shift();
      if (oldest !== undefined) this.sources.delete(oldest);
    }
  }

  /** The main thread of the first live process, else any live source, else the newest ended one. */
  defaultSource(): SourceEntry | undefined {
    let live: SourceEntry | undefined;
    for (const source of this.sources.values()) {
      if (source.ended) continue;
      if (source.hello.threadId === 0) return source;
      live ??= source;
    }
    const newest = this.#ended[this.#ended.length - 1];
    return live ?? (newest === undefined ? undefined : this.sources.get(newest));
  }
}
