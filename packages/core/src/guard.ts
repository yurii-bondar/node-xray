// Narrowing of untyped input (agent messages, CDP payloads). Readers throw `ProtocolError`
// with the path of the first bad field; `parseWith` turns that into a `Parsed` result.

export class ProtocolError extends Error {
  constructor(readonly path: string, expected: string) {
    super(`${path}: expected ${expected}`);
    this.name = 'ProtocolError';
  }
}

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export function parseWith<T>(read: () => T): Parsed<T> {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    if (error instanceof ProtocolError) return { ok: false, error: error.message };
    throw error;
  }
}

type Json = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ProtocolError(path, 'finite number');
  return value;
}

export function readString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new ProtocolError(path, 'string');
  return value;
}

export function readList<T>(value: unknown, path: string, item: (value: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) throw new ProtocolError(path, 'array');
  const out: T[] = new Array<T>(value.length);
  for (let i = 0; i < value.length; i++) out[i] = item(value[i], `${path}[${i}]`);
  return out;
}

/** Typed field access over one JSON object. */
export class Fields {
  private constructor(private readonly obj: Json, readonly path: string) {}

  static of(value: unknown, path: string): Fields {
    if (!isRecord(value)) throw new ProtocolError(path, 'object');
    return new Fields(value, path);
  }

  has(key: string): boolean {
    return this.obj[key] !== undefined;
  }

  number(key: string): number {
    return readNumber(this.obj[key], this.at(key));
  }

  /** A field that older agents or some CDP versions omit. */
  numberOr(key: string, fallback: number): number {
    return this.has(key) ? this.number(key) : fallback;
  }

  /** `null` means "not available on this platform or Node version". */
  numberOrNull(key: string): number | null {
    const value = this.obj[key];
    return value === null || value === undefined ? null : this.number(key);
  }

  string(key: string): string {
    return readString(this.obj[key], this.at(key));
  }

  boolean(key: string): boolean {
    const value = this.obj[key];
    if (typeof value !== 'boolean') throw new ProtocolError(this.at(key), 'boolean');
    return value;
  }

  strings(key: string): string[] {
    return readList(this.obj[key], this.at(key), readString);
  }

  numbers(key: string): number[] {
    return readList(this.obj[key], this.at(key), readNumber);
  }

  list<T>(key: string, item: (value: unknown, path: string) => T): T[] {
    return readList(this.obj[key], this.at(key), item);
  }

  /** A nested value with its own parser (recursive structures, `T | null` fields). */
  read<T>(key: string, item: (value: unknown, path: string) => T): T {
    return item(this.obj[key], this.at(key));
  }

  fields(key: string): Fields {
    return Fields.of(this.obj[key], this.at(key));
  }

  /** Own entries, for objects used as maps (`{ Timeout: 3, TCPWrap: 2 }`). */
  entries(): Array<[string, unknown]> {
    return Object.entries(this.obj);
  }

  at(key: string): string {
    return `${this.path}.${key}`;
  }
}
