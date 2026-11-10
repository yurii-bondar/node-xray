// The agent's links to the CLI. `xray run`: NDJSON both ways over a Unix socket / named pipe,
// unref'd so the agent never keeps the host process alive. `xray attach`: see binding.ts.

import { writeSync } from 'node:fs';
import net from 'node:net';
import { encodeLine, LineDecoder, parseAgentCommand, type AgentCommand, type WireMessage } from '@node-xray/core';
import type { SelfWork } from './self.js';

/** A CLI that stops reading must not make the agent buffer without bound. */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
/** Commands are small; anything longer is not from the CLI. */
const MAX_COMMAND_LENGTH = 64 * 1024;

export interface LinkHandlers {
  readonly self: SelfWork;
  readonly onCommand: (command: AgentCommand) => void;
  /** The CLI went away. */
  readonly onClose: () => void;
}

export interface Connection {
  send(message: WireMessage): void;
  /** For process exit only: blocks until the line is written (bounded). */
  sendNow(message: WireMessage): void;
  close(): void;
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
    return socketConnection(socket);
  };
}

function socketConnection(socket: net.Socket): Connection {
  return {
    send(message) {
      if (socket.destroyed || socket.writableLength > MAX_BUFFERED_BYTES) return;
      socket.write(encodeLine(message));
    },
    sendNow(message) {
      const fd = socketFd(socket);
      // With bytes still queued in libuv, a direct write would overtake them.
      if (fd === null || socket.writableLength > 0) {
        this.send(message);
        return;
      }
      writeAllSync(fd, Buffer.from(encodeLine(message)));
    },
    close() {
      socket.end();
    },
  };
}

/** How long process exit may wait for the CLI to take the last lines. */
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
 * This is the one place the agent does synchronous I/O after startup.
 */
function writeAllSync(fd: number, data: Buffer): void {
  const deadline = Date.now() + EXIT_WRITE_BUDGET_MS;
  let rest = data;
  while (rest.length > 0 && Date.now() < deadline) {
    try {
      rest = rest.subarray(writeSync(fd, rest));
    } catch (error) {
      const code: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
      if (code !== 'EAGAIN') return;
      Atomics.wait(pause, 0, 0, 1);
    }
  }
}
