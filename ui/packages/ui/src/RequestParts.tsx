import { useState } from "react";
import { CopyButton } from "./CopyButton";
import { cn } from "./lib/utils";
import type { Attrs } from "./types";

// What the request carried and what its response said, as the app's SDK recorded them (this machine only), shown as
// browser devtools show a request: one part at a time, picked from a row of tabs.
const PREFIXES = {
  headers: "http.request.header.",
  cookies: "http.request.cookie.",
  session: "session.",
  response: "http.response.header.",
} as const;
const KEYS = new Set(["url.query", "http.request.body", "http.request.body.truncated"]);

/** Shown in the request's parts: not again among all the attributes. */
export function isRequestDetail(key: string): boolean {
  return KEYS.has(key) || Object.values(PREFIXES).some((prefix) => key.startsWith(prefix));
}

type Pair = [name: string, value: string];

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** A header as HTTP spells it: attribute keys take no dashes, so content-type was kept as content_type. */
function dashed(key: string): string {
  return key.replaceAll("_", "-");
}

function under(attrs: Attrs, prefix: string, name: (key: string) => string = (key) => key): Pair[] {
  return Object.entries(attrs)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]): Pair => [name(key.slice(prefix.length)), text(value)])
    .sort(([a], [b]) => a.localeCompare(b));
}

function queryPairs(query: unknown): Pair[] {
  return typeof query === "string" && query ? [...new URLSearchParams(query)] : [];
}

/** What a browser sends with every request: kept, but out of the way of the headers the app chose or read. */
function fromBrowser(name: string): boolean {
  return /^(sec-|accept|connection$|dnt$|upgrade-insecure-requests$|user-agent$|cache-control$|pragma$|priority$|te$)/.test(
    name,
  );
}

/** A body as it reads best: JSON indented, anything else as it came. */
function readable(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

interface Part {
  id: string;
  label: string;
  count?: number | undefined;
  pairs?: Pair[];
}

function parts(attrs: Attrs): Part[] {
  const all: Part[] = [
    { id: "headers", label: "Headers", pairs: under(attrs, PREFIXES.headers, dashed) },
    { id: "query", label: "Query", pairs: queryPairs(attrs["url.query"]) },
    { id: "body", label: "Body" },
    { id: "cookies", label: "Cookies", pairs: under(attrs, PREFIXES.cookies) },
    { id: "session", label: "Session", pairs: under(attrs, PREFIXES.session) },
    { id: "response", label: "Response", pairs: under(attrs, PREFIXES.response, dashed) },
  ];
  const hasBody = typeof attrs["http.request.body"] === "string";
  return all
    .filter((part) => (part.pairs ? part.pairs.length > 0 : hasBody))
    .map((part) => ({ ...part, count: part.pairs?.length }));
}

/** The request's parts, one at a time: headers, query, body, cookies, session, the response's headers. */
export function RequestParts({ attrs }: { attrs: Attrs }) {
  const shown = parts(attrs);
  const [picked, setPicked] = useState<string | null>(null);
  const open = shown.find((part) => part.id === picked) ?? shown[0];
  if (!open) return null;
  return (
    <section className="grid gap-2" aria-label="What the request carried">
      <div className="flex flex-wrap items-center gap-1 border-b" role="tablist">
        {shown.map((part) => (
          <button
            type="button"
            role="tab"
            key={part.id}
            aria-selected={part === open}
            onClick={() => setPicked(part.id)}
            className={cn(
              "-mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-sm transition-colors",
              part === open
                ? "border-brand font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {part.label}
            {part.count ? <span className="text-xs text-muted-foreground tabular-nums">{part.count}</span> : null}
          </button>
        ))}
      </div>
      <PartView part={open} attrs={attrs} />
    </section>
  );
}

/** How each part is shown: the body as text, the headers with the browser's folded, the rest as names and values. */
const VIEWS: Record<string, (props: { part: Part; attrs: Attrs }) => React.ReactNode> = {
  body: ({ attrs }) => <Body attrs={attrs} />,
  headers: ({ part }) => <Headers pairs={part.pairs ?? []} />,
};

function PartView({ part, attrs }: { part: Part; attrs: Attrs }) {
  const View = VIEWS[part.id] ?? (({ part: shown }) => <Pairs pairs={shown.pairs ?? []} />);
  return <View part={part} attrs={attrs} />;
}

/** The headers the app chose or read first; the browser's own folded under a line that opens them. */
function Headers({ pairs }: { pairs: readonly Pair[] }) {
  const [all, setAll] = useState(false);
  const browser = pairs.filter(([name]) => fromBrowser(name));
  const own = pairs.filter(([name]) => !fromBrowser(name));
  return (
    <div className="grid gap-1">
      <Pairs pairs={all ? [...own, ...browser] : own} />
      {browser.length ? (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="justify-self-start px-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {all ? "Hide the browser's headers" : `+${browser.length} the browser sends with every request`}
        </button>
      ) : null}
    </div>
  );
}

/** Names and values, packed: a fixed column of names, values that wrap, a copy button on hover. */
function Pairs({ pairs }: { pairs: readonly Pair[] }) {
  return (
    <dl className="m-0 grid grid-cols-[minmax(7rem,12rem)_minmax(0,1fr)_auto] font-mono text-xs">
      {pairs.map(([name, value]) => (
        <div key={name} className="group/pair contents">
          <dt className="truncate py-1 pr-3 text-muted-foreground" title={name}>
            {name}
          </dt>
          <dd className="m-0 py-1 [overflow-wrap:anywhere]">{value}</dd>
          <span className="flex items-start pl-1">
            <CopyButton
              text={value}
              label={`Copy ${name}`}
              className="size-5 opacity-0 transition-opacity group-hover/pair:opacity-100 focus-visible:opacity-100"
            />
          </span>
        </div>
      ))}
    </dl>
  );
}

/** A form's fields as names and values; any other body as text. */
function Body({ attrs }: { attrs: Attrs }) {
  const form = String(attrs["http.request.header.content_type"] ?? "").startsWith("application/x-www-form-urlencoded");
  return form ? <Pairs pairs={queryPairs(attrs["http.request.body"])} /> : <TextBody attrs={attrs} />;
}

function TextBody({ attrs }: { attrs: Attrs }) {
  const body = text(attrs["http.request.body"]);
  return (
    <div className="grid gap-1">
      <pre className="m-0 max-h-96 overflow-auto rounded-md bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">
        {readable(body)}
      </pre>
      {attrs["http.request.body.truncated"] === true ? (
        <p className="text-xs text-muted-foreground">Cut at 16 KB.</p>
      ) : null}
    </div>
  );
}
