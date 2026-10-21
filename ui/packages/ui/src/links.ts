import type { IssueKind } from "./types";

/**
 * Where a trace's parts lead, as addresses the host builds: the components stay out of its router. Each one
 * missing leaves its links out.
 */
export interface TraceLinks {
  /** A linked trace: enqueued by, a task's run, a connection. */
  trace?: ((id: string) => string) | undefined;
  /** An issue's page. */
  issue?: ((fingerprint: string, kind: IssueKind) => string) | undefined;
  /** Every request that made this call: the agent's key for it (`call:<key>`). */
  call?: ((key: string) => string) | undefined;
  /** The traces a search finds (`group:<id>`: a task group's runs). */
  search?: ((query: string) => string) | undefined;
  /** This trace's records in the logs list. */
  logs?: ((traceId: string) => string) | undefined;
  /** The page of the app that recorded it (service.name): its settings and versions. */
  app?: ((service: string) => string) | undefined;
  /** Open them in a new tab: the panel lives inside someone's page, the console does not. */
  newTab?: boolean | undefined;
}

/** The attributes an <a> to one of them takes. */
export function linkProps(
  links: TraceLinks | undefined,
  href: string,
): { href: string; target?: string; rel?: string } {
  return links?.newTab ? { href, target: "_blank", rel: "noreferrer" } : { href };
}
