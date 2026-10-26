// A trace's calls to one system as the console lists anything: its DB, Cache and HTTP calls tabs are tables with the
// console's head and hairline rows (DataTable), a row's details opened under it as a log record's are, and those
// details laid out as the call tree's.

import { Fragment, type KeyboardEvent, type MouseEvent, type ReactNode, useState } from "react";
import { TableCell, TableRow } from "./components/ui/table";
import { type DataColumn, DataTable } from "./DataTable";
import { duration } from "./format";
import { focusMark, useScrollToFocus } from "./hooks/useScrollToFocus";
import { percent } from "./lib/percent";
import { cn } from "./lib/utils";

// A failed call marks its row's edge red, as the console's lists mark theirs; one an issue points at is highlighted.
const ROW = cn(
  "cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
  "data-focused:bg-brand-soft/60",
  "data-[tone=error]:[&>td:first-child]:shadow-[inset_3px_0_0_var(--color-error)]",
);

/** Whether a click in a row opens it: anywhere but a link or a button in it, and not the end of selecting its text. */
function opens(event: MouseEvent): boolean {
  if (window.getSelection()?.toString()) return false;
  return !(event.target as Element).closest("a, button, [role=separator]");
}

function onRowKey(event: KeyboardEvent<HTMLTableRowElement>, onToggle: () => void) {
  if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
  event.preventDefault();
  onToggle();
}

/** What the table needs of a row: its key, its edge, whether an issue points at it, what opens under it. */
export interface CallRowOf<T> {
  key: (item: T) => string;
  failed?: ((item: T) => boolean) | undefined;
  focused: (item: T) => boolean;
  details: (item: T) => ReactNode;
}

/**
 * The calls, a row each, in the reader's columns (kept under `table`); a click, Enter or Space opens a row's details
 * under it. Rows an issue points at are highlighted, scrolled to, and open when `openFocused`.
 */
export function CallTable<T>({
  table,
  columns,
  items,
  row,
  focus,
  openFocused = true,
}: {
  table: string;
  columns: readonly DataColumn<T>[];
  items: readonly T[];
  row: CallRowOf<T>;
  focus: ReadonlySet<string> | undefined;
  openFocused?: boolean | undefined;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set(openFocused ? items.filter(row.focused).map(row.key) : []),
  );
  const toggle = (key: string) => {
    const next = new Set(open);
    if (!next.delete(key)) next.add(key);
    setOpen(next);
  };
  const body = useScrollToFocus<HTMLDivElement>(focus);
  return (
    <div ref={body}>
      <DataTable table={table} columns={columns} boxed={false} stickyHeader={false}>
        {({ cells, span }) =>
          items.map((item) => {
            const key = row.key(item);
            const opened = open.has(key);
            return (
              <Fragment key={key}>
                <TableRow
                  {...focusMark(row.focused(item))}
                  data-tone={row.failed?.(item) ? "error" : undefined}
                  tabIndex={0}
                  aria-expanded={opened}
                  className={ROW}
                  onClick={(event) => opens(event) && toggle(key)}
                  onKeyDown={(event) => onRowKey(event, () => toggle(key))}
                >
                  {cells(item)}
                </TableRow>
                {opened ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={span} className="bg-muted/40 p-0 whitespace-normal">
                      <div className="grid gap-4 px-6 py-4">{row.details(item)}</div>
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            );
          })
        }
      </DataTable>
    </div>
  );
}

/** The columns every such table ends with: how long, and its share of the system's time in the request. */
export function timeColumns<T>(time: (item: T) => number, total: number): DataColumn<T>[] {
  return [
    { id: "time", label: "Time", width: 6.5, fixed: true, num: true, cell: (item) => duration(time(item)) },
    {
      id: "share",
      label: "Share",
      width: 5.5,
      num: true,
      drop: 1,
      className: "text-muted-foreground",
      cell: (item) => percent(time(item), total),
    },
  ];
}

/** What an open row's details start with, as the call tree's do: what it is, how many, how long. */
export function DetailsTitle({ children }: { children: ReactNode }) {
  return <p className="dt-map-details-title">{children}</p>;
}

/** One line of an open row's list of calls (where each was made, its time): the hairline rows of a call's fields. */
export function CallLine({
  index,
  focused,
  time,
  children,
}: {
  index: number;
  focused: boolean;
  time: number;
  children: ReactNode;
}) {
  return (
    <li
      className={cn(
        "grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 border-b py-2 text-sm",
        focused && "bg-brand-soft",
      )}
    >
      <span className="text-right text-muted-foreground tabular-nums">{index + 1}</span>
      {children}
      <span className="tabular-nums">{duration(time)}</span>
    </li>
  );
}

/** The list of an open row's calls, under its heading. */
export function CallLines({ heading, children }: { heading: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-1">
      {heading}
      <ol className="m-0 grid list-none p-0">{children}</ol>
    </section>
  );
}
