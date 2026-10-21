import { NameValues } from "./NameValues";
import type { Attrs } from "./types";

// What a template was rendered with, as the Python SDK records it: its names and their values (repr-ed, cut,
// masked), side by side, and how many more it left out.
const PREFIX = "template.context.";
const NAMES = `${PREFIX}names`;
const VALUES = `${PREFIX}values`;
const OMITTED = `${PREFIX}omitted`;

/** A span's attributes without its template context: shown as rows of its own, not again among them. */
export function withoutContext(attrs: Attrs): Attrs {
  return Object.fromEntries(Object.entries(attrs).filter(([key]) => !key.startsWith(PREFIX)));
}

function rowsOf(attrs: Attrs): { name: string; value: string }[] | null {
  const names = attrs[NAMES];
  if (!Array.isArray(names)) return null;
  const values = attrs[VALUES];
  return names.map((name, index) => ({
    name: String(name),
    value: Array.isArray(values) ? String(values[index] ?? "") : "",
  }));
}

/** The rows, a long value folded, and how many names were left out. */
function ContextRows({ rows, omitted }: { rows: { name: string; value: string }[]; omitted: number }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <NameValues fold rows={rows} />
      {omitted > 0 ? (
        <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">
          {omitted} more {omitted === 1 ? "name" : "names"} not recorded: over the limit of one template.
        </p>
      ) : null}
    </div>
  );
}

/** Why there is no row: nothing recorded (the SDK, or the setting), or an empty context. */
function NoContext({ recorded }: { recorded: boolean }) {
  return (
    <p className="text-xs text-muted-foreground">
      {recorded
        ? "The template got an empty context."
        : "Not recorded: the app's SDK doesn't record a template's context, or capture_template_context is off."}
    </p>
  );
}

/** A template's context, a row per name with its value (a long one folded), or why there is none. */
export function TemplateContext({ attrs }: { attrs: Attrs }) {
  const rows = rowsOf(attrs);
  return (
    <section className="grid gap-2" aria-label="Template context">
      <h3 className="text-sm font-medium text-muted-foreground">
        Context {rows ? <span className="tabular-nums">{rows.length}</span> : null}
      </h3>
      <ContextBody rows={rows} attrs={attrs} />
    </section>
  );
}

function ContextBody({ rows, attrs }: { rows: { name: string; value: string }[] | null; attrs: Attrs }) {
  if (!rows?.length) return <NoContext recorded={rows !== null} />;
  return <ContextRows rows={rows} omitted={Number(attrs[OMITTED] ?? 0)} />;
}
