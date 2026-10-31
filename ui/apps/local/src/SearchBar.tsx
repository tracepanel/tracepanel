import {
  AppChip,
  IssueChip,
  type IssueKind,
  LogLevel,
  NO_KNOWN,
  type SearchResource,
  type SearchSpec,
  TaskName,
} from "@tracepanel/ui";
import { Badge } from "@tracepanel/ui/components/ui/badge";
import { Button } from "@tracepanel/ui/components/ui/button";
import { type Family, systemOfPage } from "@tracepanel/ui/lib/systems";
import { cn } from "@tracepanel/ui/lib/utils";
import { SearchIcon, XIcon } from "lucide-react";
import {
  type KeyboardEvent as BoxKeyEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type FilterItem, FilterMenu } from "./FilterMenu";
import { LEVELS, levelSummary, levelsFrom, levelTerm } from "./levels";
import { type CallsSection, type EntrySection, type Section, systemOfSection } from "./routes";
import { SlowerQuick, type SlowLimit } from "./SlowerQuick";
import { taskSystem } from "./sections";
import { TimeRange } from "./TimeRange";
import { parseAbsolute, shortTime } from "./time";

/* ---------- query model: filters as chips, free text in the input ---------- */

interface Filter {
  key: string;
  op: string;
  value: string;
}

