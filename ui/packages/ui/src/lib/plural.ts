/** A count and its noun, one or many: "1 task", "3 tasks", "1,204 traces". */
export function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}
