// Wires the agent together: connection, tick sampler, loop tracer, inspector profiler.

import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { threadId } from 'node:worker_threads';
import { PROTOCOL_VERSION, type AgentCommand, type Hello, type WireMessage } from '@node-xray/core';
import type { Link } from './connection.js';
import { HttpMonitor } from './http-monitor.js';
import { IoMonitor } from './io-monitor.js';
import { InspectorProfiler } from './profiler.js';
import { Sampler, uvCounters } from './sampler.js';
import { errorMessage, SelfWork } from './self.js';
import { cpuCount, SwapReader } from './system.js';
import { LoopTracer } from './tracer.js';

/** Errors reported per process; a broken feature must not flood the stream. */
const MAX_ERRORS = 20;

export interface AgentOptions {
  readonly link: Link;
  readonly intervalMs: number;
  /** How V8 names the agent's own script in profiles, so its frames can be cut out. */
  readonly agentScript: string;
}

export interface AgentHandle {
  /** Stops everything the agent started and closes the link (detach). */
  stop(): void;
}

export interface HelloArgs {
  readonly intervalMs: number;
  readonly agentScript: string;
}

export function hello({ intervalMs, agentScript }: HelloArgs): Hello {
  return {
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    pid: process.pid,
    threadId,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    argv: process.argv,
    execArgv: process.execArgv,
    timeOrigin: performance.timeOrigin,
    intervalMs,
    cpus: cpuCount(),
    totalMemory: os.totalmem(),
    agentScript,
  };
}

export function startAgent({ link, intervalMs, agentScript }: AgentOptions): AgentHandle {
  let errors = 0;
  const self: SelfWork = new SelfWork((error) => {
    if (errors++ < MAX_ERRORS) deliver({ type: 'agent-error', message: errorMessage(error) });
  });
  const now = (): number => performance.now();

  const connection = link({
    self,
    onCommand: (command) => handle(command),
    onClose: () => shutdown(),
  });

  // During process exit nothing runs after the hook, so every message is written synchronously.
  let exiting = false;
  function deliver(message: WireMessage): void {
    if (exiting) connection.sendNow(message);
    else connection.send(message);
  }

  const sampler = new Sampler({ self, swap: new SwapReader((error) => self.report(error)), intervalMs, send: deliver });
  const addOverhead = (us: number): void => sampler.addOverhead(us);
  const tracer = new LoopTracer({
    self,
    send: deliver,
    now,
    timeOrigin: performance.timeOrigin,
    loopCount: () => uvCounters()?.loopCount ?? -1,
    addOverhead,
  });
  const profiler = new InspectorProfiler({ self, send: deliver, now, timeOrigin: performance.timeOrigin, addOverhead });
  const http = new HttpMonitor({ self, send: deliver, now, timeOrigin: performance.timeOrigin, intervalMs, addOverhead });
  const io = new IoMonitor({ self, send: deliver, now, timeOrigin: performance.timeOrigin, intervalMs, addOverhead });

  function handle(command: AgentCommand): void {
    switch (command.type) {
      case 'cpu-profile-start':
        profiler.startCpu(command);
        break;
      case 'cpu-profile-stop':
        profiler.stopCpu();
        break;
      case 'heap-sampling-start':
        profiler.startHeap(command);
        break;
      case 'heap-sampling-stop':
        profiler.stopHeap();
        break;
      case 'loop-trace-start':
        tracer.start(command);
        break;
      case 'loop-trace-stop':
        tracer.stop();
        break;
      case 'fs-timing-start':
        io.startFs();
        break;
      case 'fs-timing-stop':
        io.stopFs();
        break;
      default: {
        const unreachable: never = command;
        self.report(new Error(`unknown command ${JSON.stringify(unreachable)}`));
      }
    }
  }

  let stopped = false;
  function shutdown(): void {
    if (stopped) return;
    stopped = true;
    tracer.stop();
    profiler.stopAll();
    http.stop();
    io.stop();
    sampler.stop();
  }

  self.run(() => {
    connection.send(hello({ intervalMs, agentScript }));
    sampler.start();
    http.start();
    io.start();
  });

  // The last partial interval, trace batch and profile window, written synchronously.
  const onExit = (): void =>
    self.run(() => {
      if (stopped) return;
      exiting = true;
      tracer.stop();
      profiler.flushOnExit();
      http.tick();
      io.tick();
      sampler.tick();
      shutdown();
    });
  process.once('exit', onExit);

  return {
    stop() {
      process.off('exit', onExit);
      self.run(() => {
        shutdown();
        connection.close();
      });
    },
  };
}
