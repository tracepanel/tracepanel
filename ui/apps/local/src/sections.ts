import type { Trace, TraceSummary } from "@tracepanel/ui";
import { type Family, systemOfPage } from "@tracepanel/ui/lib/systems";
import { type CallsSection, type EntrySection, type Route, type Section, systemOfSection } from "./routes";

/** What each entry point is: its label, the traces it covers, and how one of its groups is searched for. */
export const ENTRY: Record<
  EntrySection,
  { label: string; description: string; calls: string; scope: string; group: (key: string) => string }
> = {
  endpoints: {
    label: "HTTP",
    description: "Requests to the app: traffic, latency and errors, each request or by URL pattern.",
    calls: "Requests",
    scope: "kind:http",
    group: (key) => {
      const [method = "GET", ...route] = key.split(" ");
      return `kind:http method:${method} route:${quote(route.join(" "))}`;
    },
  },
  graphql: {
    label: "GraphQL",
    description: "Operations the app served: traffic, latency, errors and queries, each operation or by name.",
    calls: "Operations",
    scope: "operation:*",
    group: (key) => `operation:${quote(key)}`,
  },
  tasks: {
    label: "Tasks",
    description:
      "Background work: task runs and the messages listeners take, with failures, retries and time in the queue.",
    calls: "Runs",
    scope: "kind:task",
    group: (key) => `task:${quote(key)}`,
  },
  websockets: {
    label: "WebSockets",
    description:
      "Events of WebSocket consumers: connections, messages, errors and handler time, each event or by consumer.",
    calls: "Events",
    scope: "kind:websocket",
    group: (key) => `kind:websocket view:${quote(key)}`,
  },
  jobs: {
    label: "Jobs",
    description: "Management commands and tracepanel.trace() blocks: scripts, cron jobs, consumers.",
    calls: "Runs",
    scope: "kind:command",
    group: (key) => `kind:command name:${quote(key)}`,
  },
  rpc: {
    label: "RPC",
    description: "Calls the app served over gRPC and other RPC systems, each call or by method.",
    calls: "Calls",
    scope: "kind:rpc",
    group: (key) => `kind:rpc name:${quote(key)}`,
  },
  pages: {
    label: "Pages",
    description:
      "Pages in the browser: each view (a load, a route change) and what users do on it (clicks, submits), with the " +
      "calls each makes to the API and its errors.",
    calls: "Events",
    scope: "kind:page",
    group: (key) => `kind:page name:${quote(key)}`,
  },
};

const DATA_LABELS: Record<Exclude<Section, EntrySection | CallsSection>, { label: string; description: string }> = {
  services: {
    label: "Services",
    description: "Your app's web, workers and commands, and the databases, caches, mail servers and brokers they call.",
  },
  mails: { label: "Emails", description: "Every email your app sent, with the request that sent it." },
  logs: { label: "Logs", description: "Log records from every request, task and job." },
  errors: {
    label: "Errors",
    description: "Exceptions from requests, tasks and jobs, grouped by type and place.",
  },
  issues: {
    label: "Issues",
    description: "What could be better: N+1 and duplicate calls, slow queries and calls, blocking calls, transactions.",
  },
  traces: { label: "Search", description: "Every trace matching the search, newest first." },
};

