// What a dashboard that connects mid-run receives first: per connection its hello and a
// bounded tail of everything else, so its own Timeline can catch up without the CLI
// holding the whole run in memory.

import { encodeRecord, Ring, type StreamMessage } from '@node-xray/core';

export interface BacklogLimits {
  /** Samples per connection: 3600 is an hour at 1 s, 15 min at 250 ms. */
  readonly samples: number;
  /** Loop trace batches per connection (up to `maxEventsPerFlush` events each). */
  readonly traces: number;
  readonly cpuProfiles: number;
  readonly errors: number;
  readonly host: number;
}

export const DEFAULT_BACKLOG_LIMITS: BacklogLimits = { samples: 3600, traces: 80, cpuProfiles: 12, errors: 50, host: 1800 };

interface ConnectionBacklog {
  hello: string | null;
  readonly samples: Ring<string>;
  /** HTTP ticks, as many as samples. */
  readonly http: Ring<string>;
  /** File system and DNS ticks, as many as samples. */
  readonly io: Ring<string>;
  readonly traces: Ring<string>;
  readonly cpuProfiles: Ring<string>;
  heapProfile: string | null;
  readonly errors: Ring<string>;
}

export class Backlog {
  readonly #connections = new Map<number, ConnectionBacklog>();
  readonly #host: Ring<string>;
  readonly #limits: BacklogLimits;

  constructor(overrides: Partial<BacklogLimits> = {}) {
    this.#limits = { ...DEFAULT_BACKLOG_LIMITS, ...overrides };
    this.#host = new Ring(this.#limits.host);
  }

  add(connection: number, raw: string, message: StreamMessage): void {
    const record = encodeRecord(connection, raw);
    if (message.type === 'host') {
      this.#host.push(record);
      return;
    }
    const entry = this.#entry(connection);
    switch (message.type) {
      case 'hello':
        // A new hello restarts the source's counters: older samples no longer apply.
        entry.hello = record;
        entry.samples.clear();
        entry.http.clear();
        entry.io.clear();
        entry.traces.clear();
        break;
      case 'sample':
        entry.samples.push(record);
        break;
      case 'loop-trace':
        entry.traces.push(record);
        break;
      case 'http':
        entry.http.push(record);
        break;
      case 'io':
        entry.io.push(record);
        break;
      case 'cpu-profile':
        entry.cpuProfiles.push(record);
        break;
      case 'heap-profile':
        entry.heapProfile = record;
        break;
      case 'agent-error':
        entry.errors.push(record);
        break;
      default: {
        const unreachable: never = message;
        throw new Error(`unhandled ${JSON.stringify(unreachable)}`);
      }
    }
  }

  /** Records to replay, each connection's hello before the rest of it. */
  records(): string[] {
    const out = this.#host.toArray();
    for (const entry of this.#connections.values()) {
      if (entry.hello === null) continue;
      out.push(entry.hello, ...entry.samples.toArray(), ...entry.http.toArray(), ...entry.io.toArray(), ...entry.traces.toArray(), ...entry.cpuProfiles.toArray(), ...entry.errors.toArray());
      if (entry.heapProfile !== null) out.push(entry.heapProfile);
    }
    return out;
  }

  #entry(connection: number): ConnectionBacklog {
    let entry = this.#connections.get(connection);
    if (entry === undefined) {
      entry = {
        hello: null,
        samples: new Ring(this.#limits.samples),
        http: new Ring(this.#limits.samples),
        io: new Ring(this.#limits.samples),
        traces: new Ring(this.#limits.traces),
        cpuProfiles: new Ring(this.#limits.cpuProfiles),
        heapProfile: null,
        errors: new Ring(this.#limits.errors),
      };
      this.#connections.set(connection, entry);
    }
    return entry;
  }
}
