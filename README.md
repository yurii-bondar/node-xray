# xray

Real-time profiler for Node.js processes. See what a running program is doing, live and correlated on one time axis:

- **Event loop**: delay, utilization and iterations per second; on demand, every callback the loop runs (timers, I/O, immediates, nextTicks, microtasks, promises, GC pauses), grouped by loop iteration, with what is still waiting in the queues.
- **CPU**: live flame graph, hot functions, a baseline diff ("what got slower"), CPU share per source line, source-mapped to your TypeScript.
- **Memory and GC**: heap by space, allocation sites, every GC pause, RSS against the container limit, off-heap growth, swap and page faults.
- **HTTP**: requests served and made (`http`, `https`, `fetch`): rates, latency percentiles, routes, slowest and stuck requests.
- **Files and DNS**: every DNS lookup; file system calls by operation and path, and the `*Sync` calls that blocked the loop.
- **System**: CPU against the machine, memory against the cgroup limit, system swap, GPU when there is one.
- **Findings**: event loop stalls with the code that caused them, leak suspects (heap and off-heap), GC pressure, near-OOM, swapping, error spikes, blocking file system calls, slow DNS.

Three ways in: a CLI with a terminal summary and a local web dashboard, `attach` to a process that is already running (no restart), and a VS Code extension with hot lines in the editor.

## Requirements

- **Node.js 22 or newer** to run xray itself.
- The profiled program can run on **Node.js 20 or newer**.
- macOS or Linux. Windows should work for `run` but is not tested; `attach` there needs the pid entered by hand.

## Installation

xray is not on npm yet: install it from source.

```sh
git clone https://github.com/yurii-bondar/node-xray.git
cd node-xray
npm install
npm run build
npm link -w @node-xray/cli     # puts `xray` on your PATH
```

Check it:

```sh
xray --version
xray --help
```

Without `npm link`, run it as `node /path/to/node-xray/packages/cli/dist/src/bin.js`, or `npx xray` from inside the repository.

### VS Code extension

```sh
npm run package -w node-xray                                  # builds packages/vscode/node-xray-0.0.0.vsix
code --install-extension packages/vscode/node-xray-0.0.0.vsix
```

The `.vsix` carries the CLI, the agent and the dashboard; nothing else needs to be installed. VS Code needs to find Node.js 22+ (setting `xray.nodePath`, default `node`).

## Usage

### Profile a command: `xray run`

```sh
xray run node server.js
xray run -- npm start                 # every Node.js process and worker thread npm starts is profiled
```

The program runs as usual (same output, same exit code). When it exits, xray prints a summary on stderr: CPU, event loop, memory, swap, GC, HTTP, files and DNS, and its findings, with the likely culprit of each stall.

Collect more:

```sh
xray run --cpu -- node server.js                # CPU profile: hot functions, stall culprits
xray run --heap -- node server.js               # allocation sampling: top allocation sites
xray run --fs -- node server.js                 # file system timings (DNS is always timed)
xray run --trace-loop 10s -- node server.js     # every event loop callback for 10 s (costly)
```

### Live dashboard

```sh
xray run --open --cpu -- node server.js
```

`--open` starts the dashboard and opens it in the browser (`--ui` only prints its URL, `--port` picks the port). It listens on `127.0.0.1` only and the URL carries a random token. Samples come every 250 ms while the dashboard is on.

On the page:

- **Trace callbacks 10 s** records every callback the loop runs. The lane shows one block per callback in a row per kind, with loop iteration boundaries; hover a block for its name, duration, iteration and phase; click an iteration bar for what ran in it.
- **Start CPU profile** turns on the live flame graph (click to zoom). **Pin as baseline** compares later CPU work against now: red got heavier, blue got lighter. **Download .cpuprofile** saves the whole run for Chrome DevTools or speedscope.
- **Start allocation sampling** lists who allocates; **Start fs timing** times file system calls.
- Findings are listed at the top and drawn as dashed markers on the charts.

The dashboard stays up after the program exits; press Ctrl+C to finish and get the summary.

### Attach to a running process: `xray attach`

```sh
xray attach 4242                          # summary on Ctrl+C
xray attach --open --cpu 4242             # with the dashboard
xray attach --duration 30s --profiles ./profiles 4242
```

No restart and no code change. xray opens the process's inspector (`SIGUSR1`), loads the agent into it and into its worker threads, and on detach (Ctrl+C, `--duration`, or the process exiting) removes the agent and closes the inspector again.

- Only a Node.js binary is ever sent `SIGUSR1` (for other programs that signal means "terminate"). A Node binary under another name can be attached when it was started with `--inspect`.
- A process started with `--inspect=<port>` is attached on that port: `--inspect-port <port>`.
- While attached, the inspector listens on `127.0.0.1` and lets anyone on this machine run code in the process; it is closed on detach.
- The process prints Node's "Debugger listening on ..." lines to its stderr.

### Record and replay

```sh
xray run --record run.xray.jsonl -- node server.js
xray replay run.xray.jsonl                # the same summary, from the recording
xray replay --open run.xray.jsonl         # browse it in the dashboard
```

### Reports, profiles and budgets for CI

```sh
xray run --report report.json --profiles ./profiles \
  --budget "loop.p99<50ms,http.p99<300ms,http.errors<1%,heap.growth<5MiB/min" \
  -- node server.js
```

