// The agent lives in someone else's process. Everything it runs goes through `SelfWork.run`:
// errors never reach user code, and the loop tracer can tell the agent's own async work apart.

export class SelfWork {
  #depth = 0;
  /** Timers and other handles the agent created; the tracer skips their callbacks. */
  readonly resources = new WeakSet<object>();

  constructor(private readonly onError: (error: unknown) => void) {}

  /** True while agent code is on the stack. */
  get active(): boolean {
    return this.#depth > 0;
  }

  run(work: () => void): void {
    this.#depth++;
    try {
      work();
    } catch (error) {
      this.#report(error);
    } finally {
      this.#depth--;
    }
  }

  /** Marks a handle as the agent's own and returns it. */
  own<T extends object>(handle: T): T {
    this.resources.add(handle);
    return handle;
  }

  report(error: unknown): void {
    this.#report(error);
  }

  #report(error: unknown): void {
    try {
      this.onError(error);
    } catch {
      // Reporting failed too: stay silent rather than disturb the host process.
    }
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
