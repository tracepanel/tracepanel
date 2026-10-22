import { NAME_VALUE_COLUMNS, NameValues } from "./NameValues";
import type { Attrs } from "./types";

// A trace's attributes by namespace, one look wherever they show: the Request tab's Attributes and the call tree's
// request row.

/** A key's namespace and the rest of it; a key without one is in "other", whole. */
function namespaced(key: string): [string, string] {
  const dot = key.indexOf(".");
  return dot === -1 ? ["other", key] : [key.slice(0, dot), key.slice(dot + 1)];
}

/** The attributes by namespace (`code.*`, `http.*`…), keys without it, values as they came; keys with none last. */
function grouped(attrs: Attrs): [string, { name: string; value: unknown }[]][] {
  const groups = new Map<string, { name: string; value: unknown }[]>();
  for (const [key, value] of Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b))) {
    const [space, name] = namespaced(key);
    groups.set(space, [...(groups.get(space) ?? []), { name, value }]);
  }
  return [...groups].sort(([a], [b]) => Number(a === "other") - Number(b === "other"));
}

/** A card's rows under their namespaces: a sub-heading each, names lined up across them. */
export function AttributeGroups({ attrs }: { attrs: Attrs }) {
  const groups = grouped(attrs);
  if (!groups.length) return <p className="px-3 py-2 text-xs text-muted-foreground">No other attributes.</p>;
  return (
    <div className={NAME_VALUE_COLUMNS}>
      {groups.map(([space, rows]) => (
        <section key={space} className="col-span-3 grid grid-cols-subgrid border-t first:border-t-0" aria-label={space}>
          <h4 className="col-span-3 flex items-baseline gap-1.5 border-b bg-muted/40 px-3 py-1 text-[11px] font-semibold tracking-wider text-foreground/80 uppercase">
            {space}
            <span className="font-normal text-muted-foreground tabular-nums">{rows.length}</span>
          </h4>
          <NameValues rows={rows} nested={true} />
        </section>
      ))}
    </div>
  );
}