const TOKEN = /(?:([a-z][a-z0-9_.]*)(>=|<=|!=|:|>|<)("[^"]*"|\S+))|("[^"]*"|\S+)/g;

/** A filter key the search accepts: a declared field, or a key under a prefix field like `extra.*`. */
function isKey(key: string, keys: ReadonlySet<string>): boolean {
  if (keys.has(key)) return true;
  for (const field of keys) {
    if (field.endsWith(".*") && key.startsWith(field.slice(0, -1)) && key.length > field.length - 1) return true;
  }
  return false;
}

function parseQuery(q: string, keys: ReadonlySet<string>): { filters: Filter[]; text: string } {
  const filters: Filter[] = [];
  const words: string[] = [];
  for (const match of q.matchAll(TOKEN)) {
    const [whole, key, op, value] = match;
    if (key && op && value !== undefined && isKey(key, keys))
      filters.push({ key, op, value: value.replace(/^"|"$/g, "") });
    else words.push(whole);
  }
  return { filters, text: words.join(" ") };
}

function serialize(filter: Filter): string {
  const value = /\s/.test(filter.value) ? `"${filter.value}"` : filter.value;
  return `${filter.key}${filter.op}${value}`;
}

function compose(filters: readonly Filter[], text: string): string {
  return [...filters.map(serialize), text.trim()].filter(Boolean).join(" ");
}

/* ---------- suggestions for the word being typed ---------- */

// A filter as typed: key, operator, value.
const FILTER = /^([a-z][a-z0-9_.]*)(>=|<=|!=|:|>|<)(.*)$/;
// Keys whose values come from the store (the routes, the loggers seen), not from a fixed list.
const FROM_STORE = new Set(["route", "logger", "db", "task", "job", "queue", "in", "span"]);

/** Values after `key:` that start as typed; the start of several (logger:org) offers them all with a wildcard first. */
function valueSuggestions(key: string, op: string, partial: string, values: readonly string[]): Suggestion[] {
  const matching = values.filter((value) => value.toLowerCase().startsWith(partial.toLowerCase()) && value !== partial);
  const all: Suggestion[] =
    partial && !partial.endsWith("*") && matching.length > 1
      ? [{ insert: `${key}${op}${partial}*`, label: `${key}${op}${partial}*`, help: `all ${matching.length}` }]
      : [];
  // The field's help is the same on every value: leave it out.
  const each = matching
    .slice(0, 8 - all.length)
    .map((value) => ({ insert: `${key}${op}${value}`, label: `${key}${op}${value}`, help: "" }));
  return [...all, ...each];
}

/** Field names that start as typed; prefix fields (extra.*) expand into the keys seen so far: extra.order_id… */
function fieldSuggestions(
  word: string,
  fields: Record<string, { help: string }>,
  extra: readonly string[],
): Suggestion[] {
  const names = Object.entries(fields).flatMap(([name, field]) =>
    name.endsWith(".*")
      ? extra.filter((key) => key.startsWith(name.slice(0, -1))).map((key) => [key, field.help] as const)
      : [[name, field.help] as const],
  );
  return names
    .filter(([name]) => name.startsWith(word.toLowerCase()) && name !== word)
    .slice(0, 8)
    .map(([name, help]) => ({ insert: `${name}:`, label: `${name}:`, help }));
}

/**
 * What was typed, without a filter still being typed at its end (`logger:`, `level:wa`): searched half-typed, its key
 * and colon went out as free text, and finishing it then emptied the search.
 */
function settled(text: string, keys: ReadonlySet<string>): string {
  const words = text.split(/\s+/);
  const typing = isKey(FILTER.exec(String(words.at(-1)))?.[1] ?? "", keys);
  return typing ? words.slice(0, -1).join(" ") : text;
}

// The arrows move the pick, down from none to the first, up from none to the last, and round.
const MOVES = new Map([
  ["ArrowDown", 1],
  ["ArrowUp", -1],
]);
// Enter takes the suggestion picked, Tab the picked one or, once something is typed, the first.
type Pick = (suggestions: readonly Suggestion[], cursor: number, typed: boolean) => Suggestion | undefined;
const PICKS = new Map<string, Pick>([
  ["Enter", (suggestions, cursor) => suggestions[cursor]],
  ["Tab", (suggestions, cursor, typed) => suggestions[cursor] ?? (typed ? suggestions[0] : undefined)],
]);

function moved(cursor: number, step: number, count: number): number {
  const from = step > 0 ? Math.max(cursor, -1) : Math.max(cursor, 0);
  return (from + step + count) % count;
}

/* ---------- quick filters per section ---------- */

interface QuickOption {
  label: string;
  terms: Filter[];
}

/** Values the console knows from stored data (routes, loggers, database aliases, tasks, jobs, log extras). */
export type KnownValues = Partial<
  Record<
    | "route"
    | "logger"
    | "db"
    | "task"
    | "queue"
    | "job"
    | "rpc"
    | "page"
    | "in"
    | "span"
    | "log_route"
    | "task_system"
    | "extra",
    readonly string[]
  >
> & {
  /** Each system's targets and operations, by the name its page has (`sql`, `redis`, `mongodb`…). */
  targets?: Readonly<Record<string, readonly string[]>>;
  /** The apps with rows on each page, by its section (`logs`, `calls/sql`): its App filter's choices. */
  apps?: Readonly<Record<string, readonly string[]>>;
  ops?: Readonly<Record<string, readonly string[]>>;
  /** From when each page calls a row slow, by its section (`traces`, `calls/sql`): Slower than's first pick. */
  slow?: Readonly<Record<string, SlowLimit>>;
};

interface QuickFilter {
  label: string;
  /** Heading inside the menu: says what every option means. */
  title: string;
  options: QuickOption[] | ((known: KnownValues) => QuickOption[]);
}

/** Pick any number of values of one key: becomes `key:a,b`. */
interface MultiFilter {
  label: string;
  title: string;
  key: string;
  values: readonly string[] | ((known: KnownValues) => readonly string[]);
  format?: (value: string) => string;
  /** Tailwind color for a dot before each value. */
  tone?: (value: string) => string | undefined;
  /** How a value looks elsewhere in the console (level tag, issue chip), reused in the menu. */
  display?: (value: string) => ReactNode;
}

/** The Level filter: the levels; a level and every one above it is one pick (`level>=warning`). */
interface LevelsFilter extends MultiFilter {
  levels: true;
}

/** Slower than: `duration>`, from the page's slow time (`KnownValues.slow`) or a time of one's own. */
interface SlowerControl {
  label: "Slower than";
  slower: true;
}

type Control = QuickFilter | MultiFilter | LevelsFilter | TimeControl | SlowerControl;

const isMulti = (control: Control): control is MultiFilter => "key" in control;
const isLevels = (control: Control): control is LevelsFilter => "levels" in control;
const isTime = (control: Control): control is TimeControl => "verb" in control;
const isSlower = (control: Control): control is SlowerControl => "slower" in control;

const f = (key: string, op: string, value: string): Filter => ({ key, op, value });
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const ISSUE_LABELS: Record<string, string> = {
  "n+1": "N+1",
  duplicates: "Duplicate queries",
  "slow-sql": "Slow query",
  "slow-http": "Slow HTTP call",
  "slow-call": "Slow call",
  "long-transaction": "Long transaction",
  "in-transaction": "Before commit",
  htmx: "htmx",
  "queue-wait": "Queue wait",
  "blocking-call": "Blocking call",
  "large-result": "Large result",
  "migration-risk": "Migration risk",
  error: "Error",
};

/** The time window control (TimeRange): `verb` says what the bounds apply to. */
interface TimeControl {
  label: "Time";
  verb: string;
}

const TIME: TimeControl = { label: "Time", verb: "Started" };

const ROUTE: MultiFilter = {
  label: "Route",
  title: "Filter by route",
  key: "route",
  values: (known) => known.route ?? [],
};
const METHOD: MultiFilter = { label: "Method", title: "Filter by method", key: "method", values: METHODS };
const capital = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** A GraphQL call's operation type, by the start of its operation (`operation:query*`): the overview's Type, here. */
const OPERATION_TYPE: QuickFilter = {
  label: "Type",
  title: "Filter by operation type",
  options: ["query", "mutation", "subscription"].map((type) => ({
    label: capital(type),
    terms: [f("operation", ":", `${type}*`)],
  })),
};

const STATUS: QuickFilter = {
  label: "Status",
  title: "Filter by status",
  options: [
    { label: "2xx", terms: [f("status", ">=", "200"), f("status", "<", "300")] },
    { label: "3xx", terms: [f("status", ">=", "300"), f("status", "<", "400")] },
    { label: "4xx", terms: [f("status", ">=", "400"), f("status", "<", "500")] },
    { label: "5xx", terms: [f("status", ">=", "500")] },
  ],
};
const SLOWER: SlowerControl = { label: "Slower than", slower: true };
const ISSUE: QuickFilter = {
  label: "Issue",
  title: "Filter by issue",
  options: [
    { label: "Any", terms: [f("has", ":", "issues")] },
    { label: "N+1", terms: [f("has", ":", "n+1")] },
    { label: "Duplicate queries", terms: [f("has", ":", "duplicates")] },
    { label: "Slow query", terms: [f("has", ":", "slow-sql")] },
    { label: "Slow HTTP call", terms: [f("has", ":", "slow-http")] },
    { label: "Slow call", terms: [f("has", ":", "slow-call")] },
    { label: "Long transaction", terms: [f("has", ":", "long-transaction")] },
    { label: "Before commit", terms: [f("has", ":", "in-transaction")] },
    { label: "htmx", terms: [f("has", ":", "htmx")] },
    { label: "Queue wait", terms: [f("has", ":", "queue-wait")] },
    { label: "Blocking call", terms: [f("has", ":", "blocking-call")] },
    { label: "Large result", terms: [f("has", ":", "large-result")] },
    { label: "Migration risk", terms: [f("has", ":", "migration-risk")] },
    { label: "Error", terms: [f("has", ":", "error")] },
  ],
};
const CONTAINS: QuickFilter = {
  label: "Contains",
  title: "Produced",
  options: [
    { label: "Logs", terms: [f("has", ":", "logs")] },
    { label: "Emails", terms: [f("has", ":", "mail")] },
  ],
};
/** A task in a menu: cut where a task's name is everywhere, in the menu's own type. */
const taskItem = (task: string) => <TaskName name={task} className="font-sans" />;
const TASK: MultiFilter = {
  label: "Task",
  title: "Filter by task",
  key: "task",
  values: (known) => known.task ?? [],
  display: taskItem,
};
const STATE: MultiFilter = {
  label: "State",
  title: "Filter by outcome",
  key: "state",
  values: ["success", "failure", "retry"],
  format: capital,
};
/**
 * Every page's App filter: the app a row came from, by its trace's service, `service:` as the sidebar's app scope
 * says it. Offered when two apps or more have rows on the page; with one app, or the sidebar on one, there is
 * nothing to pick.
 */
function appFilter(page: string): MultiFilter {
  return {
    label: "App",
    title: "Filter by app",
    key: "service",
    values: (known) => {
      const apps = known.apps?.[page] ?? [];
      return apps.length > 1 ? apps : [];
    },
    display: (app) => <AppChip name={app} compact />,
  };
}
const QUEUE: MultiFilter = {
  label: "Queue",
  title: "Filter by queue",
  key: "queue",
  values: (known) => known.queue ?? [],
};

const FAILED: QuickFilter = {
  label: "Outcome",
  title: "Filter by outcome",
  options: [{ label: "Failed", terms: [f("failed", ":", "true")] }],
};

/** Redis's own filter: who sent the command. */
const VIA: MultiFilter = {
  label: "Via",
  title: "Sent by",
  key: "via",
  values: ["direct", "cache", "task"],
  format: (value) => ({ direct: "The app", cache: "A cache", task: "A task queue" })[value] ?? value,
};

/**
 * A system's page: the same filters for every system — when, where to (its targets as the agent knows them), which
 * operation, failed or not — with the target and the operations named as the system has them.
 */
function systemFilters(system: string, family: Family | undefined): Control[] {
  const meta = systemOfPage(system, family);
  const target: MultiFilter = {
    label: meta.target,
    title: `Filter by ${meta.target.toLowerCase()}`,
    key: "target",
    values: (known) => known.targets?.[system] ?? [],
  };
  const operations: MultiFilter = {
    label: "Operation",
    title: "Filter by operation",
    key: "op",
    // What the store has seen, else what the system is known to do.
    values: (known) => known.ops?.[system] ?? meta.ops,
  };
  return [{ ...TIME, verb: "Called" }, target, operations, SLOWER, FAILED, ...(meta.family === "redis" ? [VIA] : [])];
}

const QUICK: Record<Exclude<Section, CallsSection>, Control[]> = {
  traces: [TIME, STATUS, METHOD, ROUTE, SLOWER, ISSUE, CONTAINS],
  logs: [
    { ...TIME, verb: "Logged" },
    {
      label: "Level",
      title: "Filter by level",
      key: "level",
      values: LEVELS,
      // As the table and the chart name it.
      format: (level) => level.toUpperCase(),
      display: (level) => <LogLevel level={level} />,
      levels: true,
    } satisfies LevelsFilter,
    { label: "Logger", title: "Filter by logger", key: "logger", values: (known) => known.logger ?? [] },
    // The routes whose requests logged anything: the others would find nothing here.
    { ...ROUTE, values: (known) => known.log_route ?? [] },
    // Records a task or a job wrote: shown when the project has any.
    TASK,
    { label: "Job", title: "Filter by job", key: "job", values: (known) => known.job ?? [] },
    // Where in the work it was logged: inside a Kafka call, a SQL query, a view.
    {
      label: "Inside",
      title: "Logged inside",
      key: "in",
      values: (known) => known.in ?? [],
    },
  ],
  errors: [{ ...TIME, verb: "Last seen" }, ROUTE],
  // Time first, as on every page; then the type of issue.
  issues: [
    { ...TIME, verb: "Last seen" },
    {
      label: "Type",
      title: "Filter by type",
      key: "kind",
      values: [
        "n+1",
        "duplicates",
        "slow-sql",
        "slow-http",
        "slow-call",
        "long-transaction",
        "in-transaction",
        "htmx",
        "queue-wait",
        "blocking-call",
        "large-result",
        "migration-risk",
      ],
      format: (value) => ISSUE_LABELS[value] ?? value,
      display: (kind) => <IssueChip kind={kind as IssueKind} />,
    },
    ROUTE,
  ],
  endpoints: [{ ...TIME, verb: "Called" }, METHOD, ROUTE, SLOWER],
  tasks: [
    { ...TIME, verb: "Ran" },
    TASK,
    STATE,
    QUEUE,
    {
      label: "System",
      title: "Filter by what ran them",
      key: "system",
      // What this project's tasks ran on: no Celery in a Java app.
      values: (known) => known.task_system ?? [],
      format: taskSystem,
    },
    SLOWER,
  ],
  aws: [{ ...TIME, verb: "Called" }, FAILED],
  mails: [{ ...TIME, verb: "Sent" }],
  pages: [
    { ...TIME, verb: "Viewed" },
    { label: "Page", title: "Filter by page", key: "page", values: (known) => known.page ?? [] },
    SLOWER,
  ],
  rpc: [
    { ...TIME, verb: "Called" },
    { label: "Method", title: "Filter by method", key: "rpc", values: (known) => known.rpc ?? [] },
    { label: "System", title: "Filter by RPC system", key: "system", values: ["grpc"] },
    SLOWER,
  ],
  jobs: [
    { ...TIME, verb: "Ran" },
    // By name: the command ("manage.py import_posts") or what the code named its block (trace("nightly import")).
    { label: "Job", title: "Filter by job", key: "job", values: (known) => known.job ?? [] },
    {
      label: "Source",
      title: "Filter by source",
      key: "source",
      values: ["manage.py", "custom"],
      format: (value) => (value === "custom" ? "Traced in code" : "Django command"),
    },
    SLOWER,
  ],
  graphql: [
    { ...TIME, verb: "Called" },
    {
      label: "Type",
      title: "Filter by type",
      key: "type",
      values: ["query", "mutation", "subscription"],
      format: capital,
    },
    SLOWER,
  ],
  websockets: [
    { ...TIME, verb: "Handled" },
    {
      label: "Event",
      title: "Filter by event",
      key: "event",
      values: ["connect", "receive", "disconnect"],
      format: capital,
    },
    SLOWER,
  ],
  services: [
    { ...TIME, verb: "Called" },
    {
      label: "Kind",
      title: "Filter by kind",
      key: "kind",
      values: ["app", "database", "cache", "storage", "mail", "queue", "http"],
      format: capital,
    },
    {
      label: "Role",
      title: "Filter by role",
      key: "role",
      values: ["web", "worker", "command", "browser"],
      format: capital,
    },
  ],
};

/**
 * The list of calls of an entry point searches traces, but offers only what makes sense for its calls: a task run
 * has no HTTP method or route.
 */
const CALLS: Record<EntrySection, Control[]> = {
  endpoints: QUICK.traces,
  graphql: [{ ...TIME, verb: "Called" }, OPERATION_TYPE, SLOWER, ISSUE, CONTAINS],
  tasks: [{ ...TIME, verb: "Ran" }, TASK, STATE, QUEUE, SLOWER, ISSUE],
  websockets: [{ ...TIME, verb: "Handled" }, SLOWER, ISSUE, CONTAINS],
  jobs: [{ ...TIME, verb: "Ran" }, SLOWER, ISSUE, CONTAINS],
  rpc: [{ ...TIME, verb: "Called" }, SLOWER, ISSUE, CONTAINS],
  pages: [{ ...TIME, verb: "Viewed" }, SLOWER, ISSUE, CONTAINS],
};

const CALLS_EXAMPLE: Record<EntrySection, string> = {
  endpoints: "status>=500 since:1h",
  graphql: "duration>500ms since:1h",
  tasks: "state:failure since:1h",
  websockets: "has:error since:1h",
  jobs: "has:error since:1d",
  rpc: "has:error since:1h",
  pages: "has:error since:1h",
};

const VALUES: Record<string, string[]> = {
  has: [
    "n+1",
    "duplicates",
    "slow-sql",
    "slow-http",
    "slow-call",
    "long-transaction",
    "in-transaction",
    "htmx",
    "queue-wait",
    "blocking-call",
    "large-result",
    "migration-risk",
    "error",
    "issues",
    "logs",
    "mail",
  ],
  method: METHODS,
  kind: [
    "http",
    "task",
    "command",
    "websocket",
    "rpc",
    "page",
    "n+1",
    "duplicates",
    "slow-sql",
    "slow-http",
    "slow-call",
    "long-transaction",
    "in-transaction",
    "htmx",
    "queue-wait",
    "blocking-call",
    "large-result",
    "migration-risk",
    "error",
  ],
  level: ["debug", "info", "warning", "error", "critical"],
  status: ["200", "302", "400", "404", "500"],
  duration: ["100ms", "500ms", "1s"],
  since: ["5m", "15m", "1h", "1d"],
  until: ["5m", "15m", "1h", "1d"],
};

/** Where the agent's search spec describes a section's fields: every system's page searches operations. */
function searchResourceOf(section: Section): SearchResource {
  if (systemOfSection(section)) return "calls";
  return (section === "errors" ? "issues" : section) as SearchResource;
}

/** The placeholder's example: an entry point's calls', a system's first operation, else the section's own. */
function exampleFor(section: Section, family: Family | undefined, callsOf: EntrySection | undefined): string {
  if (callsOf) return CALLS_EXAMPLE[callsOf];
  const system = systemOfSection(section);
  if (!system) return EXAMPLE[section as keyof typeof EXAMPLE];
  const op = systemOfPage(system, family).ops[0];
  return op ? `op:${op}` : "failed:true";
}

/** The filter chips: an entry point's calls', a system's, else the section's own; the App filter after Time. */
function controlsFor(section: Section, family: Family | undefined, callsOf: EntrySection | undefined): Control[] {
  const [first, ...rest] = ownControls(section, family, callsOf);
  const app = appFilter(callsOf ?? section);
  if (!first) return [app];
  return isTime(first) ? [first, app, ...rest] : [app, first, ...rest];
}

function ownControls(section: Section, family: Family | undefined, callsOf: EntrySection | undefined): Control[] {
  if (callsOf) return CALLS[callsOf];
  const system = systemOfSection(section);
  return system ? systemFilters(system, family) : QUICK[section as keyof typeof QUICK];
}

/* ---------- component ---------- */

/** since:/until: chips show the local time, not the full ISO string (it stays in the query and the tooltip). */
function chipValue(filter: Filter): string {
  if (filter.key !== "since" && filter.key !== "until") return filter.value;
  const date = parseAbsolute(filter.value);
  return date ? shortTime(date) : filter.value;
}

const EXAMPLE: Record<Exclude<Section, CallsSection>, string> = {
  traces: "status>=500 since:1h",
  endpoints: "route:/api/* since:1h",
  tasks: "state:failure",
  services: "kind:database",
  jobs: "source:custom",
  rpc: "rpc:helloworld.Greeter/*",
  pages: "page:/books/*",
  websockets: "event:receive",
  graphql: "type:mutation",
  aws: "aws:S3 op:GetObject",
  mails: "to:ann@example.com",
  logs: "level:error",
  errors: "ZeroDivisionError route:/api/*",
  issues: "kind:n+1",
};

interface Suggestion {
  insert: string;
  label: string;
  help: string;
  /** The start of a filter (`extra.`): taking it leaves it in the box to type on, as a field's `key:` does. */
  more?: boolean;
}

type Fields = Record<string, { help: string }>;

/**
 * The fields the page searches by, each once with its help, for an empty box: what there is to filter by before a
 * letter is typed. A prefix field (`extra.*`) offers its prefix, and its keys come up as it is typed on.
 */
function allFields(fields: Fields): Suggestion[] {
  return Object.entries(fields).map(([name, { help }]) =>
    name.endsWith(".*")
      ? { insert: name.slice(0, -1), label: name, help, more: true }
      : { insert: `${name}:`, label: `${name}:`, help },
  );
}

/** What the store (or a fixed list) knows of a key's values: the routes after `route:`, the levels after `level:`. */
function knownValues(key: string, known: KnownValues): string[] {
  const stored = FROM_STORE.has(key) ? (known as Record<string, unknown>)[key] : VALUES[key];
  return Array.isArray(stored) ? (stored as string[]) : [];
}

/** Suggestions for a word being typed: field names, or a filter's values once its key and operator are there. */
function typedSuggestions(word: string, keys: ReadonlySet<string>, fields: Fields, known: KnownValues): Suggestion[] {
  const valueMatch = FILTER.exec(word);
  if (!valueMatch) return fieldSuggestions(word, fields, known.extra ?? []);
  const [, key = "", op = ":", partial = ""] = valueMatch;
  return isKey(key, keys) ? valueSuggestions(key, op, partial, knownValues(key, known)) : [];
}

/** Suggestions for the word being typed; with none (an empty box, or after a space), every field the page has. */
function useSuggestions(word: string, keys: ReadonlySet<string>, fields: Fields, known: KnownValues): Suggestion[] {
  return useMemo(
    () => (word ? typedSuggestions(word, keys, fields, known) : allFields(fields)),
    [word, keys, fields, known],
  );
}

/**
 * The suggestion picked with the arrows; -1, none: Enter then takes what was typed, Tab the first suggestion. With
 * nothing typed, Tab leaves the box as it would without the list: the list there is a guide, not a guess.
 */
function usePicker(suggestions: readonly Suggestion[], typed: boolean, accept: (suggestion: Suggestion) => void) {
  const [cursor, setCursor] = useState(-1);
  /** The arrows pick a suggestion, Enter takes the picked one, Tab the picked or the first: whether it was one of them. */
  const onKey = (event: BoxKeyEvent<HTMLInputElement>): boolean => {
    const step = MOVES.get(event.key);
    // Enter with none picked takes what was typed, as typed: not a suggestion's key then.
    const done = step ? move(step) : take(PICKS.get(event.key)?.(suggestions, cursor, typed));
    if (done) event.preventDefault();
    return done;
  };
  const move = (step: number) => {
    setCursor(moved(cursor, step, suggestions.length));
    return true;
  };
  const take = (chosen: Suggestion | undefined) => {
    if (chosen) accept(chosen);
    return chosen !== undefined;
  };
  return { cursor, setCursor, onKey };
}

type Parsed = ReturnType<typeof parseQuery>;

/** The text in the box, and the search it sends: typed text debounced, a filter being typed held back. */
function useBoxText(
  q: string,
  parsed: Parsed,
  keys: ReadonlySet<string>,
  onChange: (q: string, typed?: boolean) => void,
) {
  const [text, setText] = useState(parsed.text);
  // The search this box sent last: when `q` comes back as exactly that, it is the box's own echo and the text stays as
  // typed (a trailing space included). Any other `q` (a chip, a quick filter, Back) replaces the text.
  const sent = useRef<string | null>(null);
  useEffect(() => {
    // No q (a section's address without ?q=) is the empty search the box sent itself, not another one.
    if ((q ?? "") !== sent.current) setText(parsed.text);
  }, [q, parsed.text]);
  // Free text is debounced; chips apply at once. A filter being typed (`state:fai`) stays in the box and out of the
  // search until it is finished with a space, Enter or a suggestion: searching it half-typed would turn it into a
  // chip mid-word and send the rest of the typing into an empty box.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = compose(parsed.filters, parseQuery(settled(text, keys), keys).text);
      if (next !== compose(parsed.filters, parsed.text)) {
        sent.current = next;
        onChange(next, true);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [text, parsed, keys, onChange]);
  return { text, setText, sent };
}

/** `/` anywhere but in a text box goes to the search. */
function useSlashFocus(input: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "/" && document.activeElement?.tagName !== "INPUT") {
        event.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [input]);
}