- `--report <file>`: the summary as JSON, budgets included.
- `--profiles <dir>`: a `.cpuprofile` and a `.heapprofile` per process.
- `--budget <list>`: exit code 1 when a budget is broken. A command that fails on its own keeps its exit code; one stopped with Ctrl+C or SIGTERM counts as a clean stop, so the budgets decide. Repeat the flag or separate budgets with commas; `<`, `<=`, `>`, `>=` are accepted.

| Metric | Unit | Meaning |
|---|---|---|
| `cpu.avg`, `cpu.max` | % of one core | CPU |
| `loop.p99`, `loop.max` | ms | event loop delay |
| `loop.busy` | % | event loop utilization |
| `rss.max`, `heap.max` | size | peak memory |
| `heap.growth`, `native.growth` | size/min | memory growth after GC (needs a few minutes of run) |
| `gc.pause` | % | share of time in GC pauses |
| `gc.max` | ms | longest GC pause |
| `http.p50`, `http.p99` | ms | latency of requests served |
| `http.errors` | % | failed requests served (5xx, aborted) |
| `http.rps` | /s | requests served per second |
| `http.out.p99`, `http.out.errors` | ms, % | requests made |
| `fs.p99`, `fs.sync` | ms | file system latency, time blocked by `*Sync` calls (needs `--fs`) |
| `dns.p99`, `dns.max` | ms | DNS lookups |

Units: `50ms`, `1.5s`, `512MiB`, `2GiB`, `5MiB/min`, `80%`, `100/s`. A metric the run has no data for (no HTTP traffic, a run too short for a trend) is reported as skipped, not passed.

Load test example: start the service under xray, run the load, then stop the service. SIGTERM to xray is passed on to the service; xray then prints the summary, writes the report and exits with the budgets' verdict:

```sh
xray run --cpu --report report.json --budget "loop.p99<50ms,http.p99<200ms" -- node server.js &
npx autocannon -d 60 http://localhost:3000/
kill %1 && wait %1
```

In a terminal, Ctrl+C does the same.

### Options

```
--interval <duration>     sample interval (default 1s, 250ms with the dashboard; at least 50ms)
--cpu                     CPU profiling
--heap                    allocation sampling
--fs                      file system timings
--trace-loop <duration>   trace every event loop callback for this long
--record <file>           write the raw stream
--report <file>           write the summary as JSON
--profiles <dir>          write .cpuprofile / .heapprofile per process
--ui | --open | --port    live dashboard
--budget <list>           fail on a broken budget
--inspect-port <n>        attach: the target's inspector port (default 9229)
--duration <duration>     attach: detach after this long
```

Durations: `500ms`, `10s`, `2m`; a bare number is seconds. `xray --help` lists everything.

### VS Code

Commands (Command Palette, `xray:`):

- **Profile Current File**: runs the open `.js` / `.ts` file under xray.
- **Profile a Command…**: any command, e.g. `npm start`.
- **Attach to a Running Node.js Process…**: picks from the running Node.js processes.
- **Show Dashboard**, **Stop**, **Clear Hot Lines**.

The program runs in a terminal, so its output and Ctrl+C work as usual. The dashboard opens in a tab beside the code: click a location in a table, or double-click a flame graph frame, to open that line (in the original TypeScript when source maps are there). With CPU profiling on, lines that take CPU are marked in the editor with their share, e.g. `12.3 % CPU`.

Settings: `xray.nodePath` (Node.js 22+ that runs xray), `xray.cpu` (on), `xray.heap` (off), `xray.fs` (off), `xray.hotLineThreshold` (percent of CPU work from which a line is marked, 0.5).

## Overhead

- The always-on sampler reads native counters once per interval: well under 1 % of a core.
- HTTP and DNS come from Node's own diagnostics channels and performance entries: a few microseconds per request.
- CPU profiling (1 ms sampling) and allocation sampling cost low single-digit percent; both are off unless asked for.
- `--fs` wraps the `fs` functions: a small cost per call; calls pass through unchanged.
- `--trace-loop` uses `async_hooks` with promise hooks and slows promise-heavy code noticeably, so it always runs for a limited time.

The agent measures its own main-thread time; the summary and the dashboard show it as "xray overhead".

## How it works

```
your process                         xray CLI                        viewers
  agent (preloaded or attached) ──► collector ──► terminal summary, --report, --record
  raw counters, CPU profiles,        one timeline     ──► local dashboard (SSE)
  loop trace, HTTP, fs, DNS          per process          ──► VS Code webview
```

The agent runs inside the profiled process with no dependencies and sends raw counters; everything else (rates, percentiles, flame graphs, findings) is computed by a shared core, the same code in the CLI and in the browser. See [docs/design.md](docs/design.md).

## Development

```sh
npm install
npm run build        # core → agent → dashboard → cli → vscode
npm run typecheck
npm run lint
npm test             # unit tests and end-to-end tests with real Node.js processes
npm run test:host -w node-xray     # the extension inside a real VS Code (isolated profile)
```

| Package | What it is |
|---|---|
| `packages/core` | protocol, derived metrics, flame trees, findings, reports, budgets (no Node or DOM APIs) |
| `packages/agent` | the in-process agent, bundled to one file |
| `packages/cli` | the `xray` command, collector and dashboard server |
| `packages/dashboard` | the browser dashboard |
| `packages/vscode` | the VS Code extension |

## License

MIT
