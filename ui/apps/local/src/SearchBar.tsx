import { IssueChip, type IssueKind, type SearchResource, type SearchSpec } from "@tracepanel/ui";
import { Badge } from "@tracepanel/ui/components/ui/badge";
import { Button } from "@tracepanel/ui/components/ui/button";
import { type Family, systemOfPage } from "@tracepanel/ui/lib/systems";
import { cn } from "@tracepanel/ui/lib/utils";
import { SearchIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { FilterMenu } from "./FilterMenu";
import { type CallsSection, type EntrySection, type Section, systemOfSection } from "./routes";
import { TimeRange } from "./TimeRange";
import { parseAbsolute, shortTime } from "./time";
import { LevelBadge } from "./ui";

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

/* ---------- quick filters per section ---------- */

interface QuickOption {
  label: string;
  terms: Filter[];
}

/** Values the console knows from stored data (routes, loggers, database aliases, tasks, jobs, log extras). */
export type KnownValues = Partial<
  Record<"route" | "logger" | "db" | "task" | "queue" | "job" | "extra", readonly string[]>
> & {
  /** Each system's targets and operations, by the name its page has (`sql`, `redis`, `mongodb`…). */
  targets?: Readonly<Record<string, readonly string[]>>;
  ops?: Readonly<Record<string, readonly string[]>>;
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

type Control = QuickFilter | MultiFilter | TimeControl;

const isMulti = (control: Control): control is MultiFilter => "key" in control;
const isTime = (control: Control): control is TimeControl => "verb" in control;

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
const DURATION: QuickFilter = {
  label: "Duration",
  title: "Slower than",
  options: [
    { label: "100 ms", terms: [f("duration", ">", "100ms")] },
    { label: "500 ms", terms: [f("duration", ">", "500ms")] },
    { label: "1 s", terms: [f("duration", ">", "1s")] },
  ],
};
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
const TASK: MultiFilter = { label: "Task", title: "Filter by task", key: "task", values: (known) => known.task ?? [] };
const STATE: MultiFilter = {
  label: "State",
  title: "Filter by outcome",
  key: "state",
  values: ["success", "failure", "retry"],
  format: capital,
};
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
  return [{ ...TIME, verb: "Called" }, target, operations, FAILED, ...(meta.family === "redis" ? [VIA] : [])];
}

const QUICK: Record<Exclude<Section, CallsSection>, Control[]> = {
  traces: [TIME, STATUS, METHOD, ROUTE, DURATION, ISSUE, CONTAINS],
  logs: [
    { ...TIME, verb: "Logged" },
    {
      label: "Level",
      title: "Filter by level",
      key: "level",
      values: ["debug", "info", "warning", "error", "critical"],
      format: capital,
      display: (level) => <LevelBadge level={level} />,
    },
    { label: "Logger", title: "Filter by logger", key: "logger", values: (known) => known.logger ?? [] },
    ROUTE,
  ],
  errors: [{ ...TIME, verb: "Last seen" }, ROUTE],
  issues: [
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
      ],
      format: (value) => ISSUE_LABELS[value] ?? value,
      display: (kind) => <IssueChip kind={kind as IssueKind} />,
    },
    { ...TIME, verb: "Last seen" },
    ROUTE,
  ],
  endpoints: [{ ...TIME, verb: "Called" }, METHOD, ROUTE],
  tasks: [
    { ...TIME, verb: "Ran" },
    TASK,
    STATE,
    QUEUE,
    {
      label: "System",
      title: "Filter by queue system",
      key: "system",
      values: ["celery", "dramatiq", "rq", "django"],
      format: (value) => ({ django: "Django Tasks", rq: "RQ" })[value] ?? capital(value),
    },
  ],
  mails: [{ ...TIME, verb: "Sent" }],
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
  ],
  services: [
    { ...TIME, verb: "Called" },
    {
      label: "Kind",
      title: "Filter by kind",
      key: "kind",
      values: ["app", "database", "cache", "mail", "queue", "http"],
      format: capital,
    },
    { label: "Role", title: "Filter by role", key: "role", values: ["web", "worker", "command"], format: capital },
  ],
};

/**
 * The list of calls of an entry point searches traces, but offers only what makes sense for its calls: a task run
 * has no HTTP method or route.
 */
