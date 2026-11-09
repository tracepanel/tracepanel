// A call no trace answered and none will (lib/chainRows, untracedIn): it carried the trace on to a host that records
// none, so what ran there isn't in the tree. Its row says nothing more than its call (no app beside it says enough);
// its tooltip and its details say why, in the call tree and the HTTP calls tab alike.
import { createContext, useContext } from "react";

/** The calls of the trace on screen no trace answered, by span id: the host each went to. */
export const UntracedCalls = createContext<ReadonlyMap<string, string>>(new Map());

/** The host a call went to when no trace answered it and none will; undefined for any other call. */
export function useUntraced(spanId: string): string | undefined {
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

/** The host a group's calls went to when a trace answered none of them; undefined otherwise. */
export function useGroupUntraced(spans: readonly { id: string }[]): string | undefined {
  const untraced = useContext(UntracedCalls);
  const first = spans[0];
  if (!first || !spans.every((span) => untraced.has(span.id))) return undefined;
  return untraced.get(first.id);
}

/** In a call's details: why nothing is under it. */
export function NotTracedNote({ spanId }: { spanId: string }) {
  const host = useUntraced(spanId);
  if (host === undefined) return null;
  return (
    <p className="tp-not-traced-note" data-state="untraced">
      Not traced: {host} sent no trace for this call. {UNTRACED_WHY}
    </p>
  );
}