/** A typed filter as a chip: `status>=500`. */
const filterOf = ([, key = "", op = ":", value = ""]: RegExpExecArray): Filter => ({ key, op, value });

interface Box {
  text: string;
  setText: (text: string) => void;
  parsed: Parsed;
  keys: ReadonlySet<string>;
  onChange: (q: string, typed?: boolean) => void;
  sent: RefObject<string | null>;
  input: RefObject<HTMLInputElement | null>;
}

/** Filters as chips: a suggestion taken, typed filters finished, a chip back into the box to change it. */
function useChipEditing(box: Box, word: string, resetCursor: () => void) {
  const { text, setText, parsed, keys, onChange, sent, input } = box;
  const setFilters = (filters: Filter[], nextText = text) => onChange(compose(filters, nextText));

  const accept = (suggestion: Suggestion) => {
    const head = text.slice(0, text.length - word.length);
    if (suggestion.more || suggestion.insert.endsWith(":")) setText(`${head}${suggestion.insert}`);
    else {
      // A complete filter becomes a chip.
      const match = FILTER.exec(suggestion.insert);
      if (match) setFilters([...parsed.filters, filterOf(match)], head);
      setText(head);
    }
    resetCursor();
    input.current?.focus();
  };

  /** A chip back into the box as text, to change it: Enter or a space makes it a chip again. */
  const edit = (index: number) => {
    const filter = parsed.filters[index];
    if (!filter) return;
    const next = compose(
      parsed.filters.filter((_, i) => i !== index),
      parsed.text,
    );
    // The query without it, but the box keeps the text being edited.
    sent.current = next;
    onChange(next);
    const typed = `${text.trim() ? `${text.trim()} ` : ""}${serialize(filter)}`;
    setText(typed);
    resetCursor();
    window.setTimeout(() => {
      input.current?.focus();
      input.current?.setSelectionRange(typed.length, typed.length);
    }, 0);
  };

  const commitTypedFilters = () => {
    // "status>=500 " typed by hand turns into a chip as soon as it is complete.
    const reparsed = parseQuery(text, keys);
    if (reparsed.filters.length > 0) {
      setFilters([...parsed.filters, ...reparsed.filters], reparsed.text);
      setText(reparsed.text);
    }
  };

  /** Backspace on an empty box takes the last chip back. */
  const dropLast = () => {
    if (text === "" && parsed.filters.length > 0) setFilters(parsed.filters.slice(0, -1));
  };

  const remove = (index: number) => setFilters(parsed.filters.filter((_, i) => i !== index));

  return { setFilters, accept, edit, commitTypedFilters, dropLast, remove };
}

