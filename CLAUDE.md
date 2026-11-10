# node-xray

Real-time profiler for a running Node.js process: event loop (down to individual callbacks per iteration), heap, GC, CPU flame graph, allocations, RAM / swap / CPU / GPU. One repo, npm workspaces, one core, three faces: CLI with a local web dashboard first, the VS Code extension last. Design and roadmap: `docs/design.md`; read it before structural changes.

| Package | Role | State |
|---|---|---|
| `packages/core` | pure, isomorphic logic: wire protocol (`protocol.ts` parsed, `wire.ts` as sent), record format (`record.ts`, shared by `--record`, SSE and replay), profile export (`export.ts`), baseline diff (`diff.ts`), HTTP ticks, route normalisation and percentiles (`http.ts`), file system and DNS ticks (`io.ts`), source map parsing (`sourcemap.ts`), NDJSON framing, derived frames, loop trace (iterations, queues), flame trees, insights, `Timeline`, run reports, budgets (`budgets.ts`), units and finding texts (`text.ts`) | done |
| `packages/agent` | runs **inside the target process**, preloaded (`dist/agent.cjs`, `xray run`) or loaded through the inspector (`dist/attach.cjs`, `xray attach`; messages via a CDP binding): tick sampler, loop trace (async_hooks), in-process `node:inspector` profiling, HTTP monitor (`diagnostics_channel`), DNS (`dns` performance entries) and opt-in fs timing (wraps the `fs` functions, `io-monitor.ts`); Node ≥ 20, zero dependencies, bundled by esbuild (core included) | done |
| `packages/cli` | `xray` binary: `run`, `attach <pid>` and `replay <file>` (shared `session.ts`, `--budget` on all three; `attach` drives the target over CDP, `cdp.ts`, and each worker thread through the `NodeWorker` domain) with launcher, socket collector, host probe for swap/GPU, source map resolver, `--record`, `--report`, `--profiles`, terminal summary) and `--ui` / `--open` (dashboard server: static files, SSE stream with a bounded backlog, `POST /api/command`, `POST /api/resolve`, `GET /api/export`; 127.0.0.1, token, Host check); next: the VS Code extension | `run`, `attach`, `replay`, budgets, dashboard server done |
| `packages/dashboard` | browser UI bundled by esbuild to `dist/` (`app.js`, uPlot inside): tiles, findings, event loop lane (one block per callback, iterations, queues), uPlot charts, canvas flame graph, heap spaces, allocations, GC, system/GPU. Pure logic (`store`, `series`, `lane-layout`, `flame-layout`) is tested with `node --test`; DOM code is not | done |
| `packages/vscode` | VS Code extension: Profile Current File / a Command / Attach, the CLI run as the terminal's process (no shell), the dashboard in a webview iframe (`?host=vscode`: click a location or double-click a frame to open the code, source-mapped), hot lines in the editor from `/api/lines`. The `.vsix` carries the CLI bundled to one file (`dist/xray/cli.mjs`) with the agent bundles and the dashboard next to it (`cli/src/assets.ts` finds them). Pure logic in `src/core`; `npm run test:host` drives the commands in a real VS Code with an isolated profile | done |

Data flow: agent → NDJSON over a Unix socket → CLI → SSE → dashboard. Agents send raw cumulative counters; every derivation lives in `core`, and both the CLI and the dashboard run `core.Timeline` on the same messages.

## Setup and scripts

Root (all workspaces, in dependency order core → agent → dashboard → cli → vscode): `npm install`, `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`. Run all four before a commit or PR. The tool itself needs Node ≥ 22; the agent must keep working in targets on Node ≥ 20.

Try it after a build: `npx xray run --open --cpu --heap -- node app.js` (live dashboard; stays up after the command exits until Ctrl+C), or without `--open`/`--ui` for the terminal summary only (`--report r.json`, `--record r.xray.jsonl`). Agent tests and CLI tests spawn real Node processes against the built bundle.

Per package: ESM (`"type": "module"`, `module: nodenext`, imports end in `.js`). `tsconfig.json` covers `src/` and emits `dist/src`; `tsconfig.test.json` adds `test/` and Node types; `npm test` builds the tests and runs `node --test dist/test/*.test.js`. Compiler options live in the root `tsconfig.base.json`; a package's `tsconfig.json` sets only `outDir`, `rootDir`, `include` and what differs (`types`, `lib`). Exceptions: `dashboard` is browser code bundled by esbuild (`module: esnext`, `moduleResolution: bundler`, DOM lib); `vscode` is bundled by esbuild too (`dist/extension.cjs`, `vscode` external) and typechecks with `moduleResolution: bundler`; both compile their tests to `dist/node/`. `npm run package` in `packages/vscode` builds the `.vsix`.

## Rules and skills

| File | Covers |
|---|---|
| `.claude/rules/git.md` | commit format with package scope, semantic-release, no AI attribution |
| `.claude/rules/typescript.md` | strict tsconfig, no `any`, boundaries of this repo, branded IDs |
| `.claude/rules/principles.md` | SOLID/KISS/DRY/YAGNI here: isomorphic core, injected edges, thin entry points |
| `.claude/skills/ts-performance` | the agent's hot paths (it runs in someone else's process), loop trace hooks, stream decoding, dashboard rendering, extension host |

## Writing code

Hold every change to `typescript.md` and `principles.md`:
- Match the surrounding style (naming, comment density, how neighbouring modules solve the same thing).
- **core** imports neither `node:*` nor the DOM (eslint enforces it). Anything platform-specific is passed in by the caller.
- **agent** runs inside the user's process: no dependencies, no `*Sync` I/O after startup (one exception: on process exit the last messages are written synchronously, bounded, because the loop never runs again), `unref()` every timer, never throw into user code (catch and report as `agent-error`), measure and report its own CPU (`overheadUs`). Expensive modes (loop trace, CPU profiling, heap sampling) are opt-in and time-limited.
- Data from outside arrives as `unknown` and is narrowed once, at the boundary: agent messages (`parseStreamMessage`), commands (`parseAgentCommand`), CDP payloads, `/proc` files, `nvidia-smi` / `sysctl` output, files the user picks, VS Code settings. Downstream code sees one shape.
- A wire format change updates `core/src/protocol.ts`, its parser and tests in the same commit; bump `PROTOCOL_VERSION` when an old agent can no longer talk to a new CLI.
- Everything listens on `127.0.0.1` only; the inspector executes arbitrary code: `attach` closes any inspector it opened, also when attaching fails, and never sends SIGUSR1 to a process that is not a Node binary. The dashboard server checks the `Host` header and the per-run token on every `/api` request; commands are JSON only.
- fs timing changes the application's `fs` functions, so it is opt-in and every wrapper must hand the call through unchanged: same arguments, `this`, return value and errors; own properties copied (`util.promisify.custom`); promises wrapped by returning a derived promise (never subscribe to the original: that would hide the app's unhandled rejections); nested sync calls timed once; stopping restores only functions nobody wrapped on top.
- Subscribers on `diagnostics_channel` run on the application's request path: only note times there (no allocation-heavy work, no I/O), aggregate on the tick, and wrap every subscriber in `try/catch` (a throwing subscriber becomes an uncaught exception in the app).
- Dashboard: text from the target (function names, paths) goes through `textContent`, never `innerHTML`; colours come from the CSS tokens on `:root` in `static/app.css` (canvases resolve them once per frame, not per block).
- Functions with 3+ positional parameters take an options object.
- Add a test in the package's `test/` for logic changes.
- Delete dead code. No flags or parameters "for the future".
