// Entry for `xray attach`: the CLI has the running process `require` this bundle (through the
// inspector) and drives it through `globalThis[Symbol.for('node-xray.attach')]`. Loaded from its
// file, it has a path in every profile, so its own frames can be cut out as in `xray run`.

import { startAgent, type AgentHandle } from './agent.js';
import { bindingLink } from './binding.js';

export interface AttachOptions {
  readonly binding: string;
  readonly intervalMs: number;
}

export interface AttachApi {
  start(options: AttachOptions): void;
  command(json: string): void;
  /** The CLI received this many payload characters from the agent since `start` (cumulative). */
  ack(chars: number): void;
  stop(): void;
}

const KEY = Symbol.for('node-xray.attach');

function install(): void {
  // Attaching twice (an earlier CLI died without detaching) replaces the old agent.
  const previous: unknown = Reflect.get(globalThis, KEY);
  if (typeof previous === 'object' && previous !== null) {
    const stop: unknown = Reflect.get(previous, 'stop');
    if (typeof stop === 'function') stop.call(previous);
  }
  let agent: AgentHandle | null = null;
  let deliver: (json: string) => void = () => undefined;
  let ack: (chars: number) => void = () => undefined;
  const api: AttachApi = {
    start({ binding, intervalMs }) {
      agent?.stop();
      const link = bindingLink(binding);
      deliver = (json) => link.deliver(json);
      ack = (chars) => link.ack(chars);
      agent = startAgent({ link: link.link, intervalMs, agentScript: typeof __filename === 'string' ? __filename : '' });
    },
    command(json) {
      deliver(json);
    },
    ack(chars) {
      ack(chars);
    },
    stop() {
      agent?.stop();
      agent = null;
      deliver = () => undefined;
      ack = () => undefined;
    },
  };
  Reflect.set(globalThis, KEY, api);
}

install();
