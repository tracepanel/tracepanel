import {
  ago,
  type DataSource,
  duration,
  type EndpointRow,
  IssueIcon,
  type IssueRow,
  MethodBadge,
  plural,
  RoutePath,
  TaskName,
  TraceBadge,
  type TraceSummary,
} from "@tracepanel/ui";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@tracepanel/ui/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@tracepanel/ui/components/ui/dialog";
import { ArrowRightIcon, SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { endpointGroup, go, issueRoute, openTrace, type Route, TRACE_ID } from "./routes";
import type { NavItem } from "./Sidebar";
import { graphqlOperation, requestPath } from "./sections";

const SHOWN = 8;
// Endpoints and issues are a shortcut past the traces: a few of each.
const SHOWN_GROUPS = 4;
const DEBOUNCE_MS = 150;

const KIND_BADGES: Record<string, string> = { task: "TASK", command: "JOB", websocket: "WS" };

/** The badge and the name of a trace in one line: GQL query PostList, GET /posts/1/, TASK send_campaign. */
function label(trace: TraceSummary): { badge: string; name: string } {
  const operation = graphqlOperation(trace);
  if (operation) return { badge: "GQL", name: operation };
  if (trace.kind === "http") return { badge: trace.method ?? "", name: requestPath(trace) };
  return { badge: KIND_BADGES[trace.kind] ?? trace.kind, name: trace.name.replace(/^WS /, "") };
}

/**
 * ⌘K: any trace, wherever it came from. A trace id opens it; text searches names and paths (filters work too:
 * `status>=500`, `task:send_*`); "Search all" lists every match; the sections are a keystroke away.
 */
export function SearchPalette({
  open,
  onOpenChange,
  source,
  items,
  openRoute,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: DataSource;
  /** The pages to go to, as the sidebar lists them (empty entry points hidden, a page per system called). */
  items: readonly NavItem[];
  /** How a choice opens: the console goes there; the panel opens traces itself and the rest in the console. */
  openRoute?: ((route: Route) => void) | undefined;
}) {
  const [text, setText] = useState("");
  const [results, setResults] = useState<TraceSummary[]>([]);
  const [endpoints, setEndpoints] = useState<EndpointRow[]>([]);
  const [issues, setIssues] = useState<IssueRow[]>([]);
  const openTo = openRoute ?? ((route: Route) => (route.name === "trace" ? openTrace(route.id) : go(route)));
  const query = text.trim();

  useEffect(() => {
    if (!query || TRACE_ID.test(query.toUpperCase())) {
      setResults([]);
      setEndpoints([]);
      setIssues([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      // An unfinished filter (`status>`), or one a list does not take, is no error worth showing here.
      source.searchTraces(query, null).then(
        (page) => !cancelled && setResults(page.items.slice(0, SHOWN)),
        () => !cancelled && setResults([]),
      );
      source.listEndpoints(query).then(
        (rows) => !cancelled && setEndpoints(rows.slice(0, SHOWN_GROUPS)),
        () => !cancelled && setEndpoints([]),
      );
      source.listIssues(query).then(
        (rows) => !cancelled && setIssues(rows.slice(0, SHOWN_GROUPS)),
        () => !cancelled && setIssues([]),
      );
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, source]);

  const close = (then: () => void) => {
    onOpenChange(false);
    setText("");
    then();
  };
  const matching = items.filter((item) => !query || item.label.toLowerCase().includes(query.toLowerCase()));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[20%] translate-y-0 overflow-hidden p-0 sm:max-w-2xl" showCloseButton={false}>
        <DialogTitle className="sr-only">Search traces</DialogTitle>
        <DialogDescription className="sr-only">A trace id, a name, a path or a search with filters</DialogDescription>
        <Command shouldFilter={false} className="[&_[cmdk-item]]:px-3 [&_[cmdk-item]]:py-2.5">
          <CommandInput
            value={text}
            onValueChange={setText}
            placeholder="Trace id, name, path, or a search: status>=500, task:send_*"
          />
          <CommandList className="max-h-[26.25rem]">
            <CommandEmpty>No traces match.</CommandEmpty>
            {TRACE_ID.test(query.toUpperCase()) ? (
              <CommandGroup heading="Trace">
                <CommandItem
                  value={`id-${query}`}
                  onSelect={() => close(() => openTo({ name: "trace", id: query.toUpperCase() }))}
                >
                  <ArrowRightIcon />
                  Open trace <span className="font-mono">{query}</span>
                </CommandItem>
              </CommandGroup>
            ) : null}
            {results.length > 0 ? (
              <CommandGroup heading="Traces">
                {results.map((trace) => {
                  const { badge, name } = label(trace);
                  return (
                    <CommandItem
                      key={trace.id}
                      value={trace.id}
                      onSelect={() => close(() => openTo({ name: "trace", id: trace.id }))}
                    >
                      <TraceBadge word={badge} htmx={trace.htmx} />
                      {trace.kind === "task" ? (
                        <TaskName name={name} className="flex-1 text-base" />
                      ) : (
                        <span className="min-w-0 flex-1 truncate font-mono text-base">{name}</span>
                      )}
                      <span className="text-sm text-muted-foreground tabular-nums">
                        {duration(trace.duration)} · {ago(trace.start)}
                      </span>
                    </CommandItem>
                  );
                })}
                <CommandItem value="all" onSelect={() => close(() => openTo({ name: "traces", q: query }))}>
                  <SearchIcon />
                  Search all traces for <span className="font-mono">{query}</span>
                </CommandItem>
              </CommandGroup>
            ) : null}
            {endpoints.length > 0 ? (
              <CommandGroup heading="Endpoints">
                {endpoints.map((row) => (
                  <CommandItem
                    key={`${row.method} ${row.route}`}
                    value={`endpoint-${row.method} ${row.route}`}
                    onSelect={() => close(() => openTo(endpointGroup(row.method, row.route)))}
                  >
                    <MethodBadge method={row.method} />
                    <span className="min-w-0 flex-1 truncate font-mono text-base">
                      <RoutePath path={row.route} />
                    </span>
                    <span className="text-sm text-muted-foreground tabular-nums">
                      {plural(row.calls, "call", "calls")}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {issues.length > 0 ? (
              <CommandGroup heading="Issues">
                {issues.map((issue) => (
                  <CommandItem
                    key={issue.fingerprint}
                    value={`issue-${issue.fingerprint}`}
                    onSelect={() => close(() => openTo(issueRoute(issue.fingerprint, issue.kind)))}
                  >
                    <IssueIcon kind={issue.kind} />
                    <span className="min-w-0 flex-1 truncate text-base">{issue.title}</span>
                    <span className="text-sm text-muted-foreground tabular-nums">last {ago(issue.last_seen)}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {matching.length > 0 ? (
              <CommandGroup heading="Go to">
                {matching.map(({ section, label: name, icon: Icon }) => (
                  <CommandItem
                    key={section}
                    value={`go-${section}`}
                    onSelect={() => close(() => openTo({ name: section, q: "" }))}
                  >
                    <Icon />
                    {name}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
