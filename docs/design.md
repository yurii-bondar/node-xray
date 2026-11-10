# node-xray — design

Real-time profiler for a running Node.js process: event loop, heap, GC, CPU, live flame graph, allocation sampling. One core, three faces: a CLI with a local web dashboard (first), the same dashboard inside a VS Code webview with jumps to source (last).

The niche: existing tools (clinic.js, 0x, `--cpu-prof`, DevTools) are mostly "record, then look"; N|Solid is live but paid. node-xray is live, low-overhead, local-only, and correlates everything on one time axis ("this p99 spike is that major GC").

## Packages

```
packages/
  core/       pure, isomorphic logic: protocol, derived metrics, flame trees, insights
  agent/      runs inside the target process; Node >= 20, zero dependencies, one bundled file
  cli/        `xray` binary: launcher, collector, HTTP + SSE server, recordings, reports
  dashboard/  browser UI (uPlot charts, canvas flame graph), served by the CLI and by the webview
  vscode/     extension: webview hosting the dashboard, flame graph → source, hot-line decorations
```

`core` imports neither `node:*` nor the DOM, so the CLI (headless reports, CI budgets) and the dashboard (live charts) run the same code on the same raw messages.

## Data flow

```
target process                      xray CLI                          viewers
┌──────────────────────┐  NDJSON   ┌───────────────────────┐   SSE   ┌──────────────────┐
│ agent                │ ────────► │ collector             │ ──────► │ dashboard (web)  │
│  perf_hooks, v8      │  unix     │  core.Timeline/source │         │  core.Timeline   │
│  node:inspector      │  socket   │  recording .jsonl     │ ◄────── │ VS Code webview  │
│  (in-process CDP)    │ ◄──────── │  reports, budgets     │  POST   └──────────────────┘
└──────────────────────┘  commands └───────────────────────┘ commands
```

- **Agent → CLI:** newline-delimited JSON over a Unix domain socket (named pipe on Windows), path passed in `XRAY_SOCKET`. Zero dependencies on both ends, no port to expose.
- **CLI → browser:** Server-Sent Events for the stream (built-in reconnect, plain `node:http`), `POST /api/command` for commands. No `ws` dependency anywhere.
- The CLI forwards raw agent messages; the dashboard runs `core.Timeline` itself. One source of truth for derivation, and replaying a recording is the same code path as live.

## Collection

### Mode 1: preload agent (default)

`xray run -- node app.js` sets `NODE_OPTIONS=--require <agent>` (or `--import` for ESM-only setups), so cluster workers, child `node` processes and worker threads get the agent too. Each process/thread is a separate source (`pid:threadId`).

Per tick (default 1 s, `setInterval(...).unref()`), the agent sends **raw cumulative counters**; derivation happens in `core`. The agent stays tiny and dumb; the logic stays testable.

| Signal | API | Cost |
|---|---|---|
| event loop delay p50/p90/p99/max | `perf_hooks.monitorEventLoopDelay()` (native histogram, reset per tick) | ~0 |
| event loop utilization | `performance.eventLoopUtilization()` cumulative idle/active | ~0 |
| GC pauses by kind | `PerformanceObserver({ entryTypes: ['gc'] })` | per GC |
| heap totals, limit, detached contexts | `v8.getHeapStatistics()` | µs |
| heap by space | `v8.getHeapSpaceStatistics()` | µs |
| RSS, external, ArrayBuffers | `process.memoryUsage()` | µs |
| CPU user/system | `process.cpuUsage()` | ~0 |
| active handles by type | `process.getActiveResourcesInfo()` | O(handles) |
| loop iterations/s, libuv events/s | `performance.nodeTiming.uvMetricsInfo` (Node ≥ 20.18 / 22.8) | ~0 |
| peak RSS, page faults, context switches, fs ops | `process.resourceUsage()` | µs |
| container memory limit, available memory | `process.constrainedMemory()`, `process.availableMemory()` | ~0 |
| process swap | `VmSwap` from `/proc/self/status` (Linux, async read) | µs |
| agent's own cost | `process.cpuUsage()` around its own work | ~0 |

The always-on tick uses no `async_hooks`. They are only for the opt-in loop trace below.

### Live event loop trace (opt-in, time-limited)

The question this answers: "what exactly went through the loop just now?": 4 timers, 2 I/O callbacks, 1 immediate, 3 nextTicks, 12 promise reactions in iteration #1834, with names and durations.