/** The menu open among the quick filters; a menu left open belongs to the page it was opened on. */
function useOpenMenu(section: Section) {
  const [open, setOpen] = useState<string | null>(null);
  const [menuSection, setMenuSection] = useState(section);
  if (menuSection !== section) {
    setMenuSection(section);
    setOpen(null);
  }
  return [open, setOpen] as const;
}

/**
 * Whether the suggestions show: while the box has the focus, until Escape puts them away (typing or focusing again
 * brings them back).
 */
function useListShown() {
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  return {
    shown: focused && !dismissed,
    focus: () => {
      setFocused(true);
      setDismissed(false);
    },
    blur: () => window.setTimeout(() => setFocused(false), 120),
    dismiss: () => setDismissed(true),
    typed: () => setDismissed(false),
  };
}

function FilterChip({ filter, onEdit, onRemove }: { filter: Filter; onEdit: () => void; onRemove: () => void }) {
  return (
    <Badge
      variant="outline"
      className="h-7 gap-0.5 rounded-md border-brand/35 bg-brand-soft pr-0.5 pl-2 font-mono text-base font-normal"
    >
      <button
        type="button"
        aria-label={`Edit ${serialize(filter)}`}
        title={`${serialize(filter)}: click to edit`}
        className="flex cursor-text items-baseline rounded-sm"
        onClick={onEdit}
      >
        <span className="text-brand">{filter.key}</span>
        <span className="text-muted-foreground">{filter.op}</span>
        <span>{chipValue(filter)}</span>
      </button>
      <button
        type="button"
        aria-label={`Remove ${serialize(filter)}`}
        className="ml-0.5 grid size-5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={onRemove}
      >
        <XIcon className="size-3" />
      </button>
    </Badge>
  );
}

