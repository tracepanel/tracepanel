// A call no trace answered and none will (lib/chainRows, untracedIn): it carried the trace on to a host that records
// none, so what ran there isn't in the tree. Said on its row, muted, and in its details, in the call tree and the
// HTTP calls tab alike, so a call with nothing under it never reads as a call that did nothing.
import { createContext, useContext } from "react";

/** The calls of the trace on screen no trace answered, by span id: the host each went to. */
export const UntracedCalls = createContext<ReadonlyMap<string, string>>(new Map());

/** The host a call went to when no trace answered it and none will; undefined for any other call. */
function useUntraced(spanId: string): string | undefined {
  return useContext(UntracedCalls).get(spanId);
}

/**
 * Why: whatever answered there records no traces, a service without Tracepanel or a file a traced app serves as it is
 * (its SDK traces the app's routes, not its static files): "sends no traces" would be untrue of the latter.
 */
const UNTRACED_WHY =
  "The call carried the trace on, but what answered it records none (a service without Tracepanel, or a static file its app serves), so what ran there isn't recorded.";

/** What a call no trace answered says, in its tooltip and its details. */
export function untracedNote(host: string): string {
  return `Not traced: ${host} sent no trace for this call. ${UNTRACED_WHY}`;
}

/** On the row of a call no trace answered: muted, its reason in the tooltip. */
export function NotTraced({ spanId }: { spanId: string }) {
  const host = useUntraced(spanId);
  if (host === undefined) return null;
  return (
    <span className="dt-not-traced" data-state="untraced" title={untracedNote(host)}>
      not traced
    </span>
  );
}

/** On a group's row, when a trace answered none of its calls: said once, for the group. */
export function GroupNotTraced({ spans }: { spans: readonly { id: string }[] }) {
  const untraced = useContext(UntracedCalls);
  const first = spans[0];
  if (!first || !spans.every((span) => untraced.has(span.id))) return null;
  return <NotTraced spanId={first.id} />;
}

/** In a call's details: why nothing is under it. */
export function NotTracedNote({ spanId }: { spanId: string }) {
  const host = useUntraced(spanId);
  if (host === undefined) return null;
  return (
    <p className="dt-not-traced-note" data-state="untraced">
      Not traced: {host} sent no trace for this call. {UNTRACED_WHY}
    </p>
  );
}
