// The CLI's dashboard API: an SSE stream of records, and commands to agents.

import type { AgentCommand, SourceId, SourcePosition } from '@node-xray/core';

export interface StreamHandlers {
  /** The server is about to replay its backlog: drop local state. */
  readonly onReset: () => void;
  readonly onRecord: (line: string) => void;
  readonly onStatus: (json: string) => void;
  readonly onConnection: (open: boolean) => void;
}

function dataOf(event: Event): string | null {
  return event instanceof MessageEvent && typeof event.data === 'string' ? event.data : null;
}

/** Returns the disconnect function. EventSource reconnects by itself. */
export function connectStream(token: string, handlers: StreamHandlers): () => void {
  const source = new EventSource(`api/stream?token=${encodeURIComponent(token)}`);
  source.addEventListener('message', (event) => {
    const data = dataOf(event);
    if (data !== null) handlers.onRecord(data);
  });
  source.addEventListener('reset', () => handlers.onReset());
  source.addEventListener('status', (event) => {
    const data = dataOf(event);
    if (data !== null) handlers.onStatus(data);
  });
  source.addEventListener('open', () => handlers.onConnection(true));
  source.addEventListener('error', () => handlers.onConnection(false));
  return () => source.close();
}

/** Asks the CLI where compiled positions came from (source maps); the answer is narrowed by the caller. */
export async function resolvePositions(token: string, positions: readonly SourcePosition[]): Promise<unknown> {
  const response = await fetch(`api/resolve?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ positions }),
  });
  if (!response.ok) throw new Error(`resolve: HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

export interface ExportLink {
  readonly token: string;
  readonly source: SourceId;
  readonly kind: 'cpu' | 'heap';
}

/** Link to a profile file of one source, whole run. */
export function exportUrl({ token, source, kind }: ExportLink): string {
  return `api/export?token=${encodeURIComponent(token)}&source=${encodeURIComponent(source)}&kind=${kind}`;
}

/** True when at least one agent got the command. */
export async function sendCommand(token: string, target: SourceId | null, command: AgentCommand): Promise<boolean> {
  try {
    const response = await fetch(`api/command?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target, command }),
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    const sent: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'sent') : 0;
    return typeof sent === 'number' && sent > 0;
  } catch {
    return false;
  }
}