const CALLS: Record<EntrySection, Control[]> = {
  endpoints: QUICK.traces,
  graphql: [{ ...TIME, verb: "Called" }, DURATION, ISSUE, CONTAINS],
  tasks: [{ ...TIME, verb: "Ran" }, TASK, STATE, QUEUE, DURATION, ISSUE],
  websockets: [{ ...TIME, verb: "Handled" }, DURATION, ISSUE, CONTAINS],
  jobs: [{ ...TIME, verb: "Ran" }, DURATION, ISSUE, CONTAINS],
};

const CALLS_EXAMPLE: Record<EntrySection, string> = {
  endpoints: "status>=500 since:1h",
  graphql: "duration>500ms since:1h",
  tasks: "state:failure since:1h",
  websockets: "has:error since:1h",
  jobs: "has:error since:1d",
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

/** The filter chips: an entry point's calls', a system's, else the section's own. */
function controlsFor(section: Section, family: Family | undefined, callsOf: EntrySection | undefined): Control[] {
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
  websockets: "event:receive",
  graphql: "type:mutation",
  mails: "to:ann@example.com",
  logs: "level:error",
  errors: "ZeroDivisionError route:/api/*",
  issues: "kind:n+1",
};

interface Suggestion {
  insert: string;
  label: string;
  help: string;
}

export interface SearchBarProps {
  section: Section;
  /** A system's page: its family, for the filters' words (from the agent's counts). */
  family?: Family | undefined;
  q: string;
  spec: SearchSpec | null;
  error: string | null;
  /** Values from stored data, offered in menus and after `route:`, `logger:`, `db:`. */
  known: KnownValues;
  /** Results shown for the current query, if known. */
  count?: number | undefined;
  /** The list of this entry point's calls: its own quick filters on the traces search. */
  callsOf?: EntrySection | undefined;
  /** `typed`: the box's own debounced text, which replaces the history entry; a chip or a menu adds one. */
  onChange: (q: string, typed?: boolean) => void;
}

export function SearchBar({ section, family, q, spec, error, known, count, callsOf, onChange }: SearchBarProps) {
  // Errors are the issues of kind error: the same search.
  const fields = spec?.[searchResourceOf(section)] ?? {};
  const keys = useMemo(() => new Set(Object.keys(fields)), [fields]);
  const parsed = useMemo(() => parseQuery(q, keys), [q, keys]);
  const [text, setText] = useState(parsed.text);
  const [open, setOpen] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // The search this box sent last: when `q` comes back as exactly that, it is the box's own echo and the text stays as
  // typed (a trailing space included). Any other `q` (a chip, a quick filter, Back) replaces the text.
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (q !== sent.current) setText(parsed.text);
  }, [q, parsed.text]);
  // Free text is debounced; chips apply at once. A filter being typed (`state:fai`) stays in the box and out of the
  // search until it is finished with a space, Enter or a suggestion: searching it half-typed would turn it into a
  // chip mid-word and send the rest of the typing into an empty box.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = compose(parsed.filters, parseQuery(text, keys).text);
      if (next !== compose(parsed.filters, parsed.text)) {
        sent.current = next;
        onChange(next, true);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [text, parsed, keys, onChange]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "/" && document.activeElement?.tagName !== "INPUT") {
        event.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const setFilters = (filters: Filter[], nextText = text) => onChange(compose(filters, nextText));

  // Suggestions for the word being typed: field names first, then values after `key:`.
  const word = text.split(/\s+/).at(-1) ?? "";
  const suggestions: Suggestion[] = useMemo(() => {
    if (!word) return [];
    const valueMatch = /^([a-z][a-z0-9_.]*)(>=|<=|!=|:|>|<)(.*)$/.exec(word);
    if (valueMatch) {
      const [, key = "", op = ":", partial = ""] = valueMatch;
      if (!isKey(key, keys)) return [];
      const values =
        (key === "route" || key === "logger" || key === "db" || key === "task" || key === "queue"
          ? known[key]
          : VALUES[key]) ?? [];
      return values
        .filter((value) => value.toLowerCase().startsWith(partial.toLowerCase()) && value !== partial)
        .slice(0, 8)
        .map((value) => ({
          insert: `${key}${op}${value}`,
          label: `${key}${op}${value}`,
          // The field's help is the same on every value: leave it out.
          help: "",
        }));
    }
    // Prefix fields (extra.*) expand into the keys seen so far: extra.order_id, extra.user_id…
    const names = Object.entries(fields).flatMap(([name, field]) =>
      name.endsWith(".*")
        ? (known.extra ?? [])
            .filter((key) => key.startsWith(name.slice(0, -1)))
            .map((key) => [key, field.help] as const)
        : [[name, field.help] as const],
    );
    return names
      .filter(([name]) => name.startsWith(word.toLowerCase()) && name !== word)
      .slice(0, 8)
      .map(([name, help]) => ({ insert: `${name}:`, label: `${name}:`, help }));
  }, [word, keys, fields, known]);

  const accept = (suggestion: Suggestion) => {
    const head = text.slice(0, text.length - word.length);
    if (suggestion.insert.endsWith(":")) {
      setText(`${head}${suggestion.insert}`);
    } else {
      // A complete filter becomes a chip.
      const match = /^([a-z][a-z0-9_.]*)(>=|<=|!=|:|>|<)(.*)$/.exec(suggestion.insert);
      if (match)
        setFilters([...parsed.filters, { key: match[1] ?? "", op: match[2] ?? ":", value: match[3] ?? "" }], head);
      setText(head);
    }
    setCursor(0);
    input.current?.focus();
  };

  const commitTypedFilters = () => {
    // "status>=500 " typed by hand turns into a chip as soon as it is complete.
    const reparsed = parseQuery(text, keys);
    if (reparsed.filters.length > 0) {
      setFilters([...parsed.filters, ...reparsed.filters], reparsed.text);
      setText(reparsed.text);
    }
  };

  // A menu left open belongs to the page it was opened on.
  const [menuSection, setMenuSection] = useState(section);
  if (menuSection !== section) {
    setMenuSection(section);
    setOpen(null);
  }

  const quick = controlsFor(section, family, callsOf);
  const showSuggestions = focused && suggestions.length > 0;

  return (
    <div className="relative px-10 pt-5 pb-6">
      <div
        data-error={error ? "" : undefined}
        className={cn(
          "flex min-h-12 flex-wrap items-center gap-2 rounded-lg border border-input bg-background py-1.5 pr-2 pl-3.5",
          "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30",
          "data-[error]:border-error",
        )}
      >
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        {parsed.filters.map((filter, index) => (
          <Badge
            // biome-ignore lint/suspicious/noArrayIndexKey: a chip is a position in the query; a filter may repeat.
            key={`${serialize(filter)}:${index}`}
            variant="outline"
            className="h-7 gap-0.5 rounded-md border-brand/35 bg-brand-soft pr-0.5 pl-2 font-mono text-base font-normal"
          >
            <span className="text-brand">{filter.key}</span>
            <span className="text-muted-foreground">{filter.op}</span>
            <span title={filter.value}>{chipValue(filter)}</span>
            <button
              type="button"
              aria-label={`Remove ${serialize(filter)}`}
              className="ml-0.5 grid size-5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setFilters(parsed.filters.filter((_, i) => i !== index))}
            >
              <XIcon className="size-3" />
            </button>
          </Badge>
        ))}
        <input
          ref={input}
          type="search"
          value={text}
          placeholder={
            parsed.filters.length
              ? "Add text or filters…"
              : `Search or type a filter, e.g. ${exampleFor(section, family, callsOf)}`
          }
          aria-label="Search"
          spellCheck={false}
          className="h-9 min-w-40 flex-1 bg-transparent font-mono text-md outline-none placeholder:font-sans placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
          onFocus={() => setFocused(true)}
          onBlur={() => window.setTimeout(() => setFocused(false), 120)}
          onChange={(event) => {
            setText(event.target.value);
            setCursor(0);
            if (event.target.value.endsWith(" ")) window.setTimeout(commitTypedFilters, 0);
          }}
          onKeyDown={(event) => {
            const suggestion = suggestions[cursor];
            if (showSuggestions && event.key === "ArrowDown") {
              event.preventDefault();
              setCursor((cursor + 1) % suggestions.length);
            } else if (showSuggestions && event.key === "ArrowUp") {
              event.preventDefault();
              setCursor((cursor - 1 + suggestions.length) % suggestions.length);
            } else if (showSuggestions && suggestion && (event.key === "Enter" || event.key === "Tab")) {
              event.preventDefault();
              accept(suggestion);
            } else if (event.key === "Enter") {
              commitTypedFilters();
            } else if (event.key === "Backspace" && text === "" && parsed.filters.length > 0) {
              setFilters(parsed.filters.slice(0, -1));
            } else if (event.key === "Escape") {
              setText("");
            }
          }}
        />
        {q ? (
          <Button variant="ghost" size="sm" className="h-7 text-muted-foreground" onClick={() => onChange("")}>
            Clear
          </Button>
        ) : (
          <kbd className="mr-1 rounded border px-1.5 font-mono text-xs text-muted-foreground">/</kbd>
        )}
      </div>
      {showSuggestions ? (
        <div className="absolute top-[4.5rem] left-10 z-30 w-[min(560px,calc(100%-5rem))] rounded-lg border bg-popover p-1 shadow-lg">
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.insert}
              type="button"
              data-active={index === cursor ? "" : undefined}
              className="flex w-full min-w-0 items-baseline gap-4 rounded-sm px-2.5 py-1.5 text-left text-base text-muted-foreground hover:bg-accent data-[active]:bg-accent data-[active]:text-foreground"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => accept(suggestion)}
            >
              <code
                className={`min-w-0 truncate font-mono text-sm font-semibold text-brand ${suggestion.help ? "w-40 shrink-0" : "flex-1"}`}
              >
                {suggestion.label}
              </code>
              {suggestion.help ? <span className="min-w-0 truncate">{suggestion.help}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      {error ? <p className="mt-2 text-base text-error">{error}</p> : null}
      <div className="mt-4 flex flex-wrap items-center gap-2.5">
        {quick.map((control) => (
          <QuickControl
            key={control.label}
            control={control}
            known={known}
            filters={parsed.filters}
            open={open === control.label}
            onToggle={() => setOpen(open === control.label ? null : control.label)}
            onChange={(filters, close) => {
              setFilters(filters);
              if (close) setOpen(null);
            }}
          />
        ))}
        {count !== undefined ? (
          <span className="ml-auto text-base text-muted-foreground tabular-nums">{count} shown</span>
        ) : null}
      </div>
    </div>
  );
}

interface QuickControlProps {
  control: Control;
  known: KnownValues;
  filters: Filter[];
  open: boolean;
  onToggle: () => void;
  onChange: (filters: Filter[], close: boolean) => void;
}

function QuickControl({ control, known, filters, open, onToggle, onChange }: QuickControlProps) {
  const onOpenChange = (next: boolean) => next !== open && onToggle();
  if (isTime(control)) {
    const bound = (key: string) => filters.find((item) => item.key === key && item.op === ":")?.value;
    return (
      <TimeRange
        since={bound("since")}
        until={bound("until")}
        verb={control.verb}
        open={open}
        onOpenChange={onOpenChange}
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
  if (isMulti(control)) {
    const values = typeof control.values === "function" ? control.values(known) : control.values;
    if (values.length === 0) return null;
    const format = control.format ?? ((value: string) => value);
    const current = filters.find((item) => item.key === control.key && item.op === ":");
    const picked = new Set(current ? current.value.split(",").filter(Boolean) : []);
    const rest = filters.filter((item) => item !== current);
    return (
      <FilterMenu
        label={control.label}
        title={control.title}
        summary={
          picked.size === 0 ? null : picked.size === 1 ? format([...picked][0] ?? "") : `${picked.size} selected`
        }
        items={values.map((value) => ({
          value,
          label: format(value),
          selected: picked.has(value),
          tone: control.tone?.(value),
          display: control.display?.(value),
        }))}
        multiple={true}
        open={open}
        onOpenChange={onOpenChange}
        onSelect={(value) => {
          const next = new Set(picked);
          if (next.has(value)) next.delete(value);
          else next.add(value);
          // Keep the menu's order so the query reads the same however values were clicked.
          const ordered = values.filter((item) => next.has(item));
          onChange(ordered.length ? [...rest, f(control.key, ":", ordered.join(","))] : rest, false);
        }}
        onClear={() => onChange(rest, true)}
      />
    );
  }
  const options = typeof control.options === "function" ? control.options(known) : control.options;
  if (options.length === 0) return null;
  // Replace only this control's own terms: `has:` is shared by Issue and Contains.
  const owned = new Set(options.flatMap((option) => option.terms.map(serialize)));
  const rest = filters.filter((item) => !owned.has(serialize(item)));
  const active = options.find((option) =>
    option.terms.every((term) => filters.some((item) => serialize(item) === serialize(term))),
  );
  return (
    <FilterMenu
      label={control.label}
      title={control.title}
      summary={active?.label ?? null}
      items={options.map((option) => ({ value: option.label, label: option.label, selected: option === active }))}
      multiple={false}
      open={open}
      onOpenChange={onOpenChange}
      onSelect={(label) => {
        const option = options.find((item) => item.label === label);
        if (option) onChange(option === active ? rest : [...rest, ...option.terms], true);
      }}
      onClear={() => onChange(rest, true)}
    />
  );
}