- `async_hooks.createHook({ init, before, after, destroy, promiseResolve })`: `init` gives the resource type (`Timeout`, `Immediate`, `TickObject`, `Microtask`, `PROMISE`, `TCPWRAP`, `FSREQCALLBACK`, `GETADDRINFOREQWRAP`, `HTTPINCOMINGMESSAGE`, ...) and the callback name (`_onTimeout.name`, `_onImmediate.name`, `callback.name`); `before`/`after` give start and duration; nesting depth comes from before/after pairs.
- Iteration number: `uvMetricsInfo.loopCount` read in `before`. Without it (older Node), core infers boundaries from phase order (check → timers starts a new iteration).
- Phase per callback: timer → `timers`, I/O → `poll`, immediate → `check`, nextTick / queueMicrotask / promise → the microtask drain after each macrotask.
- The agent writes events into a preallocated ring and flushes every `flushMs` (default 250 ms) as one columnar batch (`LOOP_EVENT_STRIDE` numbers per event plus type/name dictionaries). Per-type counters (created / executed / settled / busy time) are exact; individual events are capped per flush (`dropped` says how many were left out).
- Queue state: created − settled per type since the trace started: pending promises, live timers, in-flight fs requests, open sockets.
- Cost, measured on a promise-heavy microbenchmark: about 4× slower (promise hooks are the expensive part); real servers pay much less, but it is not free. So it is off by default, always has `durationMs` (default 10 s), and the dashboard shows the overhead while it runs.

Dashboard view: a scrolling lane (like the DevTools performance panel) with one block per callback, coloured by category, nested microtasks below their macrotask, GC pauses from the sample stream drawn on the same lane (GC runs on the main thread, so it is part of the picture), idle gaps where the loop waits in poll. Under it: per-iteration bars (counts by category, busy time per phase), and the queue table.

### Process resources: RAM, swap, CPU, GPU

| What | Where it comes from |
|---|---|
| RSS, peak RSS, heap vs off-heap | `memoryUsage()`, `resourceUsage().maxRSS` |
| memory limit | cgroup limit (`constrainedMemory()`), else machine RAM; RSS / limit shown as a gauge, insight at 90 % |
| swap of the process | Linux `VmSwap`; elsewhere major page faults/s are the signal (no per-process swap API on macOS/Windows) |
| machine swap | host probe in the CLI: `/proc/meminfo` (Linux), `sysctl vm.swapusage` (macOS) |
| CPU | % of one core (user/system) and % of the machine (÷ `availableParallelism()`); voluntary/involuntary context switches/s show I/O wait vs CPU starvation |
| GPU | only when there is one to read: `nvidia-smi --query-gpu` and `--query-compute-apps` (per-process GPU memory) on Linux/Windows; `ioreg` accelerator stats on macOS. A plain Node server uses no GPU; this matters for Electron, `tfjs-node-gpu`, `onnxruntime`. Collected by the CLI host probe, not the agent |

The host probe runs in the CLI (outside the target), samples every 2 s and sends `host` messages into the same stream.

### In-process profiling via `node:inspector`

The agent opens an in-process `inspector.Session` (no `--inspect`, no port):

- **Live CPU flame graph:** `Profiler.start`, then every `windowMs` (default 5 s) `Profiler.stop` + `Profiler.start`; each window is one `cpu-profile` message. The dashboard merges the last N windows. Sampling interval default 1 ms.
- **Allocation sampling:** `HeapProfiler.startSampling({ samplingInterval: 32 KiB })`, `getSamplingProfile` per window → top allocation sites with stacks. Low overhead, safe under load.
- **Heap snapshot:** manual button only, with a warning: it stops the process for seconds and can double memory. Never automatic.

Both profilers are off by default and toggled from the dashboard (`AgentCommand`), so the baseline overhead is just the tick.

### Mode 2: attach to a running process (no restart, no code change)

`xray attach <pid>`: send `SIGUSR1` (Unix) or `process._debugProcess(pid)` (Windows) → the target opens its inspector on `127.0.0.1:9229` → the CLI connects with Node's built-in `WebSocket` (CDP), then:

1. `Runtime.addBinding({ name: '__xray' })` — a function in the target whose calls arrive as `Runtime.bindingCalled` events;
2. `Runtime.evaluate` with the same agent bundle, transport set to `__xray` instead of the socket. Modules come from `process.getBuiltinModule()` (Node ≥ 20.16 / 22.3), falling back to `process.mainModule.require`;
3. profiling uses the CDP connection directly (`Profiler.*`, `HeapProfiler.*`).

Same agent, same protocol, different transport. On detach: stop the agent, `Runtime.removeBinding`, close the inspector (`inspector.close()` via evaluate).

## Analysis in core (the reason to use it over raw charts)

| Insight | Rule |
|---|---|
| loop stall | `loopDelay.max >= 100 ms` in a frame; cause `gc` when the frame's longest GC pause covers ≥ 50 % of it |
| GC pressure | GC pauses take ≥ 10 % of wall time in a frame |
| heap growth (leak suspect) | floor of `heapUsed` per 30 s bucket (the post-GC baseline, not the sawtooth) grows linearly: slope ≥ 1 MiB/min, R² ≥ 0.8, ≥ 5 buckets |
| native growth | same on `rss − heapTotal`: Buffers, native addons, fragmentation |
| detached contexts | `number_of_detached_contexts > 0` (leaked `vm` contexts / iframes in Electron) |

