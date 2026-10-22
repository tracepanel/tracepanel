import { LogLevel } from "./LogTable";
import { plural } from "./lib/plural";
import { cn } from "./lib/utils";
import type { App } from "./types";

/** One thing wrong with the app: a check that failed, an app's migrations not applied or not made. */
export interface AppWarning {
  key: string;
  level: string;
  /** The check's id ("security.W004"), or what kind of warning it is ("migrations"). */
  id: string;
  message: string;
  hint: string | null;
  /** What it is about: a model, a field, an app. */
  object: string | null;
}

// The most serious first, as Django's `check` lists them; a level it doesn't know with the debug ones.
const RANK: Record<string, number> = { critical: 0, error: 1, warning: 2, info: 3, debug: 4 };
const rank = (level: string) => RANK[level] ?? 4;

/** The app's migrations not applied and its model changes without one, each app a warning. */
function migrationWarnings(app: App): AppWarning[] {
  const migrations = app.migrations;
  if (!migrations) return [];
  return [
    ...(migrations.unapplied ?? []).map((each) => ({
      key: `unapplied:${each.app}`,
      level: "warning",
      id: "migrations",
      message: `${plural(each.names.length, "unapplied migration", "unapplied migrations")}: ${each.names.join(", ")}`,
      hint: "Run manage.py migrate to apply them: the app may not work until then.",
      object: each.app,
    })),
    ...(migrations.changes ?? []).map((each) => ({
      key: `changes:${each.app}`,
      level: "warning",
      id: "migrations",
      message: `Model changes with no migration: ${each.changes.join(", ")}`,
      hint: "Run manage.py makemigrations to write one.",
      object: each.app,
    })),
  ];
}

/**
 * What the app's checks found wrong with it, the most serious first: the framework's own checks, then its migrations
 * (an agent from before has neither).
 */
export function appWarnings(app: App | null | undefined): AppWarning[] {
  if (!app) return [];
  const checks = (app.checks ?? []).map((check, index) => ({
    key: `check:${index}:${check.id ?? ""}`,
    level: check.level,
    id: check.id ?? "check",
    message: check.message,
    hint: check.hint,
    object: check.object,
  }));
  // Stable: the checks keep their order within a level, before the migrations of the same level.
  return [...checks, ...migrationWarnings(app)].sort((a, b) => rank(a.level) - rank(b.level));
}

/** The tone of a count of warnings: an error among them makes it red. */
export function warningsTone(warnings: readonly AppWarning[]): "warn" | "error" {
  return warnings.some((warning) => rank(warning.level) <= rank("error")) ? "error" : "warn";
}

const ACCENT: Record<string, string> = {
  critical: "shadow-[inset_3px_0_0_var(--color-error)]",
  error: "shadow-[inset_3px_0_0_var(--color-error)]",
  warning: "shadow-[inset_3px_0_0_var(--color-warn)]",
};

function WarningRow({ warning }: { warning: AppWarning }) {
  return (
    <li className={cn("grid gap-1 border-t px-3 py-2 first:border-t-0", ACCENT[warning.level])}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <LogLevel level={warning.level} />
        <code className="font-mono text-xs font-semibold">{warning.id}</code>
        {warning.object ? (
          <code className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{warning.object}</code>
        ) : null}
      </div>
      <p className="text-sm [overflow-wrap:anywhere]">{warning.message}</p>
      {warning.hint ? <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{warning.hint}</p> : null}
    </li>
  );
}

/** What is wrong with the app, above its settings: nothing at all when nothing is. */
export function AppWarnings({ warnings }: { warnings: readonly AppWarning[] }) {
  if (!warnings.length) return null;
  return (
    <section className="grid gap-2" aria-label="Warnings">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        Warnings
        <span className="dt-tab-count" data-tone={warningsTone(warnings)}>
          {warnings.length}
        </span>
      </h2>
      <ul className="m-0 list-none overflow-hidden rounded-lg border bg-card p-0">
        {warnings.map((warning) => (
          <WarningRow key={warning.key} warning={warning} />
        ))}
      </ul>
    </section>
  );
}
