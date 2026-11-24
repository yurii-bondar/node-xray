// Acknowledgements for an attached agent: it cannot see whether the CLI keeps up with its
// binding calls, so the CLI tells it how many payload characters arrived. Batched: at most one
// ack per interval, except that a megabyte-scale burst is acknowledged at once.

/** Runs `callback` after `ms`; returns the function that cancels it. */
export type Schedule = (callback: () => void, ms: number) => () => void;

/** The agent is told at most this often, unless `ACK_MAX_CHARS` piled up. */
export const ACK_INTERVAL_MS = 250;
/** Characters received without an ack before one goes out regardless of the interval. */
export const ACK_MAX_CHARS = 1_000_000;

export interface AckThrottleArgs {
  /** Sends the cumulative count to the agent; fire and forget. */
  readonly send: (total: number) => void;
  readonly schedule: Schedule;
}

/** One injected agent's count of received characters, and when to tell it. */
export class AckThrottle {
  readonly #send: (total: number) => void;
  readonly #schedule: Schedule;
  #received = 0;
  #acked = 0;
  #cancel: (() => void) | null = null;
  #stopped = false;

  constructor({ send, schedule }: AckThrottleArgs) {
    this.#send = send;
    this.#schedule = schedule;
  }

  /** `chars` more payload characters arrived. */
  received(chars: number): void {
    if (this.#stopped || chars <= 0) return;
    this.#received += chars;
    if (this.#received - this.#acked >= ACK_MAX_CHARS) this.#flush();
    else if (this.#cancel === null) {
      this.#cancel = this.#schedule(() => {
        this.#cancel = null;
        this.#flush();
      }, ACK_INTERVAL_MS);
    }
  }

  /** No more acks (detaching, or the thread is gone). */
  stop(): void {
    this.#stopped = true;
    this.#cancel?.();
    this.#cancel = null;
  }

  #flush(): void {
    this.#cancel?.();
    this.#cancel = null;
    if (this.#received === this.#acked) return;
    this.#acked = this.#received;
    this.#send(this.#received);
  }
}
