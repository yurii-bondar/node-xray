// The agent's links to the CLI. `xray run`: NDJSON both ways over a Unix socket / named pipe,
// unref'd so the agent never keeps the host process alive. `xray attach`: see binding.ts.

import { writeSync } from 'node:fs';
import net from 'node:net';
import { encodeLine, LineDecoder, parseAgentCommand, type AgentCommand, type WireMessage } from '@node-xray/core';
import type { SelfWork } from './self.js';

/** A CLI that stops reading must not make the agent buffer without bound. */
export const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
/** Commands are small; anything longer is not from the CLI. */
const MAX_COMMAND_LENGTH = 64 * 1024;
/** Dropped messages are reported at most this often (as an `agent-error`, once the CLI reads again). */
const DROP_REPORT_MS = 1000;

export interface LinkHandlers {
  readonly self: SelfWork;
  readonly onCommand: (command: AgentCommand) => void;
  /** The CLI went away. */
  readonly onClose: () => void;
}

export interface Connection {
  /** False when the message was dropped (the CLI is not keeping up, or is gone). */
  send(message: WireMessage): boolean;
  /** For process exit only: blocks until the line is written (bounded). False when it was not. */
  sendNow(message: WireMessage): boolean;
  close(): void;
}

/** Messages a link dropped; reported as one `agent-error` at most every `DROP_REPORT_MS`. */
export class DropCounter {
  #dropped = 0;
  #reportedAt = 0;

  constructor(private readonly self: SelfWork) {}

  drop(): false {
    this.#dropped++;
    return false;
  }

  /** Before a message goes out: the drops so far, when due, go out ahead of it. */
  reportDue(): void {
    if (this.#dropped === 0 || Date.now() - this.#reportedAt < DROP_REPORT_MS) return;
    const count = this.#dropped;
    this.#dropped = 0;
    this.#reportedAt = Date.now();
    // Comes back to the link as an `agent-error` message.
    this.self.report(new Error(`${count} message(s) dropped: the CLI was not reading`));
  }
}

/** Opens the agent's side of a transport once the agent is ready to handle commands. */
export type Link = (handlers: LinkHandlers) => Connection;

/** One command as the CLI sent it: narrowed here, bad ones reported and dropped. */
export function receiveCommand(text: string, { self, onCommand }: LinkHandlers): void {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    self.report(new Error('command is not JSON'));
    return;
  }
  const parsed = parseAgentCommand(value);
  if (parsed.ok) onCommand(parsed.value);
  else self.report(new Error(`bad command: ${parsed.error}`));
}

export function socketLink(path: string): Link {
  return (handlers) => {
    const { self, onClose } = handlers;
    const socket = net.createConnection(path);
    socket.unref();
    // Its callbacks (commands arriving, writes completing) are the agent's, not the application's.
    const handle: unknown = Reflect.get(socket, '_handle');
    if (typeof handle === 'object' && handle !== null) self.own(handle);
    socket.setEncoding('utf8');
    const decoder = new LineDecoder(MAX_COMMAND_LENGTH);
    socket.on('data', (chunk: string) =>
      self.run(() => {
        for (const line of decoder.push(chunk)) receiveCommand(line, handlers);
      }),
    );
    // No CLI listening, or it went away: the agent just stops; the host process carries on.
    socket.on('error', () => undefined);
    socket.on('close', () => self.run(onClose));
    return socketConnection(socket, self);
  };
}

function socketConnection(socket: net.Socket, self: SelfWork): Connection {
  const drops = new DropCounter(self);
  /** Process exit: one deadline for all the last lines together. */
  let exitDeadline = 0;
  /** A line was cut off on exit: anything after it would land on the half line. */
  let cut = false;
  return {
    send(message) {
      if (socket.destroyed || cut) return false;
      if (socket.writableLength > MAX_BUFFERED_BYTES) return drops.drop();
      drops.reportDue();
      socket.write(encodeLine(message));
      return true;
    },
    sendNow(message) {
      if (cut) return false;
      const fd = socketFd(socket);
      // With bytes still queued in libuv, a direct write would overtake them.
      if (fd === null || socket.writableLength > 0) return this.send(message);
      if (exitDeadline === 0) exitDeadline = Date.now() + EXIT_WRITE_BUDGET_MS;
      cut = !writeAllSync(fd, Buffer.from(encodeLine(message)), exitDeadline);
      return !cut;
    },
    close() {
      socket.end();
    },
  };
}

/** How long process exit may wait for the CLI to take the last lines, all of them together. */
const EXIT_WRITE_BUDGET_MS = 1000;
const pause = new Int32Array(new SharedArrayBuffer(4));

/** The socket's file descriptor on Unix; null for Windows pipes or when Node hides it. */
function socketFd(socket: net.Socket): number | null {
  const handle: unknown = Reflect.get(socket, '_handle');
  const fd: unknown = typeof handle === 'object' && handle !== null ? Reflect.get(handle, 'fd') : undefined;
  return typeof fd === 'number' && fd >= 0 ? fd : null;
}

/**
 * Process exit: the event loop will not run again, so a normal write that does not fit the
 * socket buffer (8 KiB for Unix sockets on macOS; a CPU profile is bigger) would be cut off.
 * This is the one place the agent does synchronous I/O after startup. False when the line was
 * not written in full by `deadline` (or the socket failed).
 */
export function writeAllSync(fd: number, data: Buffer, deadline: number): boolean {
  let rest = data;
  while (rest.length > 0 && Date.now() < deadline) {
    try {
      rest = rest.subarray(writeSync(fd, rest));
    } catch (error) {
      const code: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
      if (code !== 'EAGAIN') return false;
      Atomics.wait(pause, 0, 0, 1);
    }
  }
  return rest.length === 0;
}
