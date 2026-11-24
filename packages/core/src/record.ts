// One record format for `--record` files, the dashboard's SSE stream and replay:
// `{"c":<connection>,"m":<message>}` per line. The CLI embeds each agent line verbatim
// (no re-serialisation); connection 0 is the host probe. `{"c":<connection>,"closed":true}`
// says the connection ended, so readers can drop what they keep for it; recordings made
// before it existed simply have none.

import { Fields, parseWith, ProtocolError, type Parsed } from './guard.js';
import { parseStreamMessage, type StreamMessage } from './protocol.js';

export const HOST_CONNECTION = 0;

export interface StreamRecord {
  readonly connection: number;
  readonly message: StreamMessage;
}

/** The connection ended: nothing more comes from it. */
export interface ClosedRecord {
  readonly connection: number;
  readonly closed: true;
}

/** One line of the record format; tell them apart with `'closed' in record`. */
export type RecordEntry = StreamRecord | ClosedRecord;

/** `rawMessage` must be one JSON value without a newline, as an agent line is. */
export function encodeRecord(connection: number, rawMessage: string): string {
  return `{"c":${connection},"m":${rawMessage}}`;
}

export function encodeClosedRecord(connection: number): string {
  return `{"c":${connection},"closed":true}`;
}

/** A message record's connection and message text exactly as the agent sent it. */
export interface RecordPayload {
  readonly connection: number;
  readonly raw: string;
}

/**
 * The connection and the message text exactly as the agent sent it, for feeding a recording back
 * through the wire parser (`parseRecord` gives the normalised message, which does not re-parse);
 * a closed record as it is; `null` for a line that is neither.
 */
export function recordPayload(line: string): RecordPayload | ClosedRecord | null {
  const trimmed = line.trim();
  const closed = /^\{"c":(\d+),"closed":true\}$/.exec(trimmed);
  if (closed?.[1] !== undefined) return { connection: Number(closed[1]), closed: true };
  const match = /^\{"c":(\d+),"m":([\s\S]*)\}$/.exec(trimmed);
  return match?.[1] === undefined || match[2] === undefined ? null : { connection: Number(match[1]), raw: match[2] };
}

export function parseRecord(line: string): Parsed<RecordEntry> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const envelope = parseWith((): { connection: number; message: unknown } | ClosedRecord => {
    const f = Fields.of(value, '$');
    const connection = f.number('c');
    if (!f.has('closed')) return { connection, message: f.read('m', (m) => m) };
    if (!f.boolean('closed')) throw new ProtocolError(f.at('closed'), 'true');
    return { connection, closed: true };
  });
  if (!envelope.ok) return envelope;
  if ('closed' in envelope.value) return { ok: true, value: envelope.value };
  const message = parseStreamMessage(envelope.value.message);
  if (!message.ok) return { ok: false, error: `message: ${message.error}` };
  return { ok: true, value: { connection: envelope.value.connection, message: message.value } };
}
