import type { ReactNode } from "react";
import { CopyButton } from "./CopyButton";

/** A name and its value; `actions` are its own buttons before the copy one (a filter by it), a slot each. */
export interface NameValue {
  name: string;
  value: string;
  actions?: readonly ReactNode[];
}

/**
 * Names and values in rows, packed: a column of names, values that wrap, and on hover the row's buttons, each in a
 * slot of its own so they line up from row to row. The one look of a request's headers, a log record's fields and
 * any list like them.
 */
export function NameValues({ rows }: { rows: readonly NameValue[] }) {
  // As many slots in every row as the row with the most: the copy buttons line up.
  const slots = Math.max(0, ...rows.map((row) => row.actions?.length ?? 0));
  return (
    <dl className="m-0 grid grid-cols-[minmax(7rem,11rem)_minmax(0,1fr)_auto] font-mono text-xs">
      {rows.map(({ name, value, actions = [] }) => (
        <div
          key={`${name}=${value}`}
          className="group/pair col-span-3 grid grid-cols-subgrid border-t first:border-t-0 hover:bg-muted/40"
        >
          <dt className="truncate py-1.5 pr-4 pl-3 text-muted-foreground" title={name}>
            {name}
          </dt>
          <dd className="m-0 py-1.5 [overflow-wrap:anywhere]">{value}</dd>
          <span className="flex items-start gap-0.5 py-1 pr-2 pl-1 opacity-0 transition-opacity group-hover/pair:opacity-100 focus-within:opacity-100">
            {Array.from({ length: slots }, (_, slot) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a row's slots are fixed places, never reordered.
              <span key={slot} className="flex size-5 items-center justify-center">
                {actions[slot]}
              </span>
            ))}
            <CopyButton text={value} label={`Copy ${name}`} className="size-5" />
          </span>
        </div>
      ))}
    </dl>
  );
}
