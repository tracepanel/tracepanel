// A dump (debug() output), one look wherever it shows: a line in the call tree and the lists of records, its
// arguments laid out in its details. Its values coloured in the language it says, else as its dumper writes them.
import { CopyButton } from "./CopyButton";
import type { Language } from "./highlight";
import { argLine, type DumpArg, dumpArgs, dumpLanguage, dumpOrigin, dumpSite } from "./lib/dump";
import { cn } from "./lib/utils";
import { KindBadge } from "./primitives";
import { CodeLines } from "./Tokens";
import type { Log } from "./types";

type Dumped = Pick<Log, "logger" | "attrs">;

/** Past this a one-line value is cut anyway: no need to colour more. */
const LINE_CHARS = 400;
/** Past this size a value in the details is shown as it came, uncoloured. */
const COLOURED = 64 * 1024;

/** Text coloured in `language`, or plain without one. */
function Coloured({ text, language, limit }: { text: string; language: Language | null; limit: number }) {
  return language ? <CodeLines text={text} language={language} limit={limit} /> : text;
}

/** A dump's badge: the muted kind badge, DUMP, in the dumps' colour. */
export function DumpBadge({ className }: { className?: string | undefined }) {
  return <KindBadge kind="dump" muted={true} className={cn("dt-dump-badge", className)} />;
}

/**
 * A dump on one line: where it was called, then its first argument, `expr = value`, coloured; how many more it
 * printed after it. `badge`: its badge first, where no column says what the line is (the lists of records).
 */
export function DumpLine({
  log,
  badge = false,
  className,
}: {
  log: Dumped;
  badge?: boolean;
  className?: string | undefined;
}) {
  const args = dumpArgs(log);
  const site = dumpSite(log);
  const first = args[0];
  const line = first ? argLine(first).slice(0, LINE_CHARS) : "";
  return (
    <span className={cn("dt-dump-line", className)} title={args.map(argLine).join("\n").slice(0, 2000)}>
      {badge ? <DumpBadge /> : null}
      {site ? <span className="dt-dump-site">{site}</span> : null}
      <span className="dt-dump-value dt-syntax">
        <Coloured text={line} language={dumpLanguage(log)} limit={LINE_CHARS} />
      </span>
      {args.length > 1 ? <span className="dt-dump-more">+{args.length - 1}</span> : null}
    </span>
  );
}

/** An argument's type and length: `list · len 3`. */
function typeOf(arg: DumpArg): string {
  if (arg.len === null) return arg.type;
  return `${arg.type} · len ${arg.len}`;
}

function DumpArgBlock({ arg, index, language }: { arg: DumpArg; index: number; language: Language | null }) {
  return (
    <section
      className="overflow-hidden rounded-md border bg-background"
      aria-label={arg.expr ?? `Argument ${index + 1}`}
    >
      <div className="flex items-center gap-2 border-b bg-muted/40 py-1 pr-1.5 pl-3">
        <code className="min-w-0 truncate font-mono text-sm font-medium">{arg.expr ?? `argument ${index + 1}`}</code>
        <span className="dt-dump-type shrink-0 font-mono text-xs text-muted-foreground">{typeOf(arg)}</span>
        <CopyButton text={arg.repr} label="Copy the value" className="ml-auto" />
      </div>
      <pre className="dt-syntax m-0 max-h-96 overflow-auto px-3 py-2 font-mono text-sm whitespace-pre">
        <Coloured text={arg.repr} language={language} limit={COLOURED} />
      </pre>
    </section>
  );
}

/** A dump's details: where it was called, then each argument as written, its type and its value laid out. */
export function DumpArgs({ log }: { log: Dumped }) {
  const args = dumpArgs(log);
  const origin = dumpOrigin(log);
  const language = dumpLanguage(log);
  return (
    <section aria-label="Dump arguments" className="grid gap-2">
      {origin ? (
        <p className="m-0 flex min-w-0 items-center gap-2 text-sm">
          <span className="shrink-0 text-muted-foreground">Called from</span>
          <code className="truncate font-mono" title={origin}>
            {origin}
          </code>
        </p>
      ) : null}
      {args.map((arg, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a dump's arguments, in the order printed.
        <DumpArgBlock key={index} arg={arg} index={index} language={language} />
      ))}
    </section>
  );
}
