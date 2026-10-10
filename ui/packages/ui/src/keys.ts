/** Stable React keys for items without ids: the base key plus a counter for repeats. */
export function keyed<T>(items: readonly T[], base: (item: T) => string): { key: string; item: T }[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const key = base(item);
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    return { key: count === 0 ? key : `${key}#${count}`, item };
  });
}
