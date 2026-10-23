import { type ReactNode, useContext, useState } from "react";
import { AttributeGroups } from "./Attributes";
import { bytes } from "./format";
import { ChevronDownIcon } from "./icons";
import { indentedJson, indentedPartialJson } from "./json";
import { cn } from "./lib/utils";
import { NameValues, type RowsLook, RowsLookContext } from "./NameValues";
import { Segmented } from "./Segmented";
import { CodeLines } from "./Tokens";
import type { Attrs } from "./types";

// What the request carried and what its response said, as the app's SDK recorded them (this machine only), and every
// other attribute: one card, one part at a time, as browser devtools show a request; a part alone under its name.
const PREFIXES = {
  headers: "http.request.header.",
  cookies: "http.request.cookie.",
  session: "session.",
  response: "http.response.header.",
} as const;
const KEYS = new Set([
  "url.query",
  "http.request.body",
  "http.request.body.truncated",
  "http.response.body",
  "http.response.body.truncated",
  "http.response.body.size",
]);
/** A body is read whole (its limit is the SDK's, 64 KB by default): coloured up to this, past it as it came. */
const BODY_COLOURED = 512 * 1024;

/** Shown in the request's own parts: not again among the other attributes. */
export function isRequestDetail(key: string): boolean {
  return KEYS.has(key) || Object.values(PREFIXES).some((prefix) => key.startsWith(prefix));
}

/** A name and its value as it came: a list or a repr is laid out where it is shown. */
type Pair = [name: string, value: unknown];

/** A header as HTTP spells it: attribute keys take no dashes, so content-type was kept as content_type. */
function dashed(key: string): string {
  return key.replaceAll("_", "-");
}

function under(attrs: Attrs, prefix: string, name: (key: string) => string = (key) => key): Pair[] {
  return Object.entries(attrs)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]): Pair => [name(key.slice(prefix.length)), value])
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

/** A body as it reads best: JSON indented and coloured (a cut one laid out as far as it goes), anything else as it came. */
function Readable({ body, text }: { body: BodyOf; text: string }) {
  const indented = laidOut(body, text);
  return indented === null ? text : <CodeLines text={indented} language="javascript" limit={BODY_COLOURED} />;
}

/** A body's JSON indented; JSON cut short as far as it goes; null for anything else. */
function laidOut(body: BodyOf, text: string): string | null {
  const whole = indentedJson(text);
  return whole === null && body.json && body.cut ? indentedPartialJson(text) : whole;
}

/** A part shown in the card: its tab's name and count, and what it shows. */
export interface Part {
  id: string;
  label: string;
  count?: number | undefined;
  content: ReactNode;
}

function pairsPart(id: string, label: string, pairs: Pair[]): Part[] {
  return pairs.length ? [{ id, label, count: pairs.length, content: <Pairs pairs={pairs} /> }] : [];
}

/** A body as the SDK recorded it: its text (or none, kept by its size only), whether it was cut, its type. */
interface BodyOf {
  text: string | null;
  cut: boolean;
  /** Bytes, as the SDK counted them; 0 when it didn't (a request's body). */
  size: number;
  type: string;
  json: boolean;
}

function bodyOf(attrs: Attrs, side: "request" | "response"): BodyOf | null {
  const text = textOf(attrs[`http.${side}.body`]);
  const size = attrs[`http.${side}.body.size`];
  if (text === null && typeof size !== "number") return null;
  const type = mediaType(attrs[`http.${side}.header.content_type`]);
  return {
    text,
    cut: attrs[`http.${side}.body.truncated`] === true,
    size: typeof size === "number" ? size : 0,
    type,
    json: /^application\/(.+\+)?json$/.test(type),
  };
}

function textOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A Content-Type without its parameters: application/json; charset=utf-8 -> application/json. */
function mediaType(header: unknown): string {
  const [type = ""] = String(header ?? "").split(";", 1);
  return type.trim().toLowerCase();
}

function bodyPart(id: string, label: string, body: BodyOf | null): Part[] {
  return body ? [{ id, label, content: <Body body={body} /> }] : [];
}

function headersPart(attrs: Attrs): Part[] {
  const pairs = under(attrs, PREFIXES.headers, dashed);
  return pairs.length
    ? [{ id: "headers", label: "Headers", count: pairs.length, content: <Headers pairs={pairs} /> }]
    : [];
}