| near heap limit | `heapUsed ≥ 90 %` of `heap_size_limit` (next: `FATAL ERROR: heap out of memory`) |
| near memory limit | RSS ≥ 90 % of the cgroup limit or RAM (next: OOM killer) |
| swapping | major page faults ≥ 10/s |

Later, with CPU windows: attribute a non-GC stall to the hottest stacks of the overlapping profile window.

## Dashboard

- One shared time axis with a crosshair across all charts: loop delay (p50/p99/max) + utilization + iterations/s; CPU user/system and % of machine; heap by space (stacked area) with limit line; RSS vs heapTotal vs external (off-heap visible) vs memory limit; swap and page faults; GPU when present; GC pauses as bars coloured by kind; active handles by type.
- Live mode: while a dashboard is open the sample tick drops to 250 ms, so the charts move continuously; it returns to 1 s when nobody watches.
- Each section has a "live detail" view, not only a chart:
  - **Event loop:** the callback lane and per-iteration counts (above).
  - **GC:** every pause as a block with kind and duration; new space shown as a fill gauge that empties on each scavenge; old space growth between major GCs.
  - **Heap:** per-space bars updating live; top allocation sites from heap sampling, updated every window.
  - **CPU:** flame graph of the last N windows (1 s windows in live mode), "hot now" table with self time.
  - **I/O and HTTP:** in-flight and completed requests from `diagnostics_channel` (`http.server.request.start` / `http.server.response.finish`, `undici:request:*` for `fetch`): requests/s, latency percentiles, the slowest live requests. No async_hooks needed.
  - **Resources:** handles by type, RAM/limit gauge, swap, GPU.
- Insights as markers on the axis and a list; clicking one zooms there.
- Flame graph for the last N seconds (canvas), toggle "hide idle/program", search, diff against a pinned window.
- Top allocations table from heap sampling.
- uPlot for charts (fast on streaming data). Data columns are kept in core ring buffers; at 1 Hz a 1 h window is 3600 points per series.

## Recording, reports, CI

- `xray run --record out.xray.jsonl` writes the raw messages; `xray replay out.xray.jsonl` opens the dashboard on it.
- Export: `.cpuprofile` (DevTools, speedscope) and `.heapprofile` from any window.
- `xray run --duration 120s --report report.json --budget "loop.p99<50ms,heap.growth<5MiB/min" -- node server.js`: headless, prints the insights, exits non-zero when a budget fails. Designed for load tests (k6/autocannon in another terminal or in CI).

## VS Code extension (last)

- Command "xray: Profile current launch" (wraps a launch config with `NODE_OPTIONS`) and "xray: Attach to process" (pick from running `node` processes).
- Webview hosts the same dashboard bundle; messages typed in `src/protocol.ts`.
- Flame graph frame click → open `url:line:column` (source maps resolved by the CLI).
- Hot lines from the CPU profile (`positionTicks`) as editor decorations / CodeLens with self time.

## Security

- Everything binds to `127.0.0.1` only; the dashboard URL carries a random token; the agent socket is created with mode `0600`.
- The inspector executes arbitrary code: attach mode warns, and closes the inspector on detach.
- Remote servers and containers: SSH tunnel (`ssh -L`) or run the CLI inside the container and tunnel the dashboard port.

## Overhead budget

- Tick: well under 1 % of one core at 1 Hz; the agent reports its own CPU time and the dashboard shows it.
- CPU profiling at 1 ms: low single-digit %, plus `Profiler.stop` serialisation per window on the main thread; raise the interval under heavy load.
- Heap sampling at 32 KiB: low; heap snapshot: stop-the-world, manual only.
- Loop trace: expensive (async_hooks + promise hooks), opt-in and time-limited; hook callbacks only write numbers into a preallocated typed-array ring.

## Roadmap