/** A suggestion in the list: the picked one keeps itself in view as the arrows move through a long list. */
function SuggestionItem({
  suggestion,
  active,
  onPick,
}: {
  suggestion: Suggestion;
  active: boolean;
  onPick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <button
      ref={ref}
      type="button"
      data-active={active ? "" : undefined}
      className="flex w-full min-w-0 items-baseline gap-4 rounded-sm px-2.5 py-1.5 text-left text-base text-muted-foreground hover:bg-accent data-[active]:bg-accent data-[active]:text-foreground"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPick}
    >
      <code
        className={cn(
          "min-w-0 truncate font-mono text-sm font-semibold text-brand",
          suggestion.help ? "w-40 shrink-0" : "flex-1",
        )}
      >
        {suggestion.label}
      </code>
      {suggestion.help ? <span className="min-w-0 truncate">{suggestion.help}</span> : null}
    </button>
  );
}

/** The suggestions under the box; for an empty box, the page's fields under a heading that says so. */
function SuggestionList({
  suggestions,
  cursor,
  fields,
  onPick,
}: {
  suggestions: readonly Suggestion[];
  cursor: number;
  fields: boolean;
  onPick: (suggestion: Suggestion) => void;
}) {
  return (
    <div className="absolute top-[4.5rem] left-10 z-30 max-h-96 w-[min(560px,calc(100%-5rem))] overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg">
      {fields ? <p className="px-2.5 pt-1.5 pb-1 text-sm font-medium text-muted-foreground">Filter by</p> : null}
      {suggestions.map((suggestion, index) => (
        <SuggestionItem
          key={suggestion.insert}
          suggestion={suggestion}
          active={index === cursor}
          onPick={() => onPick(suggestion)}
        />
      ))}
    </div>
  );
}

