/**
 * Share of `part` in `total` as a whole percent: "12%". A share that is neither none nor all never rounds to
 * either: 1 of 389 reads "<1%", 388 of 389 ">99%".
 */
export function percent(part: number, total: number): string {
  if (total <= 0 || part <= 0) return "0%";
  if (part >= total) return "100%";
  const rounded = Math.round((part / total) * 100);
  if (rounded === 0) return "<1%";
  if (rounded === 100) return ">99%";
  return `${rounded}%`;
}

/** Share of `part` in `total` as a CSS width or offset: "12.5%", not rounded. */
export function widthOf(part: number, total: number): string {
  return total > 0 ? `${(part / total) * 100}%` : "0%";
}

/**
 * Values rounded to `step` so they add up to `target` steps: each rounded down, the steps left given to those that
 * lost most (largest remainder), the first of them on a tie. What parts of a total are said as, so the parts said add
 * up to the total said: times (lib/timeShares) and percentages (percents).
 */
export function apportion(values: readonly number[], step: number, target: number): number[] {
  const floors = values.map((value) => Math.floor(value / step + 1e-9));
  let left = target - floors.reduce((sum, steps) => sum + steps, 0);
  const order = values
    .map((_, at) => at)
    .sort((a, b) => remainder(values, b, step) - remainder(values, a, step) || a - b);
  for (const at of order) {
    if (left <= 0) break;
    floors[at] = (floors[at] ?? 0) + 1;
    left -= 1;
  }
  return floors.map((steps) => steps * step);
}

function remainder(values: readonly number[], at: number, step: number): number {
  const value = (values[at] ?? 0) / step;
  return value - Math.floor(value + 1e-9);
}

/**
 * The shares of `total` that `parts` are, as whole percents that add up as the parts do (100% for parts that make the
 * whole): rounded by largest remainder, so a legend of 7, 3, 2 and 125 ms of 137 reads 5%, 2%, 2%, 91%, not 99% in
 * all. A share that is neither none nor all still never reads either: "<1%", ">99%".
 */
export function percents(parts: readonly number[], total: number): string[] {
  if (total <= 0) return parts.map(() => "0%");
  const exact = parts.map((part) => (Math.max(part, 0) / total) * 100);
  const whole = apportion(exact, 1, Math.round(exact.reduce((sum, each) => sum + each, 0)));
  return parts.map((part, at) => {
    const said = whole[at] ?? 0;
    if (part <= 0) return "0%";
    if (part >= total) return "100%";
    if (said <= 0) return "<1%";
    return said >= 100 ? ">99%" : `${said}%`;
  });
}
