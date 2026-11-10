export interface LinearFit {
  /** y units per x unit. */
  readonly slope: number;
  readonly intercept: number;
  /** Coefficient of determination, 0..1; 0 when y is constant. */
  readonly r2: number;
}

/** Least squares over paired points; `null` with fewer than two distinct x. */
export function linearFit(xs: readonly number[], ys: readonly number[]): LinearFit | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i] as number;
    sy += ys[i] as number;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] as number) - mx;
    const dy = (ys[i] as number) - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r2: syy === 0 ? 0 : (sxy * sxy) / (sxx * syy) };
}

/** Counter delta per second; 0 when the counter went backwards (process restart, wrap). */
export function ratePerSecond(previous: number, current: number, dtMs: number): number {
  if (dtMs <= 0 || current < previous) return 0;
  return ((current - previous) * 1000) / dtMs;
}
