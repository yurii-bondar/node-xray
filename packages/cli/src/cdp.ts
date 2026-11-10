// A small Chrome DevTools Protocol client over Node's built-in WebSocket: enough to inject the
// agent into a running process and talk to it.

/** `GET /json/list` of a Node inspector → the debugger URL of its first target; null if none. */
export function debuggerUrl(list: unknown): string | null {
  if (!Array.isArray(list)) return null;
  for (const target of list as unknown[]) {
    if (typeof target !== 'object' || target === null) continue;
    const url: unknown = Reflect.get(target, 'webSocketDebuggerUrl');
    if (typeof url === 'string' && url.startsWith('ws://')) return url;
  }
  return null;
}

/** The inspector's debugger URL on `127.0.0.1:port`, or null when nothing answers there. */
export async function findInspector(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
    return response.ok ? debuggerUrl(await response.json()) : null;
  } catch {
    return null;
  }
}

export class CdpError extends Error {
  override name = 'CdpError';
}

export interface Cdp {
  /** The `result` of a call; throws CdpError on a protocol error or a closed connection. */
  send(method: string, params?: object): Promise<unknown>;
  on(method: string, handler: (params: unknown) => void): void;
  /** Resolves when the connection ends (detach, or the process exited). */
  readonly closed: Promise<void>;
  close(): void;
}

/**
 * The protocol over any text transport: ids and pending calls, events to handlers. Used for the
 * WebSocket to the main thread and for a worker's session tunnelled through it.
 */
function cdpOver(transmit: (text: string) => void, closed: Promise<void>, close: () => void): { cdp: Cdp; receive: (text: string) => void } {
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const handlers = new Map<string, Array<(params: unknown) => void>>();
  let open = true;
  void closed.then(() => {
    open = false;
    for (const call of pending.values()) call.reject(new CdpError('the inspector connection closed'));
    pending.clear();
  });

  const receive = (text: string): void => {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    const id: unknown = Reflect.get(message, 'id');
    if (typeof id === 'number') {
      const call = pending.get(id);
      pending.delete(id);
      const error: unknown = Reflect.get(message, 'error');
      if (error !== undefined) {
        const reason: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'message') : undefined;
        call?.reject(new CdpError(typeof reason === 'string' ? reason : 'protocol error'));
      } else call?.resolve(Reflect.get(message, 'result'));
      return;
    }
    const method: unknown = Reflect.get(message, 'method');
    if (typeof method !== 'string') return;
    for (const handler of handlers.get(method) ?? []) handler(Reflect.get(message, 'params'));
  };

  const cdp: Cdp = {
    send(method, params = {}) {
      if (!open) return Promise.reject(new CdpError('the inspector connection is closed'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        transmit(JSON.stringify({ id, method, params }));
      });
    },
    on(method, handler) {
      handlers.set(method, [...(handlers.get(method) ?? []), handler]);
    },
    closed,
    close,
  };
  return { cdp, receive };
}

export async function connectCdp(url: string): Promise<Cdp> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new CdpError(`cannot connect to ${url}`)), { once: true });
  });
  const closed = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve()));
  const { cdp, receive } = cdpOver(
    (text) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    },
    closed,
    () => socket.close(),
  );
  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') receive(event.data);
  });
  return cdp;
}

/**
 * A worker thread's own session, reached through the main thread's `NodeWorker` domain
 * (`NodeWorker.enable` reports workers as `attachedToWorker` with a session id).
 */
export function workerCdp(parent: Cdp, sessionId: string): Cdp {
  let end: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    end = resolve;
    void parent.closed.then(resolve);
  });
  const { cdp, receive } = cdpOver(
    (text) => void parent.send('NodeWorker.sendMessageToWorker', { sessionId, message: text }).catch(() => end()),
    closed,
    () => {
      void parent.send('NodeWorker.detach', { sessionId }).catch(() => undefined);
      end();
    },
  );
  parent.on('NodeWorker.receivedMessageFromWorker', (params) => {
    if (typeof params !== 'object' || params === null || Reflect.get(params, 'sessionId') !== sessionId) return;
    const message: unknown = Reflect.get(params, 'message');
    if (typeof message === 'string') receive(message);
  });
  parent.on('NodeWorker.detachedFromWorker', (params) => {
    if (typeof params === 'object' && params !== null && Reflect.get(params, 'sessionId') === sessionId) end();
  });
  return cdp;
}

/**
 * `Runtime.evaluate` and its outcome: the value (by value), or an error with the thrown
 * exception's text.
 */
export async function evaluate(cdp: Cdp, expression: string, options: { readonly commandLineApi?: boolean } = {}): Promise<unknown> {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, includeCommandLineAPI: options.commandLineApi ?? false });
  const exception: unknown = typeof result === 'object' && result !== null ? Reflect.get(result, 'exceptionDetails') : undefined;
  if (typeof exception === 'object' && exception !== null) {
    const thrown: unknown = Reflect.get(exception, 'exception');
    const description: unknown = typeof thrown === 'object' && thrown !== null ? Reflect.get(thrown, 'description') : undefined;
    const text: unknown = Reflect.get(exception, 'text');
    throw new CdpError(typeof description === 'string' ? description : typeof text === 'string' ? text : 'evaluation failed');
  }
  const remote: unknown = typeof result === 'object' && result !== null ? Reflect.get(result, 'result') : undefined;
  return typeof remote === 'object' && remote !== null ? Reflect.get(remote, 'value') : undefined;
}
