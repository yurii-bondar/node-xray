---
paths:
  - "**/*.ts"
  - "**/*.mjs"
---

# TypeScript

Always-on for every `.ts` in the repo, not just in hot-path code. Performance-specific rules live in the `ts-performance` skill.

## Safety

- **Strict tsconfig** — `strict: true` minimum. Add `noUncheckedIndexedAccess` (index access may return `undefined`) and `exactOptionalPropertyTypes` (optional field ≠ explicit `undefined`). Shared options in the root `tsconfig.base.json`; each package extends it (`tsconfig.json` for `src/`, `tsconfig.test.json` adds tests and Node types). `core` compiles with no `types` and `lib: ES2022` so it cannot touch Node or the DOM; `dashboard` uses `module: esnext`, `moduleResolution: bundler` and the DOM lib (esbuild bundles it).
- **No `any`.** `any` silently disables type checking across the entire call chain. Type external data as `unknown` and narrow immediately via type guards or explicit parsing. Situations that truly require `unknown` are rare; if you reach for it, verify the data cannot be typed at the boundary instead.
- **Boundaries of this repo** — everything below arrives untyped and is narrowed once, at the edge:
  - agent → CLI stream lines (`decodeStreamMessage`) and viewer → agent commands (`parseAgentCommand`)
  - CDP payloads (`Profiler.stop`, `HeapProfiler.getSamplingProfile`, `Runtime.bindingCalled`)
  - `/proc/*` files, `nvidia-smi` / `sysctl` / `ioreg` output in the host probe
  - recordings and files the user picks
  - SSE / webview messages, `vscode.workspace.getConfiguration().get()` results
- **One intended type.** Every parameter, return value, DTO field and exported constant has an explicit, single intended type. Do not use loose unions such as `string | boolean` when the contract can be one type — normalize at the boundary (parse, validate, map) so downstream code sees one type.
- **Exhaustive checks via `never`** — for discriminated unions, `switch` with a `default` branch assigning to a `never` variable. The compiler catches forgotten cases when new union variants are added. Stream messages, agent commands and loop categories/phases are the main candidates.
- Prefer `interface` for object contracts that may be extended; `type` for unions, mapped types and function signatures.
- Prefer small helpers, early returns, `async/await`, config objects over boolean flag parameters, and `Readonly` where practical.

## Generics

- **No generic without real variance** — if always called with the same concrete type, it's premature abstraction (YAGNI).
- **Constrain generics** (`T extends X`) — bare `<T>` loses the type safety the generic was written for.
- **Branded types for domain IDs** — `type SessionId = string & { __brand: 'SessionId' }` prevents substituting `TaskId` or `AccountId` where `SessionId` is expected, even though all are technically `string`. Same for absolute vs. relative paths.
- **Trust inference** — explicit `<T>` at call site is a signal the function signature is poorly designed.
- **3+ type parameters → split** — same as "function doesn't fit one screen", but for types.

## Package specifics

- **core:** no `node:*` imports, no DOM; `null` (not `undefined`) marks a metric unavailable on a platform, so it survives JSON.
- **agent:** must run on Node ≥ 20 targets; feature-detect newer APIs (`uvMetricsInfo`, `availableMemory`, `getBuiltinModule`) and send `null` when missing. Types of the agent's own wire output come from `core` via `import type` only, so the bundle stays dependency-free.
- **vscode:** `@types/vscode` pinned to the same range as `engines.vscode` (`~1.85.0` / `^1.85.0`); `"main"` is `./dist/extension.cjs` (the package is ESM, the extension host `require`s); `.vscodeignore` allows only the bundles, the dashboard files and the README. Messages from the webview are narrowed in `src/core/webview.ts`.
