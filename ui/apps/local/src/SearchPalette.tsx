import { ago, type DataSource, duration, MethodBadge, type TraceSummary } from "@tracepanel/ui";
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
import { go, openTrace, type Section, TRACE_ID } from "./routes";
import { NAV } from "./Sidebar";
import { graphqlOperation } from "./sections";

const SHOWN = 8;
const DEBOUNCE_MS = 150;

const KIND_BADGES: Record<string, string> = { task: "TASK", command: "JOB", websocket: "WS" };

/** The badge and the name of a trace in one line: GQL query PostList, GET /posts/1/, TASK send_campaign. */
function label(trace: TraceSummary): { badge: string; name: string } {
  const operation = graphqlOperation(trace);
  if (operation) return { badge: "GQL", name: operation };
  if (trace.kind === "http") return { badge: trace.method ?? "", name: trace.path ?? trace.name };
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
  sections,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: DataSource;
  /** Menu sections shown in the console (empty entry points are hidden there and here). */
  sections: Set<Section>;
}) {
  const [text, setText] = useState("");
  const [results, setResults] = useState<TraceSummary[]>([]);
  const query = text.trim();

  useEffect(() => {
    if (!query || TRACE_ID.test(query.toUpperCase())) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      source.searchTraces(query, null).then(
        (page) => !cancelled && setResults(page.items.slice(0, SHOWN)),
        // An unfinished filter (`status>`) is not an error worth showing here.
        () => !cancelled && setResults([]),
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
  const matching = NAV.filter(
    (item) => sections.has(item.section) && (!query || item.label.toLowerCase().includes(query.toLowerCase())),
  );

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
          <CommandList className="max-h-[420px]">
            <CommandEmpty>No traces match.</CommandEmpty>
            {TRACE_ID.test(query.toUpperCase()) ? (
              <CommandGroup heading="Trace">
                <CommandItem value={`id-${query}`} onSelect={() => close(() => openTrace(query.toUpperCase()))}>
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
                    <CommandItem key={trace.id} value={trace.id} onSelect={() => close(() => openTrace(trace.id))}>
                      <MethodBadge method={badge} htmx={trace.htmx} />
                      <span className="min-w-0 flex-1 truncate font-mono text-[14px]">{name}</span>
                      <span className="text-[13px] text-muted-foreground tabular-nums">
                        {duration(trace.duration)} · {ago(trace.start)}
                      </span>
                    </CommandItem>
                  );
                })}
                <CommandItem value="all" onSelect={() => close(() => go({ name: "traces", q: query }))}>
                  <SearchIcon />
                  Search all traces for <span className="font-mono">{query}</span>
                </CommandItem>
              </CommandGroup>
            ) : null}
            {matching.length > 0 ? (
              <CommandGroup heading="Go to">
                {matching.map(({ section, label: name, icon: Icon }) => (
                  <CommandItem
                    key={section}
                    value={`go-${section}`}
                    onSelect={() => close(() => go({ name: section, q: "" }))}
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
