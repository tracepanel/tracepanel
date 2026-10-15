// A log record's details as the call tree shows a picked one, in its pane and in a trace's Logs tab alike.
import { PropTable } from "./PropTable";
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

/** Its level and logger, its message (with its exception), and where it was logged: code, thread, template, extra. */
export function LogRecordDetails({ log }: { log: Log }) {
  return (
    <div className="grid gap-3 p-4">
      <p className="dt-map-details-title">
        Log · {log.level} · {log.logger}
      </p>
      <pre className="m-0 overflow-auto rounded-md border bg-muted/60 px-4 py-3 font-mono text-sm whitespace-pre-wrap">
        {log.exception ? `${log.message}\n\n${log.exception}` : log.message}
      </pre>
      <AllAttributes attrs={logAttrs(log.attrs)} titled={true} />
    </div>
  );
}
