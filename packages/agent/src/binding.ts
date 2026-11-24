// The agent's link for `xray attach`: messages go out through a CDP binding (a global function
// the CLI added with `Runtime.addBinding`; each call arrives as `Runtime.bindingCalled`), and
// commands come in through `Runtime.evaluate` calling `deliver`.
//
// A binding call never blocks: what the CLI has not read yet waits in the inspector's queue in
// this process. So the CLI acknowledges what it received (`ack`, the characters of every payload
// so far), and beyond `MAX_BUFFERED_BYTES` characters in flight messages are dropped, as on the
// socket. A CLI that never acknowledges only makes the agent drop.

import type { WireMessage } from '@node-xray/core';
import { DropCounter, MAX_BUFFERED_BYTES, receiveCommand, type Connection, type Link, type LinkHandlers } from './connection.js';

export interface BindingLink {
  readonly link: Link;
  /** A command (JSON text) from the CLI. */
  deliver(json: string): void;
  /** The CLI received this many payload characters (`.length` of each JSON text) so far in all. */
  ack(chars: unknown): void;
}

export function bindingLink(name: string): BindingLink {
  let handlers: LinkHandlers | null = null;
  /** Characters handed to the binding / acknowledged by the CLI, since the start. */
  let sent = 0;
  let acked = 0;
  return {
    link: (h) => {
      handlers = h;
      const drops = new DropCounter(h.self);
      const send = (message: WireMessage): boolean => {
        const binding: unknown = Reflect.get(globalThis, name);
        // Gone once the CLI removed it (detach): messages have nowhere to go.
        if (typeof binding !== 'function') return false;
        if (sent - acked > MAX_BUFFERED_BYTES) return drops.drop();
        drops.reportDue();
        const json = JSON.stringify(message);
        binding(json);
        sent += json.length;
        return true;
      };
      const connection: Connection = { send, sendNow: send, close: () => undefined };
      return connection;
    },
    deliver(json) {
      const h = handlers;
      if (h !== null) h.self.run(() => receiveCommand(json, h));
    },
    ack(chars) {
      const h = handlers;
      if (h === null) return;
      h.self.run(() => {
        // Cumulative: never back, never more than was sent.
        if (typeof chars !== 'number' || !Number.isFinite(chars) || chars < acked || chars > sent) {
          throw new Error(`bad ack ${typeof chars === 'number' ? chars : typeof chars} (sent ${sent}, acknowledged ${acked})`);
        }
        acked = chars;
      });
    },
  };
}
