// CPU samples per source line, from the `positionTicks` of CPU profiles: what the editor shows
// next to the code. Accumulated over every window of a run.

import type { CpuProfile } from './cdp.js';
import { scriptPath } from './flame.js';

const NOT_WORK: ReadonlySet<string> = new Set(['(root)', '(idle)', '(program)']);

export interface HotLines {
  /** Samples that were work (idle and program time left out): the denominator of line shares. */
  readonly work: number;
  /** Script URL as V8 names it → line (1-based) → samples. */
  readonly files: ReadonlyMap<string, ReadonlyMap<number, number>>;
}

export class LineTicks {
  readonly #files = new Map<string, Map<number, number>>();
  #work = 0;

  /** Adds one profile window; frames of `excludeScript` (the agent) count neither as lines nor as work. */
  add(profile: CpuProfile, excludeScript: string): void {
    const excluded = excludeScript === '' ? null : scriptPath(excludeScript);
    for (const node of profile.nodes) {
      const { functionName, url } = node.callFrame;
      if (NOT_WORK.has(functionName)) continue;
      if (excluded !== null && url !== '' && scriptPath(url) === excluded) continue;
      this.#work += node.hitCount;
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
