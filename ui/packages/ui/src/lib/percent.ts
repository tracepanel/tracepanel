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
