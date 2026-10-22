import { CopyButton } from "./CopyButton";
import { cn } from "./lib/utils";
import type { PropRow } from "./PropTable";

/**
 * Short facts packed tight: two to a line where there is room, small muted names, no rules between them; a value
 * copies from a button shown on hover. For a request's own fields, read at a glance. Wide facts (a task's arguments,
 * its result) follow them, a line each across the box, laid out whole.
 */
export function FactGrid({ rows }: { rows: readonly PropRow[] }) {
  // Short facts first, two to a line where there is room; the wide ones after them, a line each, in the same columns.
  const ordered = [...rows.filter((row) => !row.wide), ...rows.filter((row) => row.wide)];
  return (
    <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-lg border bg-muted/30 px-3 py-2.5 text-sm @2xl:grid-cols-[max-content_minmax(0,1fr)_max-content_minmax(0,1fr)]">
      {ordered.map((row) => (
        <Fact key={row.id ?? row.label} row={row} />
      ))}
    </dl>
  );
}

// A wide fact starts its own line, under the first column of names, and takes the rest of it.
const WIDE = { name: "col-start-1", cell: "items-start @2xl:col-span-3", value: "min-w-0 flex-1 py-0.5" };
const SHORT = { name: "", cell: "items-center", value: "min-w-0 truncate" };

/** One fact: its name, its value (whole and wrapped when wide, else cut to a line) and, on hover, its copy button. */
function Fact({ row }: { row: PropRow }) {
  const look = row.wide ? WIDE : SHORT;
  return (
    <div className="group/fact contents">
      <dt
        className={cn(
          "flex min-h-6 items-center self-start text-[11px] font-medium tracking-wide text-muted-foreground uppercase",
          look.name,
        )}
      >
        {row.label}
      </dt>
      <dd className={cn("m-0 flex min-h-6 min-w-0 gap-1", look.cell, { "font-mono text-xs": row.mono })}>
        <span className={look.value}>{row.value}</span>
        {row.copy ? <FactCopy text={row.copy} label={row.label} /> : null}
      </dd>
    </div>
  );
}

function FactCopy({ text, label }: { text: string; label: string }) {
  return (
    <CopyButton
      text={text}
      label={`Copy ${label.toLowerCase()}`}
      className="size-5 shrink-0 opacity-0 transition-opacity group-hover/fact:opacity-100 focus-visible:opacity-100"
    />
  );
}
