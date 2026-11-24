// CPU samples per source line, from the `positionTicks` of CPU profiles: what the editor shows
// next to the code. Accumulated over every window of a run.

import type { CpuProfile, CpuProfileNode } from './cdp.js';
import { indexProfile, NOT_WORK, scriptPath } from './flame.js';

export interface HotLines {
  /** Samples that were work (idle and program time left out): the denominator of line shares. */
  readonly work: number;
  /** Script URL as V8 names it → line (1-based) → samples. */
  readonly files: ReadonlyMap<string, ReadonlyMap<number, number>>;
}

export class LineTicks {
  readonly #files = new Map<string, Map<number, number>>();
  #work = 0;

  /**
   * Adds one profile window. Frames of `excludeScript` (the agent) and everything they called count
   * neither as lines nor as work, and samples are counted as `cpuFlame` counts them, so line shares
   * match the flame graph without the agent (`withoutScript`).
   */
  add(profile: CpuProfile, excludeScript: string): void {
    const excluded = excludeScript === '' ? null : scriptPath(excludeScript);
    const { byId, root, hits } = indexProfile(profile);
    const stack: CpuProfileNode[] = root === undefined ? [] : [root];
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
      const { functionName, url } = node.callFrame;
      if (excluded !== null && url !== '' && scriptPath(url) === excluded) continue;
      for (const id of node.children) {
        const next = byId.get(id);
        if (next !== undefined) stack.push(next);
      }
      if (NOT_WORK.has(functionName)) continue;
      this.#work += hits.get(node.id) ?? 0;
      if (url === '' || node.positionTicks.length === 0) continue;
      let lines = this.#files.get(url);
      if (lines === undefined) {
        lines = new Map();
        this.#files.set(url, lines);
      }
      for (const { line, ticks } of node.positionTicks) lines.set(line, (lines.get(line) ?? 0) + ticks);
    }
  }

  snapshot(): HotLines {
    return { work: this.#work, files: this.#files };
  }
}
