import type { components } from "./api.gen";
import type { DataSource } from "./source";
import type { ExplainPlan, Related, Trace } from "./types";

/**
 * A snapshot: a trace and what is linked to it, as the agent's `GET /snapshot/{id}` returns it, plus the query plans
 * the console fetched for it (EXPLAIN runs in the app, which the file can't reach). The console writes it into one
 * HTML file with itself, and that file opens anywhere, with no agent and no network.
 */
export type Snapshot = components["schemas"]["Snapshot"] & {
  /** Plans by `<trace id>/<span id>`. */
  plans?: Record<string, ExplainPlan>;
};

const GLOBAL = "__TRACEPANEL_SNAPSHOT__";

/** The snapshot this page was opened from, if it is a snapshot file. */
export function readSnapshot(): Snapshot | null {
  const found: unknown = (window as unknown as Record<string, unknown>)[GLOBAL];
  return typeof found === "object" && found !== null ? (found as Snapshot) : null;
}

/** The source, able to make snapshots too: the agent's `snapshot/{id}` under the same API root. */
export function withSnapshots(source: DataSource, api: URL): DataSource {
  return {
    ...source,
    async snapshot(traceId, values) {
      const url = new URL(`snapshot/${encodeURIComponent(traceId)}`, api);
      url.searchParams.set("values", values ? "1" : "0");
      const response = await fetch(url, { headers: { accept: "application/json" } });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`tracepanel API ${url.pathname}: HTTP ${response.status}`);
      return (await response.json()) as Snapshot;
    },
  };
}

const NOTHING_LINKED: Related = {
  // biome-ignore-start lint/style/useNamingConvention: wire format.
  enqueued_by: null,
  enqueued: [],
  connection: null,
  connection_events: [],
  sent_by: null,
  delivered: [],
  called_by: null,
  calls: [],
  via: {},
  // biome-ignore-end lint/style/useNamingConvention: wire format.
};

const none = async () => [];
const nothing = async () => null;
const noPage = async () => ({ items: [], next: null });
const noUsers = () => Promise.reject(new Error("a snapshot has no users"));

/** What a snapshot doesn't hold: no store to search, no app to ask. */
const EMPTY: Omit<DataSource, "getTrace" | "related" | "explain"> = {
  listTraces: none,
  searchTraces: noPage,
  searchLogs: noPage,
  searchMails: noPage,
  listCalls: none,
  callsSummary: nothing,
  listEndpoints: none,
  listTasks: none,
  listWebsockets: none,
  listGraphql: none,
  getGraphqlOperation: nothing,
  listJobs: none,
  listRpcs: none,
  listPages: none,
  summarizeTraces: nothing,
  listServices: async () => ({ apps: [], links: [], services: [], edges: [] }),
  getEndpoint: nothing,
  tracesOverview: async () => ({
    summary: null,
    series: [],
    histogram: [],
    // biome-ignore lint/style/useNamingConvention: wire format.
    slow_threshold: 500_000,
    kinds: [],
    slowest: [],
    failing: [],
  }),
  knownValues: async () => ({
    route: [],
    logger: [],
    db: [],
    targets: {},
    ops: {},
    task: [],
    queue: [],
    job: [],
    rpc: [],
    page: [],
    in: [],
    span: [],
    extra: [],
  }),
  counts: async () => ({
    issues: 0,
    errors: 0,
    sections: { http: 0, graphql: 0, tasks: 0, websockets: 0, jobs: 0, rpc: 0, pages: 0, mails: 0, systems: [] },
  }),
  currentUser: noUsers,
  searchUsers: none,
  switchUser: noUsers,
  listIssues: none,
  getIssue: nothing,
  searchSpec: async () => ({}) as Awaited<ReturnType<DataSource["searchSpec"]>>,
};

