# Engineering Principles

Design principles for node-xray (TypeScript, npm workspaces: core, agent, cli, dashboard, vscode). Load this file when designing modules, reviewing abstractions, or when the task involves structural decisions.

---

## SOLID

### S — Single Responsibility
Every module, class, or function is responsible for one thing. If you struggle to name a type in one word — it does too much.

Here: `packages/core` holds all logic that does not need a platform (parsing, derivation, analysis) and imports neither `node:*` nor the DOM, so the CLI and the dashboard share it and `node --test` covers it. The agent collects and sends; it does not derive. The CLI moves bytes and serves; the dashboard renders. Entry points (`bin`, `extension.ts`) only wire.

### O — Open/Closed
Code is open for extension via interfaces and composition, closed for modification. Add new types — do not break existing ones.

In TS: extend via `interface` merging or union variants, not by patching an existing class. A new message type or insight is a new union variant plus one handler.

### L — Liskov Substitution
Any implementation of an interface must be substitutable for any other. Implement an interface fully or do not implement it at all. A partial implementation is a hidden bug. A test fake must honour the same contract as the real implementation.

### I — Interface Segregation
Small, precise interfaces beat large ones. An interface with a single method is normal and desirable. Prefer many narrow contracts over one wide one.

```typescript
// bad — caller must depend on methods it doesn't use
interface TaskStore {
  read(id: TaskId): Task | null;
  append(id: TaskId, event: TaskEvent): void;
  readTranscript(id: TaskId): string;
}

// good — split by consumer
interface TaskReader { read(id: TaskId): Task | null; }
interface TaskWriter { append(id: TaskId, event: TaskEvent): void; }
interface TranscriptReader { readTranscript(id: TaskId): string; }
```

### D — Dependency Inversion
Depend on abstractions (interfaces/types), not concrete implementations. Inject dependencies via constructor parameters or function arguments.

The candidates in this repo are the edges: sockets, file system (`/proc`), child processes (`nvidia-smi`, `sysctl`), the inspector session, clock, `vscode` API. Core logic receives them as small interfaces, so tests pass fakes instead of spawning a real process.

```typescript
// bad — hardcoded dependency
class Pipeline {
  private git = new GitClient();
}

// good — injected abstraction
interface GitRunner { run(cwd: string, args: readonly string[]): Promise<string>; }
class Pipeline {
  constructor(private readonly git: GitRunner) {}
}
```

---

## KISS — Keep It Simple

- The simplest solution that solves the task is the correct solution.
- Do not anticipate future requirements. Write code for today's task.
- If a colleague won't understand the code in 30 seconds — simplify.
- Complexity in the name of "flexibility" without a concrete need is the enemy.
- Function with 3+ positional arguments → replace with an options object. Easier to read at the call site, impossible to mix up order, easy to add fields without breaking the signature:

```typescript
// bad
function openSession(id: string, dir: string, resume: boolean, newWindow: boolean) {}

// good
interface OpenSessionArgs {
  id: string;
  dir: string;
  resume?: boolean;
  newWindow?: boolean;
}
function openSession({ id, dir, resume = false, newWindow = false }: OpenSessionArgs) {}
```

---

## DRY — Don't Repeat Yourself

- Every piece of logic exists in one place. Duplication is a source of bugs.
- But: do not abstract prematurely. Three similar lines do not always require a function — wait for the fourth.
- DRY applies to *knowledge and logic*, not syntax. Similar-looking code may express different things.

---

## YAGNI — You Aren't Gonna Need It

- Do not write code that "might be needed". Write what is needed now.
- No stubs, flags, or parameters "for the future" without a concrete use-case.
- Delete dead code immediately. It does not "might be needed" — it rots.

In `vscode` API terms: do not wrap `vscode.window` / `vscode.workspace` in an adapter "for flexibility". Introduce an interface only at a seam you actually test or swap today.

---

## OOP in TypeScript

### Encapsulation
- Private class fields via `#field` syntax (runtime-private).
- `private` modifier in TS for compile-time enforcement.
- In modules: export only what the consumer needs; keep the rest module-local.

```typescript
export function createSessionIndex() {
  const byId = new Map<SessionId, Session>(); // not exposed

  function add(session: Session): void { /* ... */ }

  return { add, get: (id: SessionId) => byId.get(id) }; // narrow public surface
}
```

### Disposables
Anything that registers a listener, watcher, timer or terminal is pushed to `context.subscriptions` or returned as a `vscode.Disposable`. A resource with no owner leaks across window reloads.

### Inheritance
Composition is usually the better choice over deep class hierarchies. Inheritance 2+ levels deep is a signal to reconsider the design.

### Polymorphism
Use TypeScript `interface`/`type` for formal contracts. Duck typing is fine for internal helpers; for module boundaries (agent ↔ CLI ↔ dashboard, extension ↔ webview), explicit interfaces prevent silent breakage.

### Abstract classes
TypeScript supports `abstract class` natively. Use it when you need shared implementation + enforced override. For pure contracts with no shared implementation, prefer `interface`.

```typescript
abstract class BaseStep {
  abstract run(task: Task): Promise<StepResult>;

  async execute(task: Task): Promise<StepResult> {
    const result = await this.run(task);
    return { ...result, finishedAt: Date.now() };
  }
}
```
