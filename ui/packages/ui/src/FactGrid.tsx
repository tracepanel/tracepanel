import { CopyButton } from "./CopyButton";
import type { PropRow } from "./PropTable";

/**
 * Short facts packed tight: two to a line where there is room, small muted names, no rules between them; a value
 * copies from a button shown on hover. For a request's own fields, read at a glance.
 */
export function FactGrid({ rows }: { rows: readonly PropRow[] }) {
  return (
    <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-lg border bg-muted/30 px-3 py-2.5 text-sm @2xl:grid-cols-[max-content_minmax(0,1fr)_max-content_minmax(0,1fr)]">
      {rows.map((row) => (
        <div key={row.id ?? row.label} className="group/fact contents">
          <dt className="flex min-h-6 items-center text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {row.label}
          </dt>
          <dd className={`m-0 flex min-h-6 min-w-0 items-center gap-1 ${row.mono ? "font-mono text-xs" : ""}`}>
            <span className="min-w-0 truncate">{row.value}</span>
            {row.copy ? (
              <CopyButton
                text={row.copy}
                label={`Copy ${row.label.toLowerCase()}`}
                className="size-5 shrink-0 opacity-0 transition-opacity group-hover/fact:opacity-100 focus-visible:opacity-100"
              />
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
