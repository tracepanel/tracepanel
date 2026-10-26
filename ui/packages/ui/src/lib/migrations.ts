// A migrate job, what it did: each migration it applied or unapplied a `migration` span, each operation of one a
// `migration.operation` span inside (the schema editor's transaction may be between them), as the agent stores what
// the Python SDK records. A trace stored before the agent had the kinds has them as `function` spans with the same
// attributes. The trace has the plan (`migrate.plan`) and its counts. Plain data, no React.
import type { Span, Trace } from "../types";

type Attrs = Record<string, unknown>;

export interface MigrationOperation {
  span: Span;
  /** Whether it ran in a transaction; null when the SDK doesn't say. */
  atomic: boolean | null;
  /** The rows its INSERT, UPDATE and DELETE statements changed, when it ran any. */
  rows: number | null;
  /** Why it locks or rewrites a table on the database it ran on, or can't be undone. */
  risk: string | null;
}

export interface Migration {
  span: Span;
  /** "shop.0012_add_sku", as migrate names it. */
  label: string;
  backwards: boolean;
  fake: boolean;
  atomic: boolean | null;
  operations: MigrationOperation[];
}

export interface MigratePlan {
  migrations: Migration[];
  applied: number;
  unapplied: number;
  fake: number;
  /** How many the plan had (`migrate.planned`); null from an SDK that doesn't say. */
  planned: number | null;
  /** The plan's migrations with no span: migrate stopped before them (one before failed). */
  notRun: string[];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function flag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** A migration applied or unapplied. */
export function isMigration(span: Pick<Span, "kind" | "attrs">): boolean {
  return span.kind === "migration" || (span.kind === "function" && "migration.app" in span.attrs);
}

/** One of a migration's operations. */
export function isMigrationOperation(span: Pick<Span, "kind" | "attrs">): boolean {
  return span.kind === "migration.operation" || (span.kind === "function" && "migration.operation" in span.attrs);
}

/** "shop.0012_add_sku". */
function labelOf(attrs: Attrs, name: string): string {
  const app = text(attrs["migration.app"]);
  const migration = text(attrs["migration.name"]);
  return app && migration ? `${app}.${migration}` : name;
}

/** The migration an operation ran in: the nearest one above it. */
function ownerOf(span: Span, byId: ReadonlyMap<string, Span>): Span | undefined {
  for (let at = byId.get(String(span.parent_id)); at; at = byId.get(String(at.parent_id))) {
    if (isMigration(at)) return at;
  }
  return undefined;
}

function operationOf(span: Span): MigrationOperation {
  const rows = span.attrs["migration.rows"];
  return {
    span,
    atomic: flag(span.attrs["migration.atomic"]),
    rows: typeof rows === "number" ? rows : null,
    risk: text(span.attrs["migration.risk"]),
  };
}

function migrationOf(span: Span): Migration {
  return {
    span,
    label: labelOf(span.attrs, span.name),
    backwards: span.attrs["migration.direction"] === "backwards",
    fake: span.attrs["migration.fake"] === true,
    atomic: flag(span.attrs["migration.atomic"]),
    operations: [],
  };
}

/** The plan's migrations as the trace names them ("shop.0012_add_sku"). */
function planOf(attrs: Attrs): string[] {
  const plan = attrs["migrate.plan"];
  return Array.isArray(plan) ? plan.filter((each): each is string => typeof each === "string") : [];
}

function plannedOf(attrs: Attrs): number | null {
  const planned = attrs["migrate.planned"];
  return typeof planned === "number" ? planned : null;
}

/** Each migration in the order it ran, with its operations; the operations outside any left out. */
function migrationsOf(trace: Pick<Trace, "spans">): Migration[] {
  const byId = new Map(trace.spans.map((span) => [span.id, span]));
  const migrations = new Map<string, Migration>();
  for (const span of trace.spans) {
    if (isMigration(span)) migrations.set(span.id, migrationOf(span));
  }
  for (const span of trace.spans) {
    if (!isMigrationOperation(span)) continue;
    const owner = ownerOf(span, byId);
    if (owner) migrations.get(owner.id)?.operations.push(operationOf(span));
  }
  const ordered = [...migrations.values()].sort((a, b) => a.span.start - b.span.start);
  for (const migration of ordered) migration.operations.sort((a, b) => a.span.start - b.span.start);
  return ordered;
}

/**
 * A migrate job's plan and what it did: applied, faked, unapplied, the plan's migrations it didn't get to. Null for a
 * trace of anything else.
 */
export function migratePlan(trace: Pick<Trace, "kind" | "attrs" | "spans">): MigratePlan | null {
  const migrations = migrationsOf(trace);
  const planned = plannedOf(trace.attrs);
  if (!migrations.length && planned === null) return null;
  const ran = new Set(migrations.map((migration) => migration.label));
  return {
    migrations,
    applied: migrations.filter((migration) => !migration.backwards && !migration.fake).length,
    fake: migrations.filter((migration) => !migration.backwards && migration.fake).length,
    unapplied: migrations.filter((migration) => migration.backwards).length,
    planned,
    notRun: planOf(trace.attrs).filter((label) => !ran.has(label)),
  };
}

/** "2 applied · 1 faked · 1 unapplied · 1 not run": every count but the zeros, "nothing to do" for an empty plan. */
export function planSummary(plan: MigratePlan): string {
  const parts = [
    plan.applied ? `${plan.applied} applied` : null,
    plan.fake ? `${plan.fake} faked` : null,
    plan.unapplied ? `${plan.unapplied} unapplied` : null,
    plan.notRun.length ? `${plan.notRun.length} not run` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "nothing to do";
}
