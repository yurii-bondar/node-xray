// Preload entry: `node --require <agent.cjs>` (or via NODE_OPTIONS, which also reaches
// worker threads and child node processes). Does nothing unless the CLI set XRAY_SOCKET.

import { startAgent } from './agent.js';
import { socketLink } from './connection.js';

const LOADED = Symbol.for('node-xray.agent');

function boot(): void {
  const socketPath = process.env['XRAY_SOCKET'];
  // Each worker thread has its own globalThis and starts its own agent.
  if (!socketPath || Reflect.get(globalThis, LOADED) === true) return;
  Reflect.set(globalThis, LOADED, true);
  const intervalMs = Number(process.env['XRAY_INTERVAL_MS']);
  startAgent({
    link: socketLink(socketPath),
    intervalMs: Number.isFinite(intervalMs) && intervalMs >= 50 ? intervalMs : 1000,
    // The bundle is CommonJS: __filename is the agent file, and V8 names CommonJS scripts by path.
    agentScript: typeof __filename === 'string' ? __filename : '',
  });
}

try {
  boot();
} catch {
  // The profiler failing must never stop the application from starting.
}
