/** Fixed-capacity FIFO: pushing into a full ring drops the oldest item. */
export class Ring<T> {
  readonly #items: Array<T | undefined>;
  #start = 0;
  #size = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
    this.#items = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.#size;
  }

  push(item: T): void {
    const end = (this.#start + this.#size) % this.capacity;
    this.#items[end] = item;
    if (this.#size < this.capacity) this.#size++;
    else this.#start = (this.#start + 1) % this.capacity;
  }

  /** Newest item. */
  last(): T | undefined {
    return this.#size === 0 ? undefined : this.#items[(this.#start + this.#size - 1) % this.capacity];
  }

  /** Oldest first. */
  toArray(): T[] {
    const out = new Array<T>(this.#size);
    for (let i = 0; i < this.#size; i++) out[i] = this.#items[(this.#start + i) % this.capacity] as T;
    return out;
  }

  clear(): void {
    this.#items.fill(undefined);
    this.#start = 0;
    this.#size = 0;
  }
}
