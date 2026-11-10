# xray: real-time Node.js profiler

See what a running Node.js program is doing, live, next to its code:

- **Event loop**: every callback the loop runs (timers, I/O, immediates, nextTicks, microtasks, promises, GC pauses), grouped by loop iteration; delay, utilization and throughput.
- **CPU**: live flame graph, hot functions, and the share of CPU work **on each line in the editor**. Double-click a frame (or click a location in a table) to open the code, source-mapped to your TypeScript when maps are there.
- **Memory and GC**: heap spaces, allocation sites, every GC pause, RSS against the container limit, swap and page faults.
- **HTTP**: requests served and made (`http`, `fetch`): rates, latency percentiles, routes, slowest and stuck requests.
- **Files and DNS**: every DNS lookup; file system calls by operation and path, and the `*Sync` calls that blocked the loop (opt-in: `xray.fs`).
- **Findings**: stalls with the code that caused them, leaks (heap and off-heap growth), GC pressure, near-OOM, swapping, error spikes.

## Commands

- **xray: Profile Current File**: runs the open `.js` / `.ts` file with the agent preloaded.
- **xray: Profile a Command…**: any command (`npm start`, `node server.js`): every Node.js process and worker thread it starts is profiled.
- **xray: Attach to a Running Node.js Process…**: no restart: opens the process's inspector while attached and closes it again on Stop.
- **xray: Show Dashboard**, **xray: Stop**, **xray: Clear Hot Lines**.

The program runs in a terminal, so its output and Ctrl+C work as usual. Everything listens on 127.0.0.1 only.

## Settings

- `xray.nodePath`: Node.js that runs xray itself (22 or newer). The profiled program can use Node 20+.
- `xray.cpu` (on), `xray.heap` (off), `xray.fs` (off): what to collect from the start.
- `xray.hotLineThreshold`: percentage of CPU work from which a line gets marked (0.5).
