// The CLI's `/api/lines` answer → marks for one file in the editor.

export interface LinesAnswer {
  /** CPU samples that were work, over all processes: the denominator. */
  readonly work: number;
  /** Local file path → line (1-based) → samples. */
  readonly files: ReadonlyMap<string, ReadonlyMap<number, number>>;
}

export function parseLinesAnswer(value: unknown): LinesAnswer | null {
  if (typeof value !== 'object' || value === null) return null;
  const work: unknown = Reflect.get(value, 'work');
  const files: unknown = Reflect.get(value, 'files');
  if (typeof work !== 'number' || !Array.isArray(files)) return null;
  const out = new Map<string, Map<number, number>>();
  for (const entry of files as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const file: unknown = Reflect.get(entry, 'file');
    const lines: unknown = Reflect.get(entry, 'lines');
    if (typeof file !== 'string' || !Array.isArray(lines)) continue;
    const byLine = new Map<number, number>();
    for (const pair of lines as unknown[]) {
      if (!Array.isArray(pair)) continue;
      const [line, ticks] = pair as unknown[];
      if (typeof line === 'number' && typeof ticks === 'number') byLine.set(line, ticks);
    }
    out.set(file, byLine);
  }
  return { work, files: out };
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

/** Lines of `file` taking at least `minShare` (0..1) of the work, heaviest first. */
export function hotMarks(answer: LinesAnswer, file: string, minShare: number): HotMark[] {
  const lines = answer.files.get(file);
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
