import { CircleCheckIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { explainRefusal, NOT_SELECT } from "./explainable";
import { keyed } from "./keys";
import { type PlanToken, tokenizePlan } from "./lib/plan";
import { SectionHeading } from "./primitives";
import type { ExplainPlan } from "./types";

export interface ExplainViewProps {
  /** Runs EXPLAIN (or EXPLAIN ANALYZE) for the query on its database. */
  load: (analyze: boolean) => Promise<ExplainPlan>;
  vendor: string;
  /** Why the query isn't analyzed (it locks rows): said instead of the ANALYZE button. */
  analyzeRefusal?: string | null | undefined;
}

type State =
  | { status: "idle" }
  | { status: "loading"; analyze: boolean }
  | { status: "done"; plan: ExplainPlan }
  | { status: "failed"; message: string };

/** Query plan on demand: the database's own EXPLAIN, with full scans and spilled sorts called out. */
export function ExplainView({ load, vendor, analyzeRefusal }: ExplainViewProps) {
  const [state, setState] = useState<State>({ status: "idle" });
  // As the agent runs it: EXPLAIN (ANALYZE, BUFFERS), MySQL's and MariaDB's EXPLAIN ANALYZE.
  const analyzes = ANALYZED.has(vendor);
  const canAnalyze = analyzes && !analyzeRefusal;
  const run = (analyze: boolean) => {
    setState({ status: "loading", analyze });
    load(analyze).then(
      (plan) => setState({ status: "done", plan }),
      (error: unknown) =>
        setState({ status: "failed", message: error instanceof Error ? error.message : String(error) }),
    );
  };
  const loading = state.status === "loading";
  const plan = state.status === "done" ? state.plan : null;
  const warnings = plan ? plan.lines.filter((line) => line.warning).length : 0;

  return (
    <section className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2.5">
        <SectionHeading>Query plan</SectionHeading>
        {/* Beside the heading, not at the far end: a wide row scrolls that end out of view. */}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="h-7 shadow-none" disabled={loading} onClick={() => run(false)}>
            {loading && !state.analyze ? "Explaining…" : plan ? "Explain again" : "Explain"}
          </Button>
          {canAnalyze ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 shadow-none"
              disabled={loading}
              title="Runs the query to measure real time and rows"
              onClick={() => run(true)}
            >
              {loading && state.analyze ? "Analyzing…" : "Explain analyze"}
            </Button>
          ) : null}
        </div>
        {plan ? (
          <>
            <span className="text-sm text-muted-foreground">
              {plan.vendor} · {plan.alias}
              {plan.analyzed ? " · analyzed" : ""}
            </span>
            {warnings ? (
              <Badge variant="outline" className="border-warn/30 bg-warn-soft text-warn">
                <TriangleAlertIcon />
                {warnings} {warnings === 1 ? "warning" : "warnings"}
              </Badge>
            ) : (
              <Badge variant="outline" className="border-ok/30 bg-ok-soft text-ok">
                <CircleCheckIcon />
                Uses indexes
              </Badge>
            )}
          </>
        ) : null}
      </div>
      {state.status === "failed" ? <p className="text-sm text-error">{state.message}</p> : null}
      {state.status === "idle" ? <Idle canAnalyze={canAnalyze} why={analyzes ? analyzeRefusal : null} /> : null}
      {plan ? (
        <ol className="m-0 grid list-none rounded-md border bg-muted/60 py-1.5">
          {keyed(plan.lines, (line) => `${line.depth}:${line.text}`).map(({ key, item: line }) => (
            <li key={key} className="grid gap-0.5 py-1 pr-3" style={{ paddingLeft: `${0.75 + line.depth * 1.25}rem` }}>
              <PlanText text={line.text} warning={Boolean(line.warning)} />
              {line.warning ? (
                <span className="flex items-center gap-1.5 text-sm text-text-2">
                  <TriangleAlertIcon className="size-3.5 text-warn" />
                  {line.warning}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

const ANALYZED = new Set(["postgresql", "mysql", "mariadb"]);

/** What the buttons do, and why ANALYZE isn't one of them where the database has it. */
function Idle({ canAnalyze, why }: { canAnalyze: boolean; why: string | null | undefined }) {
  return (
    <p className="text-sm text-muted-foreground">
      Run EXPLAIN on the database to see how it reads the tables{canAnalyze ? ", or ANALYZE to time it" : ""}.
      {why ? ` ${why}` : ""}
    </p>
  );
}

export interface StatementPlanProps extends Omit<ExplainViewProps, "analyzeRefusal"> {
  statement: string;
}

/**
 * A statement's plan, by the rule the agent explains by: none for one that isn't a SELECT or a WITH, why not for one
 * that changes data (a WITH that deletes), the buttons for one that only reads.
 */
export function StatementPlan({ statement, ...props }: StatementPlanProps) {
  const refusal = explainRefusal(statement, false);
  if (refusal === NOT_SELECT) return null;
  if (refusal) {
    return (
      <section className="grid gap-2">
        <SectionHeading>Query plan</SectionHeading>
        <p className="text-sm text-muted-foreground">{refusal}</p>
      </section>
    );
  }
  return <ExplainView {...props} analyzeRefusal={explainRefusal(statement, true)} />;
}

const PLAN_CLASSES: Record<PlanToken["type"], string | undefined> = {
  op: "dt-plan-op",
  label: "dt-plan-label",
  keyword: "dt-sql-keyword",
  name: "dt-sql-identifier",
  key: "dt-plan-key",
  number: "dt-sql-number",
  string: "dt-sql-string",
  text: undefined,
};

/** A plan line in colour, as the statement above it: its operation, the tables and indexes, the numbers. */
function PlanText({ text, warning }: { text: string; warning: boolean }) {
  const tokens = useMemo(() => tokenizePlan(text), [text]);
  return (
    <code
      className="dt-plan-line font-mono text-sm whitespace-pre-wrap [overflow-wrap:anywhere]"
      data-warning={warning ? "" : undefined}
    >
      {tokens.map((token, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one line never reorder.
        <span key={index} className={PLAN_CLASSES[token.type]}>
          {token.text}
        </span>
      ))}
    </code>
  );
}