/** How many results the search shows: "14 shown", or "14 of 1,204 shown". */
function ShownCount({ count }: { count: number | string | undefined }) {
  if (count === undefined) return null;
  return <span className="ml-auto text-base text-muted-foreground tabular-nums">{count} shown</span>;
}

/** Clear while there is a search, else the `/` that focuses the box. */
function ClearOrHint({ q, onClear }: { q: string; onClear: () => void }) {
  return q ? (
    <Button variant="ghost" size="sm" className="h-7 text-muted-foreground" onClick={onClear}>
      Clear
    </Button>
  ) : (
    <kbd className="mr-1 rounded border px-1.5 font-mono text-xs text-muted-foreground">/</kbd>
  );
}

export interface SearchBarProps {
  section: Section;
  /** A system's page: its family, for the filters' words (from the agent's counts). */
  family?: Family | undefined;
  q: string;
  spec: SearchSpec | null;
  error: string | null;
  /** Values from stored data, offered in menus and after `route:`, `logger:`, `db:`; undefined until loaded. */
  known: KnownValues | undefined;
  /** Results shown for the current query, if known: a number, or "14 of 1,204" when more match than are shown. */
  count?: number | string | undefined;
  /** The list of this entry point's calls: its own quick filters on the traces search. */
  callsOf?: EntrySection | undefined;
  /** `typed`: the box's own debounced text, which replaces the history entry; a chip or a menu adds one. */
  onChange: (q: string, typed?: boolean) => void;
}

/** The word being typed: the text's last; none after a space. */
const lastWord = (text: string): string => text.split(/\s+/).at(-1) ?? "";

/** The fields a page's search has, as the agent's spec describes them. */
function fieldsOf(spec: SearchSpec | null, section: Section): Fields {
  // Errors are the issues of kind error: the same search.
  return spec?.[searchResourceOf(section)] ?? {};
}

/** The box: its text, its suggestions, the chips it makes and what its keys do. */
function useSearchBox({ section, q, spec, known, onChange }: SearchBarProps) {
  const fields = fieldsOf(spec, section);
  const keys = useMemo(() => new Set(Object.keys(fields)), [fields]);
  const parsed = useMemo(() => parseQuery(q, keys), [q, keys]);
  const input = useRef<HTMLInputElement>(null);
  const { text, setText, sent } = useBoxText(q, parsed, keys, onChange);
  useSlashFocus(input);
  const word = lastWord(text);
  const suggestions = useSuggestions(word, keys, fields, known ?? NO_KNOWN);
  const list = useListShown();
  const reset = () => picker.setCursor(-1);
  const chips = useChipEditing({ text, setText, parsed, keys, onChange, sent, input }, word, reset);
  const picker = usePicker(suggestions, word !== "", chips.accept);
  // Enter makes what was typed chips, Backspace on an empty box takes the last chip back, Escape empties the box and
  // puts the suggestions away.
  const boxKeys = new Map<string, () => void>([
    ["Enter", chips.commitTypedFilters],
    ["Backspace", chips.dropLast],
    [
      "Escape",
      () => {
        setText("");
        list.dismiss();
      },
    ],
  ]);
  const showSuggestions = list.shown && suggestions.length > 0;
  return {
    parsed,
    input,
    text,
    word,
    suggestions,
    showSuggestions,
    list,
    picker,
    chips,
    onType: (value: string) => {
      setText(value);
      reset();
      list.typed();
      if (value.endsWith(" ")) window.setTimeout(chips.commitTypedFilters, 0);
    },
    onKey: (event: BoxKeyEvent<HTMLInputElement>) => {
      if (!(showSuggestions && picker.onKey(event))) boxKeys.get(event.key)?.();
    },
  };
}

