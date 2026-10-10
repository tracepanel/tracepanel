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
}

/** Label / value rows with a copy button per value; the label column fits the longest label. */
export function PropTable({ rows }: { rows: readonly PropRow[] }) {
  return (
    <dl className="m-0 grid grid-cols-[minmax(110px,max-content)_minmax(0,1fr)_auto] text-[14.5px]">
      {rows.map((row) =>
        row.heading ? (
          <div
            key={row.id ?? row.label}
            className="col-span-3 flex items-baseline gap-1.5 pt-4 pb-1 text-[12px] font-semibold tracking-wide text-muted-foreground uppercase"
          >
            {row.label}
            <span className="font-normal tabular-nums">{row.value}</span>
          </div>
        ) : (
          <div key={row.id ?? row.label} className="group/row contents">
            <dt className="flex min-h-10 items-center border-b py-1.5 pr-5 text-muted-foreground">{row.label}</dt>
            <dd
              className={`m-0 flex min-h-10 min-w-0 items-center border-b py-1.5 break-all ${row.mono ? "font-mono text-[14px]" : ""}`}
            >
              {row.value}
            </dd>
            <span className="flex min-h-10 w-9 items-center justify-end border-b">
              {row.copy ? (
                <CopyButton
                  text={row.copy}
                  label={`Copy ${row.label.toLowerCase()}`}
                  className="size-7 opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                />
              ) : null}
            </span>
          </div>
        ),
      )}
    </dl>
  );
}
