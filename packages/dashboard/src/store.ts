// Everything the page knows, fed by the SSE stream: one Timeline per agent connection,
// the host probe, and the status of the launched command. No DOM here.

import { HOST_CONNECTION, parseRecord, Timeline, toSourceId, type Hello, type SourceId, type StreamRecord } from '@node-xray/core';

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
  readonly sources = new Map<SourceId, SourceEntry>();
  host = new Timeline();
  status: RunStatus | null = null;
  /** Bad records seen; shown, not thrown. */
  rejected = 0;
  /** Bumped on every change, so views can skip work when nothing moved. */
  revision = 0;

  reset(): void {
    this.#byConnection.clear();
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

  apply({ connection, message }: StreamRecord): void {
    this.revision++;
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
      this.sources.set(id, { id, hello: message, timeline });
    }
  }

  /** The main thread of the first process, else whatever is there. */
  defaultSource(): SourceEntry | undefined {
    let first: SourceEntry | undefined;
    for (const source of this.sources.values()) {
      if (source.hello.threadId === 0) return source;
      first ??= source;
    }
    return first;
  }
}
