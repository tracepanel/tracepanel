// A log record's details, one look wherever it opens: the Logs page, a trace's Logs tab, the call tree's pane.
import { type ReactNode, useMemo, useState } from "react";
import { CopyButton } from "./CopyButton";
import { ExceptionView } from "./ErrorView";
import { localTime } from "./format";
import { jsonDocument } from "./json";
import { cn } from "./lib/utils";
import { type NameValue, NameValues } from "./NameValues";
import { PropTable } from "./PropTable";
import { Segmented } from "./Segmented";
import { parseTraceback } from "./traceback";
import type { Attrs, Log } from "./types";

// The statement is shown formatted above; its fingerprint would repeat it on one line.
const HIDDEN = new Set(["db.statement", "db.fingerprint", "graphql.document"]);

/** Every attribute, raw; under a heading when the call's fields in words come before them. */
export function AllAttributes({ attrs, titled }: { attrs: Attrs; titled: boolean }) {
  const shown = Object.entries(attrs).filter(([key, value]) => !HIDDEN.has(key) && value !== null && value !== "");
  if (shown.length === 0) return null;
  return (
    <section className="grid gap-2" aria-label="All attributes">
      {titled ? (
        <h3 className="text-sm font-medium text-muted-foreground">
          All attributes <span className="tabular-nums">{shown.length}</span>
        </h3>
      ) : null}
      <PropTable
        rows={shown.map(([key, value]) => ({ label: key, value: String(value), copy: String(value), mono: true }))}
      />
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

/** The message; a JSON object or array indented, the text as logged a click away. */
function MessageBlock({ text }: { text: string }) {
  const json = useMemo(() => jsonDocument(text), [text]);
  if (json === null) return <TextBlock text={text} label="Copy message" />;
  return (
    <ReadOrRaw label="Message" read="JSON" text={text}>
      <TextBlock text={json} label="Copy message" copy={false} />
    </ReadOrRaw>
  );
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
  context = [],
  actions,
}: {
  log: Log;
  header?: ReactNode;
  context?: readonly NameValue[];
  actions?: ((name: string, value: string) => readonly ReactNode[]) | undefined;
}) {
  const own: [string, string][] = [
    ["logger", log.logger],
    ["level", log.level],
    ["time", localTime(log.time)],
    ...Object.entries(logAttrs(log.attrs)).map(([key, value]): [string, string] => [key, show(value)]),
  ];
  return (
    <div className="grid gap-3.5">
      {header}
      <MessageBlock text={log.message} />
      {log.exception ? <ExceptionBlock text={log.exception} /> : null}
      <section aria-label="Fields" className="overflow-hidden rounded-md border bg-background">
        <NameValues
          rows={[...context, ...own.map(([name, value]) => ({ name, value, actions: actions?.(name, value) ?? [] }))]}
        />
      </section>
    </div>
  );
}

/** A value as text: a list or an object as JSON, as an attribute column shows it. */
function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** A record opened in a trace: in its Logs tab, and (`titled`) in the call tree's pane. */
export function LogRecordDetails({ log, titled = false }: { log: Log; titled?: boolean }) {
  return (
    <div className={cn("grid gap-3", titled ? "p-4" : "px-5 py-4")}>
      {titled ? (
        <p className="dt-map-details-title">
          Log · {log.level} · {log.logger}
        </p>
      ) : null}
      <LogRecord log={log} />
    </div>
  );
}
