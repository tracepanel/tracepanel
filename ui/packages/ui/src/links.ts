import type { MouseEvent } from "react";
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
  /**
   * Opens a linked trace where the reader is (the panel, with its way back): a plain click on a linked trace does
   * this, and its address is still there for a new tab.
   */
  openTrace?: ((id: string) => void) | undefined;
}

/** The attributes an <a> to one of them takes. */
export function linkProps(
  links: TraceLinks | undefined,
  href: string,
): { href: string; target?: string; rel?: string } {
  return links?.newTab ? { href, target: "_blank", rel: "noreferrer" } : { href };
}

/** A linked trace's <a>: its address, opened in place on a plain click where the host does that (`openTrace`). */
export function traceLinkProps(
  links: TraceLinks | undefined,
  id: string,
): { href: string; target?: string; rel?: string; onClick?: (event: MouseEvent) => void } | undefined {
  if (!links?.trace) return undefined;
  const props = linkProps(links, links.trace(id));
  const open = links.openTrace;
  if (!open) return props;
  return {
    ...props,
    onClick: (event) => {
      // ⌘, Ctrl, Shift or a middle click: a tab or a window of its own, as for any link.
      const modified = [event.metaKey, event.ctrlKey, event.shiftKey, event.altKey].some(Boolean);
      if (modified || event.button !== 0) return;
      event.preventDefault();
      open(id);
    },
  };
}
