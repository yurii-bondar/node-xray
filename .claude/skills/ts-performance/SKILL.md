---
name: ts-performance
description: Use when writing or reviewing performance-sensitive TypeScript/Node.js code in node-xray — the agent that runs inside the profiled process (tick sampler, async_hooks loop trace, inspector profiling, message encoding), NDJSON stream decoding and Timeline ingestion in core/CLI, the dashboard's live rendering (uPlot charts, flame graph, loop lane), and later the VS Code extension host. For always-on type-safety rules (any/unknown, strict tsconfig, never-exhaustiveness), see `.claude/rules/typescript.md` — not repeated here.
---

# TypeScript Performance — node-xray hot paths

A profiler that slows down what it measures lies. The agent runs **inside someone else's process**, on its event loop, in its heap: every allocation shows up in their GC, every millisecond in their loop delay. The bottlenecks here are:

- **Agent tick** — every 250 ms–1 s, forever, in production-like load
- **Loop trace hooks** — `init` / `before` / `after` / `promiseResolve` run for *every* async operation in the target: 100k+/s on a busy server
- **Inspector profiling** — `Profiler.stop` serialises the profile on the target's main thread
- **Stream ingestion** — the CLI decodes NDJSON (multi-MB profile lines) and feeds `Timeline`s
- **Dashboard** — 4 updates/s across a dozen charts, a flame graph and a lane of thousands of blocks

Apply the patterns below in these paths. Elsewhere (CLI argument parsing, reports, config) readability wins. Measure before optimising; the agent reports its own cost (`overheadUs`), keep it visible.

---

## Agent: zero cost when idle, bounded cost when on

- Always-on tick only reads cheap native counters (`cpuUsage`, `eventLoopUtilization`, `memoryUsage`, `getHeapStatistics`, `resourceUsage`, histogram percentiles). Nothing that walks the heap or stacks.
- `setInterval(...).unref()`: the agent never keeps a process alive. The trace auto-stop timer too.
- No `*Sync` I/O after startup. `/proc/self/status` is read with async `fs.readFile`, and only on Linux.
- Expensive modes (loop trace, CPU profiling, heap sampling) are opt-in, time-limited and stopped when the CLI disconnects.
- Never throw into user code: every hook, timer and observer callback is wrapped; failures become one `agent-error` message, not a crash.
- Exclude the agent's own work from what it measures (its timers, its socket writes): track its own async ids or disable the hook around its own callbacks.
- Write to the socket without awaiting per message; if the socket is backed up (`write()` returned false), drop trace batches and count them, never queue unbounded.

---

## Loop trace hooks: no allocation per event

The hook callbacks are the hottest code in the repo. Per event: a few typed-array stores, nothing else.

```typescript
// bad — an object per callback, a Map entry per resource, a string per event
before(asyncId) { events.push({ id: asyncId, type: types.get(asyncId), start: performance.now() }); }

// good — preallocated columns, a ring index, dictionary indexes instead of strings
const START = new Float64Array(CAP), DUR = new Float64Array(CAP), TYPE = new Uint16Array(CAP), ITER = new Float64Array(CAP);
before(asyncId) { stack[depth++] = performance.now(); }
after(asyncId)  { const i = n++ & MASK; START[i] = stack[--depth]; DUR[i] = performance.now() - START[i]; TYPE[i] = typeIndexOf(asyncId); }
```

- Resource type and callback name are interned once in `init` (string → small int dictionary); events carry indexes.
- Per-type counters (created / executed / settled / busy) are plain numbers in arrays indexed by type, so they stay exact when events are dropped.
- Flush builds the columnar `loop-trace` batch (`LOOP_EVENT_STRIDE` numbers per event) once per `flushMs`, capped at `maxEventsPerFlush`.
- Do not capture stacks (`new Error().stack`) in hooks.

---

## Inspector profiling

- CPU sampling interval default 1 ms; larger windows mean bigger `Profiler.stop` payloads on the main thread. Prefer more short windows (1–5 s) and merge in `core`.
- Heap sampling interval default 32 KiB. Heap snapshots are manual only: stop-the-world and up to 2× memory.
- Only one inspector session operation in flight at a time; queue commands, do not overlap stop/start.

---

## Streaming large lines

- `LineDecoder` keeps chunk pieces and scans only new text for `\n` (a 5 MB profile in 64 KB chunks must not be rescanned 80 times). Keep it that way.
- Parse a line once at the boundary (`decodeStreamMessage`) and pass typed messages on; the CLI forwards the original line to viewers instead of re-serialising.
- Cap line length (`maxLineLength`); a peer that never sends `\n` must not grow memory without bound.

---

## Bounded state: rings, not arrays

Every history in `Timeline` is a `Ring` with a fixed capacity (frames, GC events, loop events, profile windows). Nothing in the CLI or dashboard grows with uptime. When adding a new kind of history, give it a ring and a default capacity in `DEFAULT_TIMELINE_OPTIONS`.

---

## Typed arrays and stable shapes for bulk data

- Numeric series at volume (trace columns in the agent, chart columns in the dashboard) use `Float64Array` / `Uint16Array`.
- Objects created per event or per frame get their full shape at creation (`Frame`, `LoopEvent`, flame drafts): no `delete`, no fields added later.
- Lookup tables keyed by ids, resource types or frame keys are `Map`/`Set`, not plain objects (hidden classes, `__proto__` keys).

---

## Loops in bulk processing

Over profile nodes, trace events or 3600-frame windows: classic `for` / `for...of`, iterative traversal with an explicit stack for trees from outside (CDP trees can be deep). Outside bulk loops, the functional style is fine.

---

## Dashboard rendering

- Charts get columnar data and are updated in place (`uPlot.setData`), not recreated.
- Coalesce stream updates into one render per animation frame.
- The loop lane and flame graph draw on canvas; only the visible time range is drawn; blocks narrower than a pixel are merged.
- Downsample long ranges (min/max per pixel column) before drawing.
- SSE carries the raw messages; derived data is computed in the browser by `core`, so the server never re-serialises frames.

---

## VS Code extension host (later)

- `activate()` registers commands and returns; the CLI/collector starts when a command runs.
- No `*Sync` I/O in the host; the webview gets the same SSE stream, not `postMessage` copies of the full state.
