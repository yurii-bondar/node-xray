// The `xray.*` settings, narrowed once: a setting edited by hand in settings.json can hold anything.

export interface XraySettings {
  /** Node.js that runs xray itself; never empty, so the terminal never falls back to a shell. */
  readonly nodePath: string;
  readonly cpu: boolean;
  readonly heap: boolean;
  readonly fs: boolean;
  /** Share of CPU work (0..1) from which a line is marked. */
  readonly hotLineShare: number;
}

const DEFAULT_THRESHOLD_PERCENT = 0.5;

const flag = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

/** `get` is `getConfiguration('xray').get`. */
export function readSettings(get: (key: string) => unknown): XraySettings {
  const nodePath = get('nodePath');
  const threshold = get('hotLineThreshold');
  const percent = typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 0 && threshold <= 100 ? threshold : DEFAULT_THRESHOLD_PERCENT;
  return {
    nodePath: typeof nodePath === 'string' && nodePath.trim() !== '' ? nodePath.trim() : 'node',
    cpu: flag(get('cpu'), true),
    heap: flag(get('heap'), false),
    fs: flag(get('fs'), false),
    hotLineShare: percent / 100,
  };
}
