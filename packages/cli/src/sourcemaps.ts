// Compiled locations in profiles → original sources, via the source maps next to the scripts
// (`//# sourceMappingURL=` files and inline `data:` maps). Each script's map is loaded once.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { positionKey, scriptPath, SourceMap, sourceMappingUrl, type Original, type SourcePosition } from '@node-xray/core';

export type ReadText = (file: string) => Promise<string>;


const SCRIPT = /\.(?:c|m)?js$/;
const DATA_URI = /^data:application\/json[^,]*?(;base64)?,(.*)$/s;

interface LoadedMap {
  readonly map: SourceMap;
  /** Directory relative sources resolve against. */
  readonly base: string;
}

export class SourceMapResolver {
  readonly #maps = new Map<string, Promise<LoadedMap | null>>();

  constructor(private readonly readText: ReadText) {}

  async resolve(position: SourcePosition): Promise<Original | null> {
    if (position.line <= 0) return null;
    const file = scriptPath(position.url);
    if (!path.isAbsolute(file) || !SCRIPT.test(file)) return null;
    let loading = this.#maps.get(file);
    if (loading === undefined) {
      loading = this.#load(file).catch(() => null);
      this.#maps.set(file, loading);
    }
    const loaded = await loading;
    const original = loaded?.map.lookup(position.line, position.column) ?? null;
    if (original === null || loaded === null) return null;
    return { file: this.#sourceFile(original.source, loaded.base), line: original.line, column: original.column, name: original.name };
  }

  /** Resolves many at once; the result has an entry for every position that maps somewhere. */
  async resolveAll(positions: readonly SourcePosition[]): Promise<Map<string, Original>> {
    const out = new Map<string, Original>();
    await Promise.all(
      positions.map(async (position) => {
        const original = await this.resolve(position);
        if (original !== null) out.set(positionKey(position), original);
      }),
    );
    return out;
  }

  async #load(file: string): Promise<LoadedMap | null> {
    const reference = sourceMappingUrl(await this.readText(file));
    if (reference === null) return null;
    const base = path.dirname(file);
    let json: string;
    let mapDir = base;
    const inline = DATA_URI.exec(reference);
    if (inline !== null) {
      const payload = inline[2] ?? '';
      json = inline[1] ? Buffer.from(payload, 'base64').toString('utf8') : decodeURIComponent(payload);
    } else {
      const mapFile = reference.startsWith('file://') ? fileURLToPath(reference) : path.resolve(base, decodeURIComponent(reference));
      json = await this.readText(mapFile);
      mapDir = path.dirname(mapFile);
    }
    const parsed = SourceMap.parse(JSON.parse(json) as unknown);
    return parsed.ok ? { map: parsed.value, base: mapDir } : null;
  }

  #sourceFile(source: string, base: string): string {
    if (source.startsWith('file://')) return fileURLToPath(source);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return source;
    return path.resolve(base, source);
  }
}
