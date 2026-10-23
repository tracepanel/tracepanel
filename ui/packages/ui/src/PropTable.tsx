import type { ReactNode } from "react";
import { CopyButton } from "./CopyButton";

export interface PropRow {
  label: string;
  /** A heading row across the table (a group of attributes); `value` is shown beside it, muted. */
  heading?: boolean;
  /** React key when labels repeat (attribute groups: service.name, user.name); defaults to the label. */
  id?: string | undefined;
  value: ReactNode;
  /** Plain text for the copy button; rows without it have none. */
  copy?: string | null | undefined;
  mono?: boolean;
  /** A value that may be long (a task's arguments, its result): laid out whole across the row, wrapped, folded. */
  wide?: boolean | undefined;
}

/** The two densities: the default, and `dense` for many short rows (a request's fields and headers). */
const SIZES = {
  normal: { table: "text-base", heading: "pt-4", cell: "min-h-10 py-1.5", mono: "font-mono text-sm" },
  // As a trace's facts are (FactGrid): its related traces under them, in rows of the same make.
  dense: { table: "text-sm", heading: "pt-3", cell: "min-h-9 py-1.5", mono: "font-mono text-xs" },
} as const;

/** Label / value rows with a copy button per value; the label column fits the longest label. `dense`: the rows of
 * a trace's facts, smaller text, the names' column at least as wide as theirs. */
export function PropTable({ rows, dense = false }: { rows: readonly PropRow[]; dense?: boolean }) {
  const size = SIZES[dense ? "dense" : "normal"];
  return (
    <dl
      className={`m-0 grid ${dense ? "grid-cols-[minmax(var(--dt-fact-label),max-content)_minmax(0,1fr)_auto]" : "grid-cols-[minmax(110px,max-content)_minmax(0,1fr)_auto]"} ${size.table}`}
    >
      {rows.map((row) =>
        row.heading ? (
          <div
            key={row.id ?? row.label}
            className={`col-span-3 flex items-baseline gap-1.5 ${size.heading} pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase`}
          >
            {row.label}
            <span className="font-normal tabular-nums">{row.value}</span>
          </div>
        ) : (
          <div key={row.id ?? row.label} className="group/row contents">
            <dt className={`flex items-center border-b pr-4 text-muted-foreground ${size.cell}`}>{row.label}</dt>
            <dd
              // Wraps at spaces and slashes first, inside a word only when it must (a long id); a mono value at the
              // size of the text beside it (mono glyphs run wider). Its copy button follows it, as a fact's does.
              className={`col-span-2 m-0 flex min-w-0 items-center gap-1 border-b [overflow-wrap:anywhere] ${size.cell} ${row.mono ? size.mono : ""}`}
            >
              <span className="min-w-0">{row.value}</span>
              {row.copy ? (
                <CopyButton
                  text={row.copy}
                  label={`Copy ${row.label.toLowerCase()}`}
                  className="size-5 shrink-0 opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                />
              ) : null}
            </dd>
          </div>
        ),
      )}
    </dl>
  );
}
