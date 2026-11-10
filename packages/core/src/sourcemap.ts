// Source map v3: generated position (compiled JS) → original position (TypeScript, pre-bundle).
// Parsing and lookup only; reading the files is the caller's job.

import { Fields, ProtocolError, parseWith, readString, type Parsed } from './guard.js';

/** A position in a script as profiles report it (`url` as V8 names the script, 1-based). */
export interface SourcePosition {
  readonly url: string;
  readonly line: number;
  readonly column: number;
}

/** Where a compiled position came from: what the CLI's resolver returns, keyed by `positionKey`. */
export interface Original {
  /** Absolute path when the map points at a file, else the source as the map names it (`webpack://...`). */
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly name: string | null;
}

/** One key per position, shared by the CLI's `/api/resolve` answer and the dashboard's cache. */
export function positionKey(position: SourcePosition): string {
  return `${position.url}:${position.line}:${position.column}`;
}

export interface OriginalPosition {
  /** `sourceRoot` + the source entry, as written in the map (often relative to the map file). */
  readonly source: string;
  /** 1-based. */
  readonly line: number;
  readonly column: number;
  /** Original identifier at that position, when the map names it. */
  readonly name: string | null;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGIT = new Map<string, number>([...BASE64].map((char, i) => [char, i]));

/** Base64 VLQ values of one segment (`AAgBC` → [0, 0, 16, 1]). */
export function decodeVlq(segment: string): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = DIGIT.get(char);
    if (digit === undefined) throw new Error(`invalid VLQ character '${char}'`);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    out.push(value & 1 ? -(value >>> 1) : value >>> 1);
    value = 0;
    shift = 0;
  }
  if (shift !== 0) throw new Error('unterminated VLQ value');
  return out;
}

/** One mapping segment, absolute values. Columns 0-based. */
interface Segment {
  readonly column: number;
  readonly source: number;
  readonly line: number;
  readonly sourceColumn: number;
  readonly name: number;
}

export class SourceMap {
  private constructor(
    private readonly sources: readonly string[],
    private readonly names: readonly string[],
    /** Per generated line, segments sorted by column; only segments that map to a source. */
    private readonly lines: readonly (readonly Segment[])[],
  ) {}

  /** A v3 map (`{ version: 3, sources, names, mappings }`); index maps with `sections` are not supported. */
  static parse(value: unknown): Parsed<SourceMap> {
    return parseWith(() => {
      const f = Fields.of(value, '$');
      if (f.number('version') !== 3) throw new ProtocolError(f.at('version'), 'version 3');
      if (f.has('sections')) throw new ProtocolError(f.at('sections'), 'a plain map (index maps are not supported)');
      const root = f.has('sourceRoot') ? f.string('sourceRoot') : '';
      const prefix = root === '' || root.endsWith('/') ? root : `${root}/`;
      const sources = f.list('sources', (v, path) => (v === null ? '' : readString(v, path))).map((s) => (s === '' ? s : prefix + s));
      const names = f.has('names') ? f.strings('names') : [];
      let lines: Segment[][];
      try {
        lines = decodeMappings(f.string('mappings'));
      } catch (error) {
        throw new ProtocolError(f.at('mappings'), `valid mappings (${error instanceof Error ? error.message : String(error)})`);
      }
      return new SourceMap(sources, names, lines);
    });
  }

  /** `line` and `column` are 1-based positions in the generated file, as profiles report them. */
  lookup(line: number, column: number): OriginalPosition | null {
    const segments = this.lines[line - 1];
    if (segments === undefined || segments.length === 0) return null;
    const target = Math.max(0, column - 1);
    // Last segment starting at or before the column.
    let lo = 0;
    let hi = segments.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if ((segments[mid] as Segment).column <= target) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    // A frame often points at the function's first token, just before the first segment.
    const segment = segments[found === -1 ? 0 : found] as Segment;
    const source = this.sources[segment.source];
    if (source === undefined) return null;
    return { source, line: segment.line + 1, column: segment.sourceColumn + 1, name: segment.name >= 0 ? (this.names[segment.name] ?? null) : null };
  }
}

function decodeMappings(mappings: string): Segment[][] {
  const lines: Segment[][] = [];
  let source = 0;
  let line = 0;
  let sourceColumn = 0;
  let name = 0;
  for (const text of mappings.split(';')) {
    const segments: Segment[] = [];
    let column = 0;
    for (const raw of text.split(',')) {
      if (raw === '') continue;
      const v = decodeVlq(raw);
      column += v[0] ?? 0;
      if (v.length < 4) continue; // maps generated code to nothing
      source += v[1] as number;
      line += v[2] as number;
      sourceColumn += v[3] as number;
      let nameIndex = -1;
      if (v.length >= 5) {
        name += v[4] as number;
        nameIndex = name;
      }
      segments.push({ column, source, line, sourceColumn, name: nameIndex });
    }
    segments.sort((a, b) => a.column - b.column);
    lines.push(segments);
  }
  return lines;
}

/** `//# sourceMappingURL=...` on the last line of a script (inline `data:` maps included); null when absent. */
export function sourceMappingUrl(script: string): string | null {
  const text = script.trimEnd();
  const lastLine = text.slice(text.lastIndexOf('\n') + 1);
  return /^\/\/[#@]\s*sourceMappingURL=(\S+)$/.exec(lastLine)?.[1] ?? null;
}
