// `xray` command line → one typed shape.

import { parseBudgets, type Budget } from '@node-xray/core';

/** What `run` and `attach` share: what to collect and where the results go. */
export interface SessionOptions {
  readonly intervalMs: number;
  /** CPU profiling in windows, hot functions in the summary. */
  readonly cpu: boolean;
  /** Allocation sampling, top allocation sites in the summary. */
  readonly heap: boolean;
  /** Time file system calls (wraps the `fs` functions; DNS is timed always). */
  readonly fs: boolean;
  /** Trace every loop callback for this long after each source connects; `null` = off. */
  readonly traceLoopMs: number | null;
  readonly record: string | null;
  readonly report: string | null;
  /** Directory for `.cpuprofile` / `.heapprofile` files written at the end; `null` = none. */
  readonly profiles: string | null;
  /** Serve the live dashboard; `null` = no dashboard. */
  readonly ui: { readonly port: number; readonly open: boolean } | null;
  /** Checked at the end; a failed one makes the exit code non-zero. */
  readonly budgets: readonly Budget[];
}

export interface RunOptions extends SessionOptions {
  readonly command: string;
  readonly args: readonly string[];
}

export interface AttachOptions extends SessionOptions {
  readonly pid: number;
  /** Where the target's inspector listens (SIGUSR1 opens it on 9229). */
  readonly inspectPort: number;
  /** Detach after this long; `null` = on Ctrl+C or when the process exits. */
  readonly durationMs: number | null;
}

export interface ReplayOptions extends SessionOptions {
  /** A `--record` file. */
  readonly file: string;
}

export type Cli =
  | { readonly kind: 'run'; readonly options: RunOptions }
  | { readonly kind: 'attach'; readonly options: AttachOptions }
  | { readonly kind: 'replay'; readonly options: ReplayOptions }
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'error'; readonly message: string };

export const USAGE = `Usage: xray run [options] [--] <command> [args...]
       xray attach [options] <pid>
       xray replay [options] <file.xray.jsonl>

run     starts <command> with the xray agent preloaded into every Node.js process and
        thread it starts, then prints a summary: CPU, event loop, memory, swap, GC, GPU,
        HTTP, findings.
attach  profiles a Node.js process that is already running, without restarting it: opens
        its inspector (SIGUSR1), injects the agent into it and its worker threads, and on
        Ctrl+C removes it and closes the inspector again.
replay  reads a --record file back: summary, dashboard, report, profiles, budgets.

Options:
  --interval <duration>     sample interval (default 1s, at least 50ms)
  --cpu                     CPU profiling in 5 s windows; hot functions in the summary
  --heap                    allocation sampling; top allocation sites in the summary
  --fs                      time file system calls, *Sync ones too (wraps the fs functions; DNS is always timed)
  --trace-loop <duration>   trace every event loop callback for this long (costly: async_hooks)
  --record <file>           write the raw stream to <file> (.xray.jsonl)
  --report <file>           write the summary as JSON
  --profiles <dir>          write .cpuprofile / .heapprofile per process (open in Chrome DevTools or speedscope)
  --ui                      live dashboard on http://127.0.0.1 (samples every 250ms unless --interval);
                            stays up after the command exits, until Ctrl+C
  --open                    --ui and open it in the browser
  --port <n>                dashboard port (default: a free one)
  --budget <list>           fail (exit 1) when a budget is broken, e.g. "loop.p99<50ms,http.errors<1%";
                            metrics: cpu.avg cpu.max loop.p99 loop.max loop.busy rss.max heap.max
                            heap.growth native.growth gc.pause gc.max http.p50 http.p99 http.errors
                            http.rps http.out.p99 http.out.errors fs.p99 fs.sync dns.p99 dns.max
  --inspect-port <n>        attach: the target's inspector port (default 9229)
  --duration <duration>     attach: detach after this long
  -h, --help                show this help
  -v, --version             show the version

Durations: 500ms, 10s, 2m; a bare number is seconds.

Examples:
  xray run node server.js
  xray run --open --cpu -- node server.js
  xray run --cpu --trace-loop 10s -- npm start
  xray run --report report.json -- node --max-old-space-size=512 worker.js
  xray attach --open --cpu 4242
  xray attach --duration 30s --profiles ./profiles 4242
  xray run --budget "loop.p99<50ms,http.p99<300ms,heap.growth<5MiB/min" -- node server.js
  xray replay --open run.xray.jsonl`;

const UNITS: Readonly<Record<string, number>> = { ms: 1, s: 1000, m: 60_000 };

/** `500ms`, `10s`, `2m`, `1.5` (seconds) → ms; `null` when not a positive duration. */
export function parseDuration(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(text.trim());
  if (match === null || match[1] === undefined) return null;
  const ms = Number(match[1]) * (UNITS[match[2] ?? 's'] ?? 1000);
  return ms > 0 ? Math.round(ms) : null;
}

