// A log record's details, one look wherever it opens: the Logs page, a trace's Logs tab, the call tree's pane.
import { type ReactNode, useMemo, useState } from "react";
import { CopyButton } from "./CopyButton";
import { DumpArgs } from "./Dump";
import { ExceptionView } from "./ErrorView";
import { localTime } from "./format";
import { jsonDocument } from "./json";
import { withoutAnsi } from "./lib/ansi";
import { dumpSite, isDump } from "./lib/dump";
import { cn } from "./lib/utils";
import { rawText } from "./lib/values";
import { type NameValue, NameValues, RowsLookContext } from "./NameValues";
import { SectionHeading } from "./primitives";
import { Segmented } from "./Segmented";
import { CodeLines } from "./Tokens";
import { parseTraceback } from "./traceback";
import type { Attrs, Log } from "./types";

// The statement is shown formatted above; its fingerprint would repeat it on one line.
const HIDDEN = new Set(["db.statement", "db.fingerprint", "graphql.document"]);

/**
 * Every attribute, as it came, in the rows of a trace's info tab (no box); under a heading when the call's fields in
 * words come before them.
 */
export function AllAttributes({ attrs, titled }: { attrs: Attrs; titled: boolean }) {
  const shown = Object.entries(attrs).filter(([key, value]) => !HIDDEN.has(key) && value !== null && value !== "");
  if (shown.length === 0) return null;
  return (
    <section className="grid gap-2" aria-label="All attributes">
      {titled ? (
        <SectionHeading>
          All attributes <span className="text-xs font-normal text-muted-foreground tabular-nums">{shown.length}</span>
        </SectionHeading>
      ) : null}
      <RowsLookContext value="plain">
        <NameValues rows={shown.map(([name, value]) => ({ name, value }))} />
      </RowsLookContext>
    </section>
  );
}

// Where a record was written first, then its thread, its template, anything else, and the app's own extra= fields.
const FIRST = ["code.filepath", "code.lineno", "code.function", "thread.name", "thread.id", "log.template"];

function rank(key: string): number {
  const at = FIRST.indexOf(key);
  if (at >= 0) return at;
  return key.startsWith("extra.") ? FIRST.length + 1 : FIRST.length;
}

/**
 * A record's attributes in one order wherever it is shown: the store keeps them sorted by name, a trace as its SDK
 * sent them, and the same record read differently in the two.
 */
export function logAttrs(attrs: Attrs): Attrs {
  return Object.fromEntries(Object.entries(attrs).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))) as Attrs;
}

/**
 * A block of text to read whole and copy: the message, or its exception in the error's colour. `copy` off: the bar
 * above it has the button.
 */
function TextBlock({
  text,
  label,
  error = false,
  copy = true,
}: {
  text: string;
  label: string;
  error?: boolean;
  copy?: boolean;
}) {
  return (
    <div
      className={cn("group/text relative rounded-md border bg-background", error && "border-error/30 bg-error-soft")}
    >
      <pre
        className={cn(
          "m-0 px-3 py-2 pr-10 font-mono text-sm whitespace-pre-wrap [overflow-wrap:anywhere]",
          error && "max-h-80 overflow-auto",
        )}
      >
        {text}
      </pre>
      {copy ? <CopyButton text={text} label={label} className="absolute top-2 right-2" /> : null}
    </div>
  );
}

/** A message that is a JSON document, indented and coloured: the bar above it copies the text as logged. */
function JsonBlock({ json }: { json: string }) {
  return (
    <div className="rounded-md border bg-background">
      <pre className="dt-syntax m-0 px-3 py-2 font-mono text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
        <CodeLines text={json} language="javascript" />
      </pre>
    </div>
  );
}

type View = "read" | "raw";

/**
 * Text the console reads into something better (a traceback's frames, a JSON document indented), with the text as it
 * came a click away: a bar names it, picks the view and copies the text as it came, whichever is shown.
 */