export function SearchBar(props: SearchBarProps) {
  const { section, family, q, error, known, count, callsOf, onChange } = props;
  const box = useSearchBox(props);
  const [open, setOpen] = useOpenMenu(section);
  const { parsed, chips } = box;
  return (
    <div className="relative px-10 pt-5 pb-6">
      <div
        data-error={error ? "" : undefined}
        className={cn(
          "flex min-h-10 flex-wrap items-center gap-2 rounded-lg border border-input bg-background py-1 pr-2 pl-3.5 light:min-h-9 light:bg-card",
          "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30",
          "data-[error]:border-error",
        )}
      >
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        {parsed.filters.map((filter, index) => (
          <FilterChip
            // biome-ignore lint/suspicious/noArrayIndexKey: a chip is a position in the query; a filter may repeat.
            key={`${serialize(filter)}:${index}`}
            filter={filter}
            onEdit={() => chips.edit(index)}
            onRemove={() => chips.remove(index)}
          />
        ))}
        <input
          ref={box.input}
          type="search"
          value={box.text}
          placeholder={placeholderFor(parsed.filters.length > 0, section, family, callsOf)}
          aria-label="Search"
          spellCheck={false}
          className="h-9 min-w-40 flex-1 bg-transparent font-mono text-md outline-none light:h-8 light:text-sm placeholder:font-sans placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
          onFocus={box.list.focus}
          onBlur={box.list.blur}
          onChange={(event) => box.onType(event.target.value)}
          onKeyDown={box.onKey}
        />
        <ClearOrHint q={q} onClear={() => onChange("")} />
      </div>
      {box.showSuggestions ? (
        <SuggestionList
          suggestions={box.suggestions}
          cursor={box.picker.cursor}
          fields={box.word === ""}
          onPick={chips.accept}
        />
      ) : null}
      {error ? <p className="mt-2 text-base text-error">{error}</p> : null}
      <FilterRow
        controls={controlsFor(section, family, callsOf)}
        page={callsOf ?? section}
        known={known}
        filters={parsed.filters}
        open={open}
        setOpen={setOpen}
        setFilters={chips.setFilters}
        count={count}
      />
    </div>
  );
}

/**
 * The quick filters and how many results show. Its height is kept from the start: the filters arrive with the values
 * they offer, all at once, and the count beside them, and nothing under them moves.
 */
function FilterRow({
  controls,
  page,
  known,
  filters,
  open,
  setOpen,
  setFilters,
  count,
}: {
  controls: Control[];
  /** The page's section, as `KnownValues` keys its values. */
  page: string;
  known: KnownValues | undefined;
  filters: Filter[];
  open: string | null;
  setOpen: (label: string | null) => void;
  setFilters: (filters: Filter[]) => void;
  count: number | string | undefined;
}) {
  const shown = known ? controls : [];
  return (
    <fieldset
      className="m-0 mt-4 flex min-h-[1.875rem] min-w-0 flex-wrap items-center gap-2.5 border-0 p-0"
      aria-label="Filters"
    >
      {shown.map((control) => (
        <QuickControl
          key={control.label}
          control={control}
          page={page}
          known={known ?? NO_KNOWN}
          filters={filters}
          open={open === control.label}
          onToggle={() => setOpen(open === control.label ? null : control.label)}
          onChange={(next, close) => {
            setFilters(next);
            if (close) setOpen(null);
          }}
        />
      ))}
      <ShownCount count={count} />
    </fieldset>
  );
}

/** The box's placeholder: an example of the page's search, or, with chips already, that more may be added. */
function placeholderFor(
  chips: boolean,
  section: Section,
  family: Family | undefined,
  callsOf: EntrySection | undefined,
): string {
  return chips ? "Add text or filters…" : `Search or type a filter, e.g. ${exampleFor(section, family, callsOf)}`;
}

interface QuickControlProps {
  control: Control;
  page: string;
  known: KnownValues;
  filters: Filter[];
  open: boolean;
  onToggle: () => void;
  onChange: (filters: Filter[], close: boolean) => void;
}

/** A quick filter as its kind shows it: the time range, a level, a pick of values, or a pick of one option. */
function QuickControl(props: QuickControlProps) {
  const View = viewOf(props.control);
  return <View {...props} />;
}

function viewOf(control: Control): (props: QuickControlProps) => ReactNode {
  if (isTime(control)) return TimeQuick;
  if (isSlower(control)) return SlowerView;
  if (isLevels(control)) return LevelQuick;
  return isMulti(control) ? MultiQuick : OptionsQuick;
}

/** A menu's open state as a Popover reports it: a change only toggles it. */
const openChange = (open: boolean, onToggle: () => void) => (next: boolean) => next !== open && onToggle();

function TimeQuick({ control, filters, open, onToggle, onChange }: QuickControlProps) {
  const bound = (key: string) => filters.find((item) => item.key === key && item.op === ":")?.value;
  return (
    <TimeRange
      since={bound("since")}
      until={bound("until")}
      verb={(control as TimeControl).verb}
      open={open}
      onOpenChange={openChange(open, onToggle)}
      onChange={(since, until) => {
        const rest = filters.filter((item) => item.key !== "since" && item.key !== "until");
        const next = [...rest];
        if (since) next.push(f("since", ":", since));
        if (until) next.push(f("until", ":", until));
        onChange(next, true);
      }}
    />
  );
}

/** Slower than, from the page's slow time as the agent knows it. */
function SlowerView({ page, known, filters, open, onToggle, onChange }: QuickControlProps) {
  return (
    <SlowerQuick
      filters={filters}
      limit={known.slow?.[page]}
      open={open}
      onOpenChange={openChange(open, onToggle)}
      onChange={onChange}
      make={f}
    />
  );
}