export function parseArgs(argv: readonly string[]): Cli {
  const [verb, ...rest] = argv;
  if (verb === undefined || verb === '-h' || verb === '--help' || verb === 'help') return { kind: 'help' };
  if (verb === '-v' || verb === '--version') return { kind: 'version' };
  if (verb !== 'run' && verb !== 'attach' && verb !== 'replay') return { kind: 'error', message: `unknown command '${verb}'` };
  /** Options that collect data: a replay only reads what was collected. */
  const collecting = new Set(['--interval', '--cpu', '--heap', '--fs', '--trace-loop', '--record']);

  let intervalMs: number | null = null;
  let ui = false;
  let open = false;
  let port = 0;
  let cpu = false;
  let heap = false;
  let fs = false;
  let traceLoopMs: number | null = null;
  let record: string | null = null;
  let report: string | null = null;
  let profiles: string | null = null;
  let inspectPort = 9229;
  let durationMs: number | null = null;
  const budgetTexts: string[] = [];

  let i = 0;
  const value = (flag: string): string | { error: string } => {
    const next = rest[++i];
    return next === undefined ? { error: `${flag} needs a value` } : next;
  };
  const duration = (flag: string): number | { error: string } => {
    const text = value(flag);
    if (typeof text !== 'string') return text;
    return parseDuration(text) ?? { error: `${flag}: '${text}' is not a duration` };
  };

  for (; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === '--') {
      i++;
      break;
    }
    if (!arg.startsWith('-')) break;
    if (verb === 'replay' && collecting.has(arg)) return { kind: 'error', message: `${arg} collects data; a replay only reads a recording` };
    switch (arg) {
      case '--interval': {
        const ms = duration(arg);
        if (typeof ms !== 'number') return { kind: 'error', message: ms.error };
        if (ms < 50) return { kind: 'error', message: '--interval must be at least 50ms' };
        intervalMs = ms;
        break;
      }
      case '--cpu':
        cpu = true;
        break;
      case '--ui':
        ui = true;
        break;
      case '--open':
        ui = true;
        open = true;
        break;
      case '--port':
      case '--inspect-port': {
        if (arg === '--inspect-port' && verb !== 'attach') return { kind: 'error', message: '--inspect-port is for attach' };
        const text = value(arg);
        if (typeof text !== 'string') return { kind: 'error', message: text.error };
        const n = Number(text);
        if (!Number.isInteger(n) || n < 1 || n > 65_535) return { kind: 'error', message: `${arg}: '${text}' is not a port` };
        if (arg === '--port') {
          port = n;
          ui = true;
        } else inspectPort = n;
        break;
      }
      case '--budget': {
        const text = value(arg);
        if (typeof text !== 'string') return { kind: 'error', message: text.error };
        budgetTexts.push(text);
        break;
      }
      case '--duration': {
        if (verb !== 'attach') return { kind: 'error', message: '--duration is for attach' };
        const ms = duration(arg);
        if (typeof ms !== 'number') return { kind: 'error', message: ms.error };
        durationMs = ms;
        break;
      }
      case '--heap':
        heap = true;
        break;
      case '--fs':
        fs = true;
        break;
      case '--trace-loop': {
        const ms = duration(arg);
        if (typeof ms !== 'number') return { kind: 'error', message: ms.error };
        traceLoopMs = ms;
        break;
      }
      case '--record':
      case '--report':
      case '--profiles': {
        const file = value(arg);
        if (typeof file !== 'string') return { kind: 'error', message: file.error };
        if (arg === '--record') record = file;
        else if (arg === '--report') report = file;
        else profiles = file;
        break;
      }
      case '-h':
      case '--help':
        return { kind: 'help' };
      default:
        return { kind: 'error', message: `unknown option '${arg}'` };
    }
  }

  const budgets = parseBudgets(budgetTexts);
  if (typeof budgets === 'string') return { kind: 'error', message: `--budget ${budgets}` };
  // Live charts want frequent samples; summaries are fine with one per second.
  const session: SessionOptions = { intervalMs: intervalMs ?? (ui ? 250 : 1000), cpu, heap, fs, traceLoopMs, record, report, profiles, ui: ui ? { port, open } : null, budgets };
  const [first, ...more] = rest.slice(i);
  if (verb === 'replay') {
    if (first === undefined) return { kind: 'error', message: 'missing <file> to replay' };
    if (more.length > 0) return { kind: 'error', message: `unexpected '${more.join(' ')}' after the file` };
    return { kind: 'replay', options: { ...session, file: first } };
  }
  if (verb === 'attach') {
    if (first === undefined) return { kind: 'error', message: 'missing <pid> to attach to' };
    const pid = Number(first);
    if (!Number.isInteger(pid) || pid <= 0) return { kind: 'error', message: `'${first}' is not a process id` };
    if (more.length > 0) return { kind: 'error', message: `unexpected '${more.join(' ')}' after the pid` };
    return { kind: 'attach', options: { ...session, pid, inspectPort, durationMs } };
  }
  if (first === undefined) return { kind: 'error', message: 'missing <command> to run' };
  return { kind: 'run', options: { ...session, command: first, args: more } };
}