/** A source that reads a snapshot: its traces, their links and the plans it carries. */
export function snapshotSource(snapshot: Snapshot): DataSource {
  return {
    ...EMPTY,
    getTrace: async (id) => (snapshot.traces[id] as Trace | undefined) ?? null,
    related: async (id) => (snapshot.related[id] as Related | undefined) ?? NOTHING_LINKED,
    async explain(trace, span, analyze) {
      const plan = analyze ? undefined : snapshot.plans?.[`${trace}/${span}`];
      if (!plan) throw new Error("This snapshot has no plan for this query: EXPLAIN runs in the app.");
      return plan;
    },
  };
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  // In slices: String.fromCharCode takes its arguments on the stack.
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

/** A file's bytes as a `data:` URL. */
async function dataUrl(response: Response): Promise<string> {
  const type = response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
  return `data:${type};base64,${base64(new Uint8Array(await response.arrayBuffer()))}`;
}

/** Text gzipped, as base64: the file carries the console a third of its size. */
async function packed(text: string): Promise<string> {
  const zipped = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return base64(new Uint8Array(await new Response(zipped).arrayBuffer()));
}

/** The files a stylesheet loads (`url(…)`), other than data URLs. */
function loadedBy(css: string): string[] {
  const urls = [...css.matchAll(/url\((['"]?)([^'")]+)\1\)/g)].map((match) => match[2] ?? "");
  return [...new Set(urls)].filter((url) => url && !url.startsWith("data:"));
}

/** The stylesheet with what it loads (the fonts) inside it. */
async function inlineStyles(href: string): Promise<string> {
  let css = await (await fetch(href)).text();
  for (const url of loadedBy(css)) {
    const response = await fetch(new URL(url, href));
    if (response.ok) css = css.replaceAll(url, await dataUrl(response));
  }
  return css;
}

/** An attribute of the first element a selector finds on this page, or "". */
function linked(selector: string, attribute: "src" | "href"): string {
  return document.querySelector<HTMLLinkElement & HTMLScriptElement>(selector)?.[attribute] ?? "";
}

/** The console's script and stylesheet, as this page loads them, and its icon. */
function pageAssets(): { script: string; stylesheet: string; icon: string } {
  const assets = {
    script: linked('script[type="module"][src]', "src"),
    stylesheet: linked('link[rel="stylesheet"][href]', "href"),
    icon: linked('link[rel="icon"]', "href"),
  };
  if (!(assets.script && assets.stylesheet))
    throw new Error("the console's script or stylesheet is missing from this page");
  return assets;
}

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * Unpacks the data, the stylesheet and the script (each gzipped, base64), puts the data where readSnapshot() finds
 * it, then runs the console. DecompressionStream is in every current browser.
 */
const LOADER = `const unpack = (text) =>
  new Response(
    new Blob([Uint8Array.from(atob(text), (char) => char.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream("gzip")),
  ).text();
const packed = JSON.parse(document.getElementById("tracepanel-snapshot").textContent);
const [data, css, js] = await Promise.all([unpack(packed.data), unpack(packed.css), unpack(packed.js)]);
window.${GLOBAL} = JSON.parse(data);
const style = document.createElement("style");
style.textContent = css;
document.head.append(style);
await import(URL.createObjectURL(new Blob([js], { type: "text/javascript" })));`;

function page(title: string, icon: string, packedParts: string): string {
  const link = icon ? `<link rel="icon" href="${escapeHtml(icon)}" />` : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    ${link}
    <script type="application/json" id="tracepanel-snapshot">${packedParts}</script>
    <script type="module">${LOADER}</script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;
}

/**
 * The console as one HTML file with the snapshot inside: its script and stylesheet (fonts included) taken from this
 * page, and the data, each gzipped in a script tag the loader unpacks. Nothing in it loads from anywhere.
 */
export async function snapshotFile(snapshot: Snapshot, title: string): Promise<Blob> {
  const assets = pageAssets();
  const [js, css] = await Promise.all([
    fetch(assets.script).then((response) => response.text()),
    inlineStyles(assets.stylesheet),
  ]);
  const [data, style, code] = await Promise.all([packed(JSON.stringify(snapshot)), packed(css), packed(js)]);
  // Base64 only: nothing in it can end the script tag it sits in.
  const parts = JSON.stringify({ data, css: style, js: code });
  return new Blob([page(title, assets.icon, parts)], { type: "text/html" });
}
