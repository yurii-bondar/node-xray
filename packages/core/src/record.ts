// One record format for `--record` files, the dashboard's SSE stream and replay:
// `{"c":<connection>,"m":<message>}` per line. The CLI embeds each agent line verbatim
// (no re-serialisation); connection 0 is the host probe.

import { Fields, parseWith, type Parsed } from './guard.js';
import { parseStreamMessage, type StreamMessage } from './protocol.js';

export const HOST_CONNECTION = 0;

export interface StreamRecord {
  readonly connection: number;
  readonly message: StreamMessage;
}

/** `rawMessage` must be one JSON value without a newline, as an agent line is. */
export function encodeRecord(connection: number, rawMessage: string): string {
  return `{"c":${connection},"m":${rawMessage}}`;
}

/**
 * The connection and the message text exactly as the agent sent it, for feeding a recording back
 * through the wire parser (`parseRecord` gives the normalised message, which does not re-parse).
 */
export function recordPayload(line: string): { readonly connection: number; readonly raw: string } | null {
  const match = /^\{"c":(\d+),"m":([\s\S]*)\}$/.exec(line.trim());
  return match?.[1] === undefined || match[2] === undefined ? null : { connection: Number(match[1]), raw: match[2] };
}

export function parseRecord(line: string): Parsed<StreamRecord> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const envelope = parseWith(() => {
    const f = Fields.of(value, '$');
    return { connection: f.number('c'), message: f.read('m', (m) => m) };
  });
  if (!envelope.ok) return envelope;
  const message = parseStreamMessage(envelope.value.message);
  if (!message.ok) return { ok: false, error: `message: ${message.error}` };
  return { ok: true, value: { connection: envelope.value.connection, message: message.value } };
}