1. **core** — protocol (samples, profiles, loop trace, host probe, commands), NDJSON framing, derived frames, loop iterations and queues, flame trees, insights, timeline, run reports. *(done)*
2. **agent + `xray run`** — preload agent (tick, loop trace, CPU profile windows, heap sampling), socket collector, host probe (swap via `/proc/meminfo` / `sysctl vm.swapusage`, GPU via `nvidia-smi` / `ioreg`), terminal summary with findings and the likely culprit of each stall, `--report` JSON, `--record` (`{"c":<connection>,"m":<message>}` per line, messages verbatim). *(done)*
3. **dashboard** — `xray run --ui/--open`: SSE stream of records (`event: reset`, backlog, live; `event: status`), commands via `POST /api/command`; tiles, findings with culprits, the event loop lane with iteration marks and per-iteration grouped callbacks, queue table, uPlot charts with a shared cursor, live CPU flame graph (1 s windows, zoom), heap spaces, allocation sites, GC list, paging and GPU charts. *(done; findings are drawn as dashed markers on the loop delay and GC charts)*
4. **profiling** — exports (`xray run --profiles <dir>`, dashboard download: the whole run's CPU tree and the latest allocation profile, agent frames removed), baseline diff (pin the last 10 windows, flame graph coloured by change in share of CPU work, table of functions that moved), source maps (`.map` files and inline `data:` maps resolved by the CLI; terminal summary and dashboard show the original file and line via `POST /api/resolve`). Profiles of programs shorter than one window are flushed on exit. *(done)*
5. **HTTP** via `diagnostics_channel` (always on, no patching): served (`http.server.request.start` → `response.finish`, Express `req.route` patterns when present) and made (`http.client.*`, `fetch` via `undici:request:*`, timed to response headers). Per tick the agent sends counts, status classes, a latency histogram (`HTTP_BUCKETS_MS`, fine below 1 ms), a route table capped at 100 normalised routes (`/users/:id`), the 5 slowest requests and requests running over 1 s; aborted requests are found on the tick sweep. Core derives rates and percentiles, summaries and findings (`http-errors` ≥ 5 % with ≥ 20 requests, `http-slow` p99 ≥ 1 s, `http-stuck` ≥ 10 s). Terminal summary and a dashboard panel (rates, latency, routes, calls, slowest, running now). Cost: a few µs per request per side; on a 20k req/s microbenchmark it was within run-to-run noise to ~10 %. *(done; file system and DNS timing still to do)*
6. **attach** — `xray attach [options] <pid>`: checks the pid is a Node binary (SIGUSR1 would terminate anything else), opens the inspector (SIGUSR1 / `process._debugProcess`) unless it already listens on `--inspect-port`, verifies the inspector's `process.pid`, adds a CDP binding, has the process `require` the attach bundle from disk (so its frames have a path in CPU and heap profiles and are cut out as in `run`), and drives it with `Runtime.evaluate`. Detach on Ctrl+C, `--duration` or process exit: stop the agent, let the last messages arrive, remove the binding, close the inspector if xray opened it (also after a failed attach). Same options, summary, dashboard, `--report`, `--profiles` as `run` (shared `session.ts`). Main thread only; the target prints Node's "Debugger listening" lines. *(done)*
7. **record / replay / report / budgets** — `xray replay [--open|--report|--profiles|--budget] <file>` feeds a `--record` file back through the collector (raw message text via `recordPayload`, no host probe, dashboard controls disabled), so it produces what the live run would have. `--budget "loop.p99<50ms,http.p99<300ms,heap.growth<5MiB/min"` on `run`, `attach` and `replay`: metrics read from each process's report (`METRICS` in `core/budgets.ts`), units checked per metric, a metric without data is skipped (not passed); a broken budget exits 1 unless the command failed first; results go in the summary and `--report`. *(done)*
8. **VS Code extension** — commands Profile Current File, Profile a Command…, Attach to a Running Node.js Process… (picker from `ps`, same SIGUSR1 rule as the CLI), Show Dashboard, Stop (Ctrl+C to the terminal, twice: program, then xray), Clear Hot Lines. The terminal's process is the bundled CLI itself with a port and a token the extension chose (`XRAY_DASHBOARD_TOKEN`); the webview frames the dashboard (`asExternalUri`, strict CSP, messages relayed only from its origin); the Host check accepts any port of 127.0.0.1/localhost so forwarded ports work. Hot lines: `positionTicks` of CPU profiles summed per line in core (`LineTicks`), source-mapped and merged across processes by `GET /api/lines`, drawn as after-text in three tiers. *(done)*
9. **Files, DNS, workers in attach** — DNS from Node's `dns` performance entries (always on, no patching: lookup and query timings with the host name). File system: Node publishes nothing usable (fs async resources carry neither operation nor path), so `--fs` / the dashboard toggle wraps the `fs` callback, promise and `*Sync` functions (outermost sync call only, so `readFileSync` is not counted again through `openSync`/`readSync`). Per tick the agent sends an `io` message (fs, fs sync, DNS: counts, latency histogram, operations by key, slowest); core adds findings (`fs-blocking`: *Sync calls ≥ 20 ms in a tick, `dns-slow`: a lookup ≥ 200 ms), report sections and budgets (`fs.p99`, `fs.sync`, `dns.p99`, `dns.max`). `attach` enables `NodeWorker`, injects the agent into every worker (present and future) through its tunnelled session, and detaches each one. FileHandle methods of `fs.promises` are not timed. *(done)*
