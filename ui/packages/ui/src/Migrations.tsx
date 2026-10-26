// A migrate job's migrations, one look wherever they show: the job's first tab lists each migration it applied or
// unapplied with its operations (their rows, time, whether they ran in a transaction), a risky operation marked with
// the issue's chip and its reason; the call tree's rows say the same of each.
import { duration } from "./format";
import {
  isMigration,
  isMigrationOperation,
  type MigratePlan,
  type Migration,
  type MigrationOperation,
} from "./lib/migrations";
import { plural } from "./lib/plural";
import { linkProps, type TraceLinks } from "./links";
import { IssueChip } from "./primitives";
import type { Issue, Span } from "./types";

/** "faked", "not atomic": a migration's notes after its name; an operation's rows. */
function notesOf(span: Span): string[] {
  const attrs = span.attrs;
  if (isMigration(span)) {
    return [
      attrs["migration.fake"] === true ? "faked" : null,
      attrs["migration.atomic"] === false ? "not atomic" : null,
    ].filter((note): note is string => note !== null);
  }
  if (!isMigrationOperation(span)) return [];
  const rows = attrs["migration.rows"];
  return typeof rows === "number" ? [plural(rows, "row", "rows")] : [];
}

/** What a call tree row says of a migration or an operation after its name; any other row has nothing. */
export function MigrationNotes({ span }: { span: Span }) {
  return (
    <>
      {notesOf(span).map((note) => (
        <span key={note} className="dt-map-sub" data-count="">
          {note}
        </span>
      ))}
    </>
  );
}

/** A quiet word beside a name: "faked", "12 rows", "atomic". */
function Note({ children }: { children: string }) {
  return <span className="text-xs text-muted-foreground">{children}</span>;
}

function Time({ us }: { us: number }) {
  return <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{duration(us)}</span>;
}

/** The issue's chip, to the issue's page where the host links issues; the plain chip for a risk with no issue. */
function RiskChip({ issue, links }: { issue: Issue | undefined; links: TraceLinks | undefined }) {
  const chip = <IssueChip kind="migration-risk" />;
  if (!(issue && links?.issue)) return chip;
  return (
    <a {...linkProps(links, links.issue(issue.fingerprint, issue.kind))} className="inline-flex">
      {chip}
    </a>
  );
}

function atomicNote(atomic: boolean | null): string | null {
  if (atomic === null) return null;
  return atomic ? "atomic" : "not atomic";
}

function OperationRow({
  operation,
  issue,
  links,
}: {
  operation: MigrationOperation;
  issue: Issue | undefined;
  links: TraceLinks | undefined;
}) {
  const atomic = atomicNote(operation.atomic);
  return (
    <li className="grid gap-0.5 py-1 pl-4" data-risk={operation.risk ? "" : undefined}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <code className="font-mono text-xs [overflow-wrap:anywhere]">{operation.span.name}</code>
        {operation.risk ? <RiskChip issue={issue} links={links} /> : null}
        {operation.rows !== null ? <Note>{plural(operation.rows, "row", "rows")}</Note> : null}
        {atomic ? <Note>{atomic}</Note> : null}
        <Time us={operation.span.duration} />
      </div>
      {operation.risk ? <p className="m-0 text-xs text-warn [overflow-wrap:anywhere]">{operation.risk}</p> : null}
    </li>
  );
}

function MigrationRow({
  migration,
  issueBySpan,
  links,
}: {
  migration: Migration;
  issueBySpan: ReadonlyMap<string, Issue>;
  links: TraceLinks | undefined;
}) {
  return (
    <li
      className="grid border-t px-3 py-1.5 first:border-t-0"
      data-direction={migration.backwards ? "backwards" : "forwards"}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <code className="font-mono text-xs font-semibold [overflow-wrap:anywhere]">{migration.label}</code>
        {migration.backwards ? <Note>unapplied</Note> : null}
        {migration.fake ? <Note>faked</Note> : null}
        {migration.atomic === false ? <Note>not atomic</Note> : null}
        <Time us={migration.span.duration} />
      </div>
      {migration.operations.length ? (
        <ul className="m-0 list-none p-0">
          {migration.operations.map((operation) => (
            <OperationRow
              key={operation.span.id}
              operation={operation}
              issue={issueBySpan.get(operation.span.id)}
              links={links}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The plan's migrations migrate didn't get to: one before them failed. */
function NotRunRow({ label }: { label: string }) {
  return (
    <li className="flex items-center gap-2 border-t px-3 py-1.5 first:border-t-0" data-not-run="">
      <code className="font-mono text-xs text-muted-foreground">{label}</code>
      <Note>not run</Note>
    </li>
  );
}

/** Each migration the job applied or unapplied, in the order it ran them, with its operations; then those not run. */
export function MigrationList({
  plan,
  issues,
  links,
}: {
  plan: MigratePlan;
  issues: readonly Issue[];
  links?: TraceLinks | undefined;
}) {
  const issueBySpan = new Map(
    issues
      .filter((issue) => issue.kind === "migration-risk")
      .flatMap((issue) => issue.span_ids.map((id) => [id, issue])),
  );
  return (
    <ol className="m-0 list-none overflow-hidden rounded-lg border bg-card p-0" aria-label="Migrations">
      {plan.migrations.map((migration) => (
        <MigrationRow key={migration.span.id} migration={migration} issueBySpan={issueBySpan} links={links} />
      ))}
      {plan.notRun.map((label) => (
        <NotRunRow key={label} label={label} />
      ))}
    </ol>
  );
}

/** "2 risky operations": how many operations of the job lock or rewrite a table, or can't be undone. */
export function riskCount(plan: MigratePlan): string | null {
  const risky = plan.migrations.flatMap((migration) => migration.operations).filter((operation) => operation.risk);
  return risky.length ? plural(risky.length, "risky operation", "risky operations") : null;
}