function ReadOrRaw({
  label,
  read,
  text,
  error = false,
  children,
}: {
  label: string;
  /** The read view's name: "Frames", "JSON". */
  read: string;
  text: string;
  error?: boolean;
  children: ReactNode;
}) {
  const [view, setView] = useState<View>("read");
  return (
    <section aria-label={label} className="grid gap-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">{label}</h3>
        <span className="ml-auto flex items-center gap-1.5">
          <Segmented
            segments={[
              { id: "read", label: read },
              { id: "raw", label: "Raw" },
            ]}
            value={view}
            onChange={setView}
            label={`${label} as`}
          />
          <CopyButton text={text} label={`Copy ${label.toLowerCase()}`} />
        </span>
      </div>
      {view === "read" ? children : <TextBlock text={text} label={label} error={error} copy={false} />}
    </section>
  );
}

/** The message; a JSON object or array indented and coloured, the text as logged a click away. */
function MessageBlock({ text }: { text: string }) {
  const json = useMemo(() => jsonDocument(text), [text]);
  if (json === null) return <TextBlock text={text} label="Copy message" />;
  return (
    <ReadOrRaw label="Message" read="JSON" text={text}>
      <JsonBlock json={json} />
    </ReadOrRaw>
  );
}

// A dump's arguments and where it was called are laid out above its fields: not again among them.
const DUMP_SHOWN = new Set(["log.kind", "dump.args", "code.origin"]);

/** The text of the record: a dump's arguments laid out (its text as printed a click away), else its message. */
function RecordText({ log }: { log: Log }) {
  const message = withoutAnsi(log.message);
  if (!isDump(log)) return <MessageBlock text={message} />;
  return (
    <ReadOrRaw label="Dump" read="Values" text={message}>
      <DumpArgs log={log} />
    </ReadOrRaw>
  );
}

/** A record's own attributes as its fields list them: a dump's without what its arguments' block shows. */
function fieldAttrs(log: Log): [string, unknown][] {
  const all = Object.entries(logAttrs(log.attrs));
  return isDump(log) ? all.filter(([key]) => !DUMP_SHOWN.has(key)) : all;
}

/** The exception: its frames as an error shows them, when its traceback reads as one; else its text. */
function ExceptionBlock({ text }: { text: string }) {
  const exception = useMemo(() => parseTraceback(text), [text]);
  if (exception === null) return <TextBlock text={text} label="Copy exception" error={true} />;
  return (
    <ReadOrRaw label="Exception" read="Frames" text={text} error={true}>
      <ExceptionView exception={exception} />
    </ReadOrRaw>
  );
}

/**
 * A log record, one look wherever it opens (the Logs page, a trace's Logs tab, the call tree): `header` above it (where
 * to go from it), its message and its exception, then its fields: `context` first (its trace's: the app, the request),
 * then its own logger, level and time, then its attributes. `actions` are a field's own buttons, before its copy one.
 */
export function LogRecord({
  log,
  header,
  footer,
  context = [],
  actions,
}: {
  log: Log;
  header?: ReactNode;
  /** Its actions under it (DetailsFooter). */
  footer?: ReactNode;
  context?: readonly NameValue[];
  actions?: ((name: string, value: string) => readonly ReactNode[]) | undefined;
}) {
  const own: [string, unknown][] = [
    ["logger", withoutAnsi(log.logger)],
    ["level", log.level],
    ["time", localTime(log.time)],
    ...fieldAttrs(log),
  ];
  return (
    <div className="grid gap-3.5">
      {header}
      <RecordText log={log} />
      {log.exception ? <ExceptionBlock text={withoutAnsi(log.exception)} /> : null}
      <section aria-label="Fields" className="overflow-hidden rounded-md border bg-background">
        <NameValues
          rows={[
            ...context,
            ...own.map(([name, value]) => ({ name, value, actions: actions?.(name, rawText(value)) ?? [] })),
          ]}
        />
      </section>
      {footer}
    </div>
  );
}

/** A record opened in a trace: in its Logs tab, and (`titled`) in the call tree's pane. */
export function LogRecordDetails({ log, titled = false }: { log: Log; titled?: boolean }) {
  return (
    <div className={cn("grid gap-3", titled ? "p-4" : "px-5 py-4")}>
      {titled ? (
        <p className="dt-map-details-title">
          {isDump(log)
            ? `Dump · ${dumpSite(log) ?? withoutAnsi(log.logger)}`
            : `Log · ${log.level} · ${withoutAnsi(log.logger)}`}
        </p>
      ) : null}
      <LogRecord log={log} />
    </div>
  );
}
