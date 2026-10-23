import { CopyButton } from "./CopyButton";
import { cn } from "./lib/utils";
import type { PropRow } from "./PropTable";

/**
 * A trace's own facts as the related traces under them are listed: names in the muted text of a label, values beside
 * them, a hairline under each row, no box around them; two to a line where there is room. A value copies from a
 * button shown on hover. Wide facts (a task's arguments, its result) follow, a line each, laid out whole.
 */
// Both columns of names at least --dt-fact-label wide: the second column's values start at one x on every trace,
// whatever its names ("Runtime", "Task ID").
export function FactGrid({ rows }: { rows: readonly PropRow[] }) {
  // Short facts first, two to a line where there is room; the wide ones after them, a line each, in the same columns.
  const short = rows.filter((row) => !row.wide);
  const ordered = [...short, ...rows.filter((row) => row.wide)];
  // An odd one out of the short facts takes its line whole: no half line, no hairline that stops halfway.
  const alone = short.length % 2 === 1 ? short.at(-1) : undefined;
  return (
    <dl className="m-0 grid grid-cols-[minmax(var(--dt-fact-label),max-content)_minmax(0,1fr)] text-sm @2xl:grid-cols-[minmax(var(--dt-fact-label),max-content)_minmax(0,1fr)_minmax(var(--dt-fact-label),max-content)_minmax(0,1fr)]">
      {ordered.map((row) => (
        <Fact key={row.id ?? row.label} row={row} alone={row === alone} />
      ))}
    </dl>
  );
}

// A wide fact starts its own line, under the first column of names, and takes the rest of it.
// Its copy button follows the value, not the row's far end.
const WIDE = { name: "col-start-1 items-start", cell: "items-start @2xl:col-span-3", value: "min-w-0" };
const SHORT = { name: "items-center", cell: "items-center", value: "min-w-0 truncate" };
const ALONE = { ...SHORT, name: "col-start-1 items-center", cell: "items-center @2xl:col-span-3" };

/** One fact: its name, its value (whole and wrapped when wide, else cut to a line) and, on hover, its copy button. */
function Fact({ row, alone }: { row: PropRow; alone: boolean }) {
  const look = row.wide ? WIDE : alone ? ALONE : SHORT;
  return (
    <div className="group/fact contents">
      <dt
        className={cn(
          // No gap between the columns: the padding keeps them apart, the hairline runs under the whole row.
          "flex min-h-9 border-b py-1.5 pr-4 text-muted-foreground",
          look.name,
        )}
      >
        {row.label}
      </dt>
      <dd
        className={cn("m-0 flex min-h-9 min-w-0 gap-1 border-b py-1.5 pr-6", look.cell, {
          "font-mono text-xs": row.mono,
        })}
      >
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
