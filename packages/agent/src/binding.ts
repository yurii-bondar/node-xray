// The agent's link for `xray attach`: messages go out through a CDP binding (a global function
// the CLI added with `Runtime.addBinding`; each call arrives as `Runtime.bindingCalled`), and
// commands come in through `Runtime.evaluate` calling `deliver`.

import type { WireMessage } from '@node-xray/core';
import { receiveCommand, type Connection, type Link, type LinkHandlers } from './connection.js';

export interface BindingLink {
  readonly link: Link;
  /** A command (JSON text) from the CLI. */
  deliver(json: string): void;
}

export function bindingLink(name: string): BindingLink {
  let handlers: LinkHandlers | null = null;
  const send = (message: WireMessage): void => {
    const binding: unknown = Reflect.get(globalThis, name);
    // Gone once the CLI removed it (detach): messages have nowhere to go.
    if (typeof binding === 'function') binding(JSON.stringify(message));
  };
  const connection: Connection = { send, sendNow: send, close: () => undefined };
  return {
    link: (h) => {
      handlers = h;
      return connection;
    },
    deliver(json) {
      const h = handlers;
      if (h !== null) h.self.run(() => receiveCommand(json, h));
    },
  };
}
