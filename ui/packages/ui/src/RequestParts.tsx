import { type ReactNode, useState } from "react";
import { ChevronDownIcon } from "./icons";
import { indentedJson } from "./json";
import { cn } from "./lib/utils";
import { NameValues } from "./NameValues";
import { Segmented } from "./Segmented";
import type { Attrs } from "./types";

// What the request carried and what its response said, as the app's SDK recorded them (this machine only), and every
// other attribute: one card, one part at a time, as browser devtools show a request.
const PREFIXES = {
  headers: "http.request.header.",
  cookies: "http.request.cookie.",
  session: "session.",
  response: "http.response.header.",
} as const;
const KEYS = new Set(["url.query", "http.request.body", "http.request.body.truncated"]);

/** Shown in the request's own parts: not again among the other attributes. */
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
  return indentedJson(body) ?? body;
}

/** The other attributes by namespace (`code.*`, `http.*`…), keys without it; keys with none last. */
function grouped(attrs: Attrs): [string, Pair[]][] {
  const groups = new Map<string, Pair[]>();
  for (const [key, value] of Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b))) {
    const [name, rest] = namespaced(key);
    groups.set(name, [...(groups.get(name) ?? []), [rest, text(value)]]);
  }
  return [...groups].sort(([a], [b]) => Number(a === "other") - Number(b === "other"));
}

/** A key's namespace and the rest of it; a key without one is in "other", whole. */
function namespaced(key: string): [string, string] {
  const dot = key.indexOf(".");
  return dot === -1 ? ["other", key] : [key.slice(0, dot), key.slice(dot + 1)];
}

/** A part shown in the card: its tab's name and count, and what it shows. */
export interface Part {
  id: string;
  label: string;
  count?: number | undefined;
  content: ReactNode;
  /** Shown as it is, not in the card: content made of cards of its own. */
  bare?: boolean;
}

function pairsPart(id: string, label: string, pairs: Pair[]): Part[] {
  return pairs.length ? [{ id, label, count: pairs.length, content: <Pairs pairs={pairs} /> }] : [];
}

function bodyPart(attrs: Attrs): Part[] {
  return typeof attrs["http.request.body"] === "string"
    ? [{ id: "body", label: "Body", content: <Body attrs={attrs} /> }]
    : [];
}

function headersPart(attrs: Attrs): Part[] {
  const pairs = under(attrs, PREFIXES.headers, dashed);
  return pairs.length
    ? [{ id: "headers", label: "Headers", count: pairs.length, content: <Headers pairs={pairs} /> }]
    : [];
}

/** The request's parts, then the given ones (a GraphQL query), then every other attribute. */
export function requestParts(attrs: Attrs, others: Attrs, extra: readonly Part[] = []): Part[] {
  const groups = grouped(others);
  return [
    ...headersPart(attrs),
    ...pairsPart("query", "Query", queryPairs(attrs["url.query"])),
    ...bodyPart(attrs),
    ...pairsPart("cookies", "Cookies", under(attrs, PREFIXES.cookies)),
    ...pairsPart("session", "Session", under(attrs, PREFIXES.session)),
    ...pairsPart("response", "Response", under(attrs, PREFIXES.response, dashed)),
    ...extra,
    {
      id: "attributes",
      label: "Attributes",
      count: Object.keys(others).length,
      content: <Groups groups={groups} />,
      bare: true,
    },
  ];
}

/** The parts as one card: a switch above it, the chosen part inside. The switch stays on its part across traces. */
export function RequestParts({ parts }: { parts: readonly Part[] }) {
  const [picked, setPicked] = useState<string | null>(null);
  const open = parts.find((part) => part.id === picked) ?? parts[0];
  if (!open) return null;
  return (
    <section className="grid gap-2" aria-label="Request details">
      <Segmented
        label="Request details"
        segments={parts.map(({ id, label, count }) => ({ id, label, count }))}
        value={open.id}
        onChange={setPicked}
      />
      {open.bare ? (
        <div role="tabpanel" aria-label={open.label}>
          {open.content}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card" role="tabpanel" aria-label={open.label}>
          {open.content}
        </div>
      )}
    </section>
  );
}

/** The headers the app chose or read first; the browser's own folded under a row that opens them. */
function Headers({ pairs }: { pairs: readonly Pair[] }) {
  const [all, setAll] = useState(false);
  const browser = pairs.filter(([name]) => fromBrowser(name));
  const own = pairs.filter(([name]) => !fromBrowser(name));
  return (
    <>
      <Pairs pairs={all ? [...own, ...browser] : own} />
      <BrowserHeaders count={browser.length} open={all} onToggle={() => setAll(!all)} />
    </>
  );
}

/** The row that opens or folds the browser's own headers, when it sent any. */
function BrowserHeaders({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  if (!count) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-1.5 border-t px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
    >
      <span className={cn("flex transition-transform [&_svg]:size-3.5", open && "rotate-180")}>
        <ChevronDownIcon />
      </span>
      {open ? "Hide the browser's own headers" : `${count} more the browser sends with every request`}
    </button>
  );
}

/** Names and values, as every such list shows them. */
function Pairs({ pairs }: { pairs: readonly Pair[] }) {
  return <NameValues rows={pairs.map(([name, value]) => ({ name, value }))} />;
}

/** A card per namespace, its name and count above it: groups apart at a glance, names lined up across them. */
function Groups({ groups }: { groups: readonly [string, Pair[]][] }) {
  if (!groups.length) {
    return <p className="rounded-lg border bg-card px-3 py-2 text-xs text-muted-foreground">No other attributes.</p>;
  }
  return (
    <div className="grid gap-4">
      {groups.map(([name, pairs]) => (
        <section key={name} className="grid gap-1.5" aria-label={name}>
          <h4 className="flex items-baseline gap-1.5 px-1 text-[11px] font-semibold tracking-wider text-foreground/80 uppercase">
            {name}
            <span className="font-normal text-muted-foreground tabular-nums">{pairs.length}</span>
          </h4>
          <div className="overflow-hidden rounded-lg border bg-card">
            <Pairs pairs={pairs} />
          </div>
        </section>
      ))}
    </div>
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
    <>
      <pre className="m-0 max-h-96 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap">{readable(body)}</pre>
      {attrs["http.request.body.truncated"] === true ? (
        <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">Cut at 16 KB.</p>
      ) : null}
    </>
  );
}