function quote(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

/** A data page's name, what it shows, and (a system's page) what its rows are called. */
export function pageMeta(
  section: Exclude<Section, EntrySection>,
  family?: Family,
  label?: string,
): { label: string; description: string; noun?: string } {
  const system = systemOfSection(section);
  if (!system) return DATA_LABELS[section as keyof typeof DATA_LABELS];
  const meta = systemOfPage(system, family, label);
  return { label: meta.label, description: meta.description, noun: meta.many };
}

export function sectionLabel(section: Section): string {
  return section in ENTRY
    ? ENTRY[section as EntrySection].label
    : pageMeta(section as Exclude<Section, EntrySection>).label;
}

/** The GraphQL operation a request ran, from the name tracepanel gives it ("GraphQL query PostList"). */
export function graphqlOperation(trace: Pick<TraceSummary, "kind" | "name">): string | null {
  return trace.kind === "http" && trace.name.startsWith("GraphQL ") ? trace.name.slice("GraphQL ".length) : null;
}

/**
 * What a request's line says after its method badge: its path, else its name without the method the badge says
 * (`POST /hooks/stripe`, from an SDK that sent no path), so the method never reads twice.
 */
export function requestPath(trace: { name: string; path?: string | null | undefined }): string {
  if (trace.path) return trace.path;
  const [first = "", ...rest] = trace.name.split(" ");
  return rest.length && /^[A-Z]+$/.test(first) ? rest.join(" ") : trace.name;
}

/** The entry point a trace belongs to: its list, the crumb that leads back to it when it was opened directly. */
export function entryOf(trace: Pick<TraceSummary, "kind" | "name">): EntrySection | null {
  if (graphqlOperation(trace)) return "graphql";
  const sections: Partial<Record<string, EntrySection>> = {
    http: "endpoints",
    task: "tasks",
    command: "jobs",
    websocket: "websockets",
    rpc: "rpc",
    page: "pages",
  };
  return sections[trace.kind] ?? null;
}

/** The kinds of trace grouped by their name, and the section that lists them. */
export const BY_NAME: Partial<Record<string, EntrySection>> = {
  task: "tasks",
  command: "jobs",
  rpc: "rpc",
  page: "pages",
};

/** The entry-point group a trace belongs to: where "all calls like this one" lives. */
export function groupOf(trace: Trace): { section: EntrySection; key: string; label: string } | null {
  const attrs = trace.attrs;
  const operation = attrs["graphql.operation"];
  if (typeof operation === "string") return { section: "graphql", key: operation, label: operation };
  if (trace.kind === "http") {
    const method = attrs["http.method"];
    const route = attrs["http.route"];
    if (typeof method === "string" && typeof route === "string") {
      return { section: "endpoints", key: `${method} ${route}`, label: `${method} ${route}` };
    }
    return null;
  }
  const named = BY_NAME[trace.kind];
  if (named) return { section: named, key: trace.name, label: trace.name };
  const consumer = attrs["code.view"];
  if (trace.kind === "websocket" && typeof consumer === "string") {
    return { section: "websockets", key: consumer, label: consumer };
  }
  return null;
}

/** The crumbs leading back to the page a trace was opened from (`from`, its hash). */
/** An issue's page is under Errors or Issues, as it was opened from. */
function issueCrumbs(error: boolean, from: string): { label: string; href: string }[] {
  return error
    ? [
        { label: "Errors", href: "#/errors" },
        { label: "Error", href: from },
      ]
    : [
        { label: "Issues", href: "#/issues" },
        { label: "Issue", href: from },
      ];
}

export function crumbsFor(route: Route, from: string): { label: string; href: string }[] {
  if (route.name === "group")
    return [
      { label: ENTRY[route.section].label, href: `#/${route.section}` },
      { label: route.key, href: from },
    ];
  if (route.name === "issue") return issueCrumbs(route.error === true, from);
  if (route.name === "app")
    return [
      { label: "Services", href: "#/services" },
      { label: route.service, href: from },
    ];
  if (route.name === "home" || route.name === "trace") return [];
  return [{ label: sectionLabel(route.name), href: from }];
}

/** task.system as people name it: which queue, framework or broker ran the task. */
const TASK_SYSTEMS: Record<string, string> = {
  celery: "Celery",
  dramatiq: "Dramatiq",
  rq: "RQ",
  huey: "Huey",
  "django-q": "django-q2",
  django: "Django Tasks",
  channels: "Channels",
  spring: "Spring @Async",
  scheduled: "Spring @Scheduled",
  bullmq: "BullMQ",
  rabbitmq: "RabbitMQ",
  kafka: "Kafka",
};

export function taskSystem(system: string): string {
  return TASK_SYSTEMS[system] ?? system.charAt(0).toUpperCase() + system.slice(1);
}
