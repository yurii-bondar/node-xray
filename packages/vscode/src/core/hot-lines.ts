// The CLI's `/api/lines` answer → marks for one file in the editor.

import { pathKey } from './paths.js';

export interface LinesAnswer {
  /** CPU samples that were work, over all processes: the denominator. */
  readonly work: number;
  /** `pathKey` of a local file → line (1-based) → samples. */
  readonly files: ReadonlyMap<string, ReadonlyMap<number, number>>;
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function addTicks(files: Map<string, Map<number, number>>, file: string, line: number, ticks: number): void {
  let byLine = files.get(file);
  if (byLine === undefined) {
    byLine = new Map();
    files.set(file, byLine);
  }
  byLine.set(line, (byLine.get(line) ?? 0) + ticks);
}

/** Null unless `{ work, files: [{ file, lines: [[line, ticks]] }] }`; malformed entries are skipped. Files are keyed by `pathKey`. */
export function parseLinesAnswer(value: unknown, platform: string): LinesAnswer | null {
  if (typeof value !== 'object' || value === null) return null;
  const work: unknown = Reflect.get(value, 'work');
  const files: unknown = Reflect.get(value, 'files');
  if (!isCount(work) || !Array.isArray(files)) return null;
  const out = new Map<string, Map<number, number>>();
  for (const entry of files as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const file: unknown = Reflect.get(entry, 'file');
    const lines: unknown = Reflect.get(entry, 'lines');
    if (typeof file !== 'string' || file === '' || !Array.isArray(lines)) continue;
    const key = pathKey(file, platform);
    for (const pair of lines as unknown[]) {
      if (!Array.isArray(pair)) continue;
      const [line, ticks] = pair as unknown[];
      if (typeof line === 'number' && Number.isInteger(line) && line >= 1 && isCount(ticks)) addTicks(out, key, line, ticks);
    }
  }
  return { work, files: out };
}

/** Several runs at once: their samples added up, so a share is of all the work being profiled. */
export function mergeLinesAnswers(answers: Iterable<LinesAnswer>): LinesAnswer | null {
  let work = 0;
  let count = 0;
  const files = new Map<string, Map<number, number>>();
  for (const answer of answers) {
    count++;
    work += answer.work;
    for (const [file, byLine] of answer.files) for (const [line, ticks] of byLine) addTicks(files, file, line, ticks);
  }
  return count === 0 ? null : { work, files };
}

export type HotTier = 'hot' | 'warm' | 'mild';

export interface HotMark {
  /** 1-based. */
  readonly line: number;
  /** Share of all CPU work, 0..1. */
  readonly share: number;
  readonly tier: HotTier;
}

export function tierOf(share: number): HotTier {
  return share >= 0.1 ? 'hot' : share >= 0.02 ? 'warm' : 'mild';
}

export interface HotMarksArgs {
  readonly answer: LinesAnswer;
  /** `pathKey` of the file in the editor. */
  readonly fileKey: string;
  /** 0..1. */
  readonly minShare: number;
}

/** Lines of the file taking at least `minShare` of the work, heaviest first. */
export function hotMarks({ answer, fileKey, minShare }: HotMarksArgs): HotMark[] {
  const lines = answer.files.get(fileKey);
  if (lines === undefined || answer.work <= 0) return [];
  const out: HotMark[] = [];
  for (const [line, ticks] of lines) {
    const share = ticks / answer.work;
    if (share >= minShare) out.push({ line, share, tier: tierOf(share) });
  }
  return out.sort((a, b) => b.share - a.share);
}

export function markText(mark: HotMark): string {
  return `${(mark.share * 100).toFixed(1)} % CPU`;
}
