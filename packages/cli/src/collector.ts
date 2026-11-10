// Socket server the agents connect to: one Timeline per source (process thread), and a
// stream of raw records for whoever listens (`--record`, the dashboard).

import net from 'node:net';
import {
  decodeStreamMessage,
  encodeLine,
  HOST_CONNECTION,
  LineDecoder,
  LineTooLongError,
  Timeline,
  toSourceId,
  type AgentCommand,
  type HostSample,
  type SourceId,
  type StreamMessage,
} from '@node-xray/core';

export interface Source {
  readonly id: SourceId;
  readonly connection: number;
  readonly timeline: Timeline;
  send(command: AgentCommand): void;
}

/** `raw` is the message exactly as received, for verbatim re-embedding (`encodeRecord`). */
export type RecordListener = (connection: number, raw: string, message: StreamMessage) => void;

/** The collector's side of one agent transport. */
export interface AgentLink {
  send(command: AgentCommand): void;
  close(): void;
}

export interface OpenLink {
  /** One message line from the agent. */
  line(line: string): void;
  /** A transport problem worth showing with the source's errors. */
  problem(message: string): void;
  closed(): void;
}

export interface CollectorOptions {
  /** Sent to every source right after its hello (`--cpu`, `--trace-loop`, ...). */
  readonly startupCommands: readonly AgentCommand[];
}

export class Collector {
  readonly sources = new Map<SourceId, Source>();
  /** Host probe samples (swap, GPU) live in their own timeline. */
  readonly host = new Timeline();
  readonly #server: net.Server;
  readonly #links = new Set<AgentLink>();
  readonly #listeners = new Set<RecordListener>();
  #nextConnection = HOST_CONNECTION + 1;
  #idle: Array<() => void> = [];

  constructor(private readonly options: CollectorOptions) {
    this.#server = net.createServer((socket) => this.#accept(socket));
  }

  listen(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(path, () => {
        this.#server.off('error', reject);
        resolve();
      });
    });
  }

  /** Returns the unsubscribe function. */
  onRecord(listener: RecordListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  applyHost(sample: HostSample): void {
    this.host.apply(sample);
    this.#emit(HOST_CONNECTION, JSON.stringify(sample), sample);
  }

  /** Sends to one source, or to all of them when `target` is null. Returns how many got it. */
  send(target: SourceId | null, command: AgentCommand): number {
    if (target !== null) {
      const source = this.sources.get(target);
      source?.send(command);
      return source ? 1 : 0;
    }
    for (const source of this.sources.values()) source.send(command);
    return this.sources.size;
  }

  /** Target pids seen so far. */
  pids(): Set<number> {
    const out = new Set<number>();
    for (const source of this.sources.values()) if (source.timeline.hello) out.add(source.timeline.hello.pid);
    return out;
  }

  /** Resolves when every agent has disconnected, or after `timeoutMs`. */
  whenDisconnected(timeoutMs: number): Promise<void> {
    if (this.#links.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.#idle.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    for (const link of this.#links) link.close();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  #emit(connection: number, raw: string, message: StreamMessage): void {
    for (const listener of this.#listeners) listener(connection, raw, message);
  }

  /**
   * Registers one agent transport (a socket, or a CDP session for `attach`). The returned
   * handlers take each message line as it arrives and the end of the transport.
   */
  open(link: AgentLink): OpenLink {
    const connection = this.#nextConnection++;
    const timeline = new Timeline();
    this.#links.add(link);
    const send = (command: AgentCommand): void => link.send(command);
    return {
      line: (line) => {
        const parsed = decodeStreamMessage(line);
        if (!parsed.ok) {
          timeline.apply({ type: 'agent-error', message: `protocol: ${parsed.error}` });
          return;
        }
        timeline.apply(parsed.value);
        this.#emit(connection, line, parsed.value);
        if (parsed.value.type === 'hello') {
          const id = toSourceId(parsed.value.pid, parsed.value.threadId);
          this.sources.set(id, { id, connection, timeline, send });
          for (const command of this.options.startupCommands) send(command);
        }
      },
      problem: (message) => timeline.apply({ type: 'agent-error', message }),
      closed: () => {
        this.#links.delete(link);
        if (this.#links.size === 0) {
          const waiting = this.#idle;
          this.#idle = [];
          for (const resolve of waiting) resolve();
        }
      },
    };
  }

  #accept(socket: net.Socket): void {
    const decoder = new LineDecoder();
    socket.setEncoding('utf8');
    const handlers = this.open({
      send: (command) => {
        if (!socket.destroyed) socket.write(encodeLine(command));
      },
      close: () => socket.destroy(),
    });
    socket.on('data', (chunk: string) => {
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch (error) {
        if (!(error instanceof LineTooLongError)) throw error;
        handlers.problem(`protocol: ${error.message}; connection dropped`);
        socket.destroy();
        return;
      }
      for (const line of lines) handlers.line(line);
    });
    socket.on('error', () => undefined);
    socket.on('close', () => handlers.closed());
  }
}
