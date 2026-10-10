import { type PropRow, PropTable } from "./PropTable";
import type { Attrs } from "./types";

function group(key: string): [string, string] {
  const dot = key.indexOf(".");
  return dot === -1 ? ["other", key] : [key.slice(0, dot), key.slice(dot + 1)];
}

/**
 * Attributes grouped by namespace (`http.*`, `graphql.*`, `user.*`…), always visible: one table with a heading per
 * group, keys without the prefix, in the same type as the rows above it.
 */
export function AttrsTable({ attrs }: { attrs: Attrs }) {
  const groups = new Map<string, PropRow[]>();
  for (const [key, value] of Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b))) {
    const [name, rest] = group(key);
    const shown = value === null ? null : String(value);
    groups.set(name, [
      ...(groups.get(name) ?? []),
      {
        id: key,
        label: name === "other" ? key : rest,
        value: shown ?? <span className="text-muted-foreground">null</span>,
        copy: shown,
        mono: true,
      },
    ]);
  }
  if (groups.size === 0) return <p className="dt-empty">No attributes.</p>;
  // Keys without a namespace come last.
  const ordered = [...groups].sort(([a], [b]) => Number(a === "other") - Number(b === "other"));
  return (
    <PropTable
      rows={ordered.flatMap(([name, rows]) => [
        { id: `group:${name}`, label: name, heading: true, value: rows.length },
        ...rows,
      ])}
    />
  );
}