/** A multi filter's values: its own list, or what the store knows. */
function valuesOf(control: MultiFilter, known: KnownValues): readonly string[] {
  return typeof control.values === "function" ? control.values(known) : control.values;
}

/** The values a `key:a,b` filter has picked. */
function pickedOf(current: Filter | undefined): Set<string> {
  return new Set(current ? current.value.split(",").filter(Boolean) : []);
}

/** What a menu's button says of its pick: the one value, or how many. */
function pickSummary(picked: ReadonlySet<string>, format: (value: string) => string): string | null {
  if (picked.size === 0) return null;
  return picked.size === 1 ? format([...picked][0] ?? "") : `${picked.size} selected`;
}

/** A value in or out of a pick. */
function flipped(picked: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(picked);
  if (!next.delete(value)) next.add(value);
  return next;
}

const asIs = (value: string) => value;

/** The menu's rows for a multi filter's values: each as the console shows it elsewhere. */
function multiItems(control: MultiFilter, values: readonly string[], picked: ReadonlySet<string>): FilterItem[] {
  const format = control.format ?? asIs;
  return values.map((value) => ({
    value,
    label: format(value),
    selected: picked.has(value),
    tone: control.tone?.(value),
    display: control.display?.(value),
  }));
}

/** The filters with one key's pick: `key:a,b` in the menu's order, so the query reads the same however clicked. */
function withPick(rest: Filter[], key: string, values: readonly string[], picked: ReadonlySet<string>): Filter[] {
  const ordered = values.filter((item) => picked.has(item));
  return ordered.length ? [...rest, f(key, ":", ordered.join(","))] : rest;
}

function MultiQuick({ control, known, filters, open, onToggle, onChange }: QuickControlProps) {
  const multi = control as MultiFilter;
  const values = valuesOf(multi, known);
  if (values.length === 0) return null;
  const current = filters.find((item) => item.key === multi.key && item.op === ":");
  const picked = pickedOf(current);
  const rest = filters.filter((item) => item !== current);
  return (
    <FilterMenu
      label={multi.label}
      title={multi.title}
      searchKey={multi.key}
      summary={pickSummary(picked, multi.format ?? asIs)}
      items={multiItems(multi, values, picked)}
      multiple={true}
      open={open}
      onOpenChange={openChange(open, onToggle)}
      onSelect={(value) => onChange(withPick(rest, multi.key, values, flipped(picked, value)), false)}
      onClear={() => onChange(rest, true)}
    />
  );
}

function optionsOf(quick: QuickFilter, known: KnownValues): QuickOption[] {
  return typeof quick.options === "function" ? quick.options(known) : quick.options;
}

/** The option whose terms the search has, all of them. */
function activeOption(options: readonly QuickOption[], filters: readonly Filter[]): QuickOption | undefined {
  return options.find((option) =>
    option.terms.every((term) => filters.some((item) => serialize(item) === serialize(term))),
  );
}

function OptionsQuick({ control, known, filters, open, onToggle, onChange }: QuickControlProps) {
  const quick = control as QuickFilter;
  const options = optionsOf(quick, known);
  if (options.length === 0) return null;
  // Replace only this control's own terms: `has:` is shared by Issue and Contains.
  const owned = new Set(options.flatMap((option) => option.terms.map(serialize)));
  const rest = filters.filter((item) => !owned.has(serialize(item)));
  const active = activeOption(options, filters);
  return (
    <FilterMenu
      label={quick.label}
      title={quick.title}
      summary={active?.label ?? null}
      items={options.map((option) => ({ value: option.label, label: option.label, selected: option === active }))}
      multiple={false}
      open={open}
      onOpenChange={openChange(open, onToggle)}
      onSelect={(label) => {
        const option = options.find((item) => item.label === label);
        if (option) onChange(option === active ? rest : [...rest, ...option.terms], true);
      }}
      onClear={() => onChange(rest, true)}
    />
  );
}

/* ---------- the Level filter: the levels, a pick of a level and every one above it said so ---------- */

/** The levels a search's level filter lets through: `level>=warning`'s, else `level:a,b`'s. */
function levelPick(filters: readonly Filter[]): Set<string> {
  const from = filters.find((item) => item.key === "level" && item.op === ">=")?.value;
  if (from) return new Set(levelsFrom(from));
  return pickedOf(filters.find((item) => item.key === "level" && item.op === ":"));
}

/** The filters with a pick of levels: `level>=warning` for a level and every one above it, else `level:a,b`. */
function withLevels(rest: Filter[], picked: ReadonlySet<string>): Filter[] {
  if (picked.size === 0) return rest;
  const { op, value } = levelTerm(picked);
  return [...rest, f("level", op, value)];
}

/**
 * A level's row: its tag, as in the table, and on hover the "and above" that picks it and every level above it (not
 * on the lowest, that is every level, nor on the highest, that is itself).
 */
function levelItems(control: LevelsFilter, picked: ReadonlySet<string>, onAbove: (level: string) => void) {
  return multiItems(control, LEVELS, picked).map(
    (item): FilterItem =>
      item.value === LEVELS[0] || item.value === LEVELS.at(-1)
        ? item
        : {
            ...item,
            action: { label: "and above", title: `${item.label} and above`, onClick: () => onAbove(item.value) },
          },
  );
}

function LevelQuick({ control, filters, open, onToggle, onChange }: QuickControlProps) {
  const levels = control as LevelsFilter;
  const picked = levelPick(filters);
  const rest = filters.filter((item) => item.key !== "level");
  return (
    <FilterMenu
      label={levels.label}
      title={levels.title}
      searchKey="level"
      summary={levelSummary(picked)}
      items={levelItems(levels, picked, (level) => onChange(withLevels(rest, new Set(levelsFrom(level))), false))}
      multiple={true}
      open={open}
      onOpenChange={openChange(open, onToggle)}
      onSelect={(value) => onChange(withLevels(rest, flipped(picked, value)), false)}
      onClear={() => onChange(rest, true)}
    />
  );
}
