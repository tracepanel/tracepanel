import { createContext, type ReactNode, useContext } from "react";
import { AttrValue } from "./AttrValue";
import { CopyButton } from "./CopyButton";
import { keyed } from "./keys";
import { cn } from "./lib/utils";
import { rawText } from "./lib/values";

/**
 * A name and its value as it came (a word, a number, a list, a repr); `actions` are its own buttons before the copy
 * one (a filter by it), a slot each.
 */
export interface NameValue {
  name: string;
  value: unknown;
  actions?: readonly ReactNode[];
}

/**
 * The columns of names and values: names as wide as the longest, up to 24rem or 40% of the width (a longer one
 * wraps at any character, never cut), values the rest, the buttons last. Lists under headings (a trace's attributes by namespace) share them, names lined up.
 */
export const NAME_VALUE_COLUMNS = "grid grid-cols-[fit-content(min(24rem,40%))_minmax(0,1fr)_auto]";

/**
 * Where a list of names and values sits: in a card of its own (`card`, a call's fields in the call tree), or on the
 * page among a trace's facts (`plain`, its Request tab), where it takes their rows: no box, a hairline under each
 * row, names from the page's edge in a column at least as wide as the facts' names (--dt-fact-label), values from the same
 * line as theirs.
 */
export type RowsLook = "card" | "plain";
export const RowsLookContext = createContext<RowsLook>("card");

const LOOKS = {
  card: {
    row: "border-t first:border-t-0 hover:bg-muted/40",
    name: "min-w-16 py-1.5 pr-4 pl-3",
    value: "py-1.5",
    actions: "py-1 pr-2 pl-1",
  },
  plain: {
    row: "border-b",
    name: "min-w-(--dt-fact-label) py-2 pr-4",
    value: "py-2",
    actions: "py-1.5 pl-1",
  },
} as const;

/**
 * Names and values in rows, packed: a column of names, values that wrap (laid out and coloured by AttrValue, a long
 * one folded), and on hover the row's buttons, each in a slot of its own so they line up from row to row; the copy
 * one copies the value as it came. The one look of every list of names and values: a request's headers and
 * attributes, a call's fields, a log record's fields, an app's settings, a template's context, a frame's locals.
 */
export function NameValues({ rows, nested = false }: { rows: readonly NameValue[]; nested?: boolean }) {
  // As many slots in every row as the row with the most: the copy buttons line up.
  const slots = Math.max(0, ...rows.map((row) => row.actions?.length ?? 0));
  const look = LOOKS[useContext(RowsLookContext)];
  return (
    <dl className={cn("m-0 font-mono text-xs", nested ? "col-span-3 grid grid-cols-subgrid" : NAME_VALUE_COLUMNS)}>
      {keyed(rows, (row) => row.name).map(({ key, item: { name, value, actions = [] } }) => (
        <div key={key} className={cn("group/pair col-span-3 grid grid-cols-subgrid", look.row)}>
          <dt className={cn("text-muted-foreground [overflow-wrap:anywhere]", look.name)} title={name}>
            {name}
          </dt>
          <dd className={cn("m-0 min-w-0 [overflow-wrap:anywhere]", look.value)}>
            <AttrValue value={value} />
          </dd>
          <span
            className={cn(
              "flex items-start gap-0.5 opacity-0 transition-opacity group-hover/pair:opacity-100 focus-within:opacity-100",
              look.actions,
            )}
          >
            {Array.from({ length: slots }, (_, slot) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a row's slots are fixed places, never reordered.
              <span key={slot} className="flex size-5 items-center justify-center">
                {actions[slot]}
              </span>
            ))}
            <CopyButton text={rawText(value)} label={`Copy ${name}`} className="size-5" />
          </span>
        </div>
      ))}
    </dl>
  );
}