/** The request's parts, then the given ones (a GraphQL query), then every other attribute. */
export function requestParts(attrs: Attrs, others: Attrs, extra: readonly Part[] = []): Part[] {
  return [
    ...headersPart(attrs),
    ...pairsPart("query", "Query", queryPairs(attrs["url.query"])),
    ...bodyPart("body", "Request body", bodyOf(attrs, "request")),
    ...pairsPart("cookies", "Cookies", under(attrs, PREFIXES.cookies)),
    ...pairsPart("session", "Session", under(attrs, PREFIXES.session)),
    ...pairsPart("response", "Response headers", under(attrs, PREFIXES.response, dashed)),
    ...bodyPart("response-body", "Response body", bodyOf(attrs, "response")),
    ...extra,
    {
      id: "attributes",
      label: "Attributes",
      count: Object.keys(others).length,
      content: <AttributeGroups attrs={others} />,
    },
  ];
}

// The panel under the switch, by where the parts are shown. The switch is the same pills in both: a switch made to
// look like a section's heading read as plain text among the facts.
const PART_PANELS = { card: "overflow-hidden rounded-lg border bg-card", plain: "" } as const;

/**
 * The parts as one card: a switch above it, the chosen part inside. The switch stays on its part across traces.
 * `plain`, on the page among the trace's facts: the part's rows as the facts' rows, no card around them; the switch
 * the same pills.
 */
export function RequestParts({ parts, look = "card" }: { parts: readonly Part[]; look?: RowsLook | undefined }) {
  const [picked, setPicked] = useState<string | null>(null);
  const open = parts.find((part) => part.id === picked) ?? parts[0];
  if (!open) return null;
  // One look for every trace: the switch shows even with one part (a task run's Attributes), as a request's does.
  return (
    <section className="grid gap-2" aria-label="Request details">
      <Segmented
        label="Request details"
        segments={parts.map(({ id, label, count }) => ({ id, label, count }))}
        value={open.id}
        onChange={setPicked}
      />
      <div className={PART_PANELS[look]} role="tabpanel" aria-label={open.label}>
        <RowsLookContext value={look}>{open.content}</RowsLookContext>
      </div>
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

const BROWSER_ROW = { card: "border-t px-3 hover:bg-muted/40", plain: "py-2" } as const;

/** The row that opens or folds the browser's own headers, when it sent any. */
function BrowserHeaders({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  const row = BROWSER_ROW[useContext(RowsLookContext)];
  if (!count) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "flex w-full items-center gap-1.5 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground",
        row,
      )}
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

/** A body's text, marked when it was cut; one kept by its size only says so. */
function Body({ body }: { body: BodyOf }) {
  if (body.text === null) return <BodyNote>{unkept(body.size, body.type)}</BodyNote>;
  return (
    <>
      <BodyText body={body} text={body.text} />
      {body.cut ? <BodyNote>{cutAt(body.text, body.size)}</BodyNote> : null}
    </>
  );
}

/** A whole form's fields as names and values; any other body as text. */
function BodyText({ body, text }: { body: BodyOf; text: string }) {
  const card = useContext(RowsLookContext) === "card";
  if (body.type === "application/x-www-form-urlencoded" && !body.cut) return <Pairs pairs={queryPairs(text)} />;
  return (
    <pre
      className={cn(
        "dt-syntax m-0 max-h-96 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap",
        // On the page a body is the one boxed thing: code, as code is shown everywhere.
        !card && "rounded-lg border bg-card",
      )}
    >
      <Readable body={body} text={text} />
    </pre>
  );
}

function BodyNote({ children }: { children: ReactNode }) {
  const card = useContext(RowsLookContext) === "card";
  return (
    <p className={cn("py-1.5 text-xs text-muted-foreground", card && "border-t px-3 first:border-t-0")}>{children}</p>
  );
}

/** What a cut body says of itself: how much of it is shown, of how much when the SDK knew. */
function cutAt(text: string, size: number): string {
  const shown = bytes(new TextEncoder().encode(text).length);
  return size === 0 ? `Cut: only its first ${shown} were kept.` : `Cut: its first ${shown} of ${bytes(size)}.`;
}

/** Why a body has no text: its type isn't one kept (binary, a page), or it was compressed or too large to mask. */
function unkept(size: number, type: string): string {
  if (size === 0) return "Empty.";
  return `${bytes(size)} of ${type || "content"}: kept by its size only. JSON, forms and text are kept, uncompressed.`;
}
