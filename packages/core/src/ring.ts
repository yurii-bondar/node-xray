/**
 * Bounded FIFO: pushing into a full ring drops the oldest item. Storage grows with use (the
 * array's own amortised growth) up to `capacity`, so a ring that stays small costs little.
 */
export class Ring<T> {
  /** Oldest at `#start` once full; until then `#start` is 0 and items are in push order. */
  #items: T[] = [];
  #start = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
  }

  get size(): number {
    return this.#items.length;
  }

  push(item: T): void {
    if (this.#items.length < this.capacity) {
      this.#items.push(item);
      return;
    }
    this.#items[this.#start] = item;
    this.#start = (this.#start + 1) % this.capacity;
  }

  /** Newest item. */
  last(): T | undefined {
    const size = this.#items.length;
    return size === 0 ? undefined : this.#items[(this.#start + size - 1) % size];
  }

  /** Oldest first. */
  toArray(): T[] {
    const size = this.#items.length;
    const out = new Array<T>(size);
    for (let i = 0; i < size; i++) out[i] = this.#items[(this.#start + i) % size] as T;
    return out;
  }

  clear(): void {
    this.#items = [];
    this.#start = 0;
  }
}
