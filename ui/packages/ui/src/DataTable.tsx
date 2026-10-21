// A list of records as every list of the console shows them: a boxed table whose columns the reader drags wider,
// hides, brings back from the columns menu and moves, kept per browser per list. The logs table is the same, with
// rows of its own (LogTable).

import { cn } from "@tracepanel/ui/lib/utils";
import type { ReactNode } from "react";
import { Table, TableBody, TableCell } from "./components/ui/table";
import { type ColumnSpec, useColumns } from "./hooks/useColumns";
import { bodyCell, ColumnsHeader, type Density, MENU_REM, useColumnWidths } from "./TableColumns";

/** A column of a list: its spec, and what its cell shows for an item. */
export interface DataColumn<T> extends ColumnSpec {
  cell: (item: T) => ReactNode;
  /** The cell's own classes, the same for every item or by item (a count in red when there is one). */
  className?: string | ((item: T) => string | undefined) | undefined;
}

/** What the rows get from the table: an item's cells, in the reader's columns, and how many columns a row spans. */
export interface DataRows<T> {
  cells: (item: T) => ReactNode;
  span: number;
}

function classOf<T>(column: DataColumn<T>, item: T): string | undefined {
  return typeof column.className === "function" ? column.className(item) : column.className;
}

/** An item's cells: one per shown column, then the columns menu's, empty. */
function Cells<T>({ item, shown, density }: { item: T; shown: readonly DataColumn<T>[]; density: Density }) {
  return (
    <>
      {shown.map((column) => (
        <TableCell
          key={column.id}
          className={cn(bodyCell(density), "truncate", column.num && "text-right tabular-nums", classOf(column, item))}
        >
          {column.cell(item)}
        </TableCell>
      ))}
      <TableCell className="p-0" />
    </>
  );
}

/**
 * The columns `columns` lists, as the reader left them in this browser (kept under `table`, one key per list), and
 * the rows `children` draws from them: each row a `TableRow` (or the console's own row) around `cells(item)`. The
 * column without a width takes what the others leave: the list's main column, `required`, so it can't be hidden.
 */
export function DataTable<T>({
  table,
  columns,
  stickyHeader = false,
  density = "default",
  children,
}: {
  table: string;
  columns: readonly DataColumn<T>[];
  /** Keeps the header in view while the page scrolls under it. */
  stickyHeader?: boolean | undefined;
  /** How tall the rows are: `compact` for a stream of records read many lines at once. */
  density?: Density | undefined;
  children: (rows: DataRows<T>) => ReactNode;
}) {
  const arranged = useColumns(table, columns);
  const { ref, widths } = useColumnWidths(arranged, MENU_REM);
  const shown = arranged.shown;
  const rows: DataRows<T> = {
    cells: (item) => <Cells item={item} shown={shown} density={density} />,
    span: shown.length + 1,
  };
  return (
    // Clipped, not hidden: a sticky header stays in view as the page scrolls.
    <div className="overflow-clip rounded-lg border bg-card">
      <Table ref={ref} className="table-fixed text-base" stickyHeader={stickyHeader}>
        <ColumnsHeader columns={arranged} widths={widths} />
        <TableBody>{children(rows)}</TableBody>
      </Table>
    </div>
  );
}
