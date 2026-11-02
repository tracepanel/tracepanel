// A trace as a filter's chip names it ("VIEW /campaigns", "GET /books", "GraphQL query Books"), by its id, from the
// agent: `chain:01K…` reads as "chain of VIEW /campaigns". Asked once per id.
import { pageParts } from "@tracepanel/ui/lib/page";
import { useEffect, useState } from "react";

const names = new Map<string, Promise<string | null>>();

/** The trace's name as the lists say it: a view or an action by its badge and page, else its own name. */
function nameOf(trace: { kind: string; name: string }): string {
  if (trace.kind !== "page") return trace.name;
  const { badge, label, page } = pageParts(trace.name);
  return page ? `${badge} ${label} · ${page}` : `${badge} ${label}`;
}

function ask(id: string): Promise<string | null> {
  let found = names.get(id);
  if (!found) {
    const url = new URL(`api/traces?ids=${encodeURIComponent(id)}&limit=1`, location.href.split("#")[0]);
    found = fetch(url)
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { traces?: { id: string; kind: string; name: string }[] } | null) => {
        const trace = body?.traces?.find((each) => each.id === id);
        return trace ? nameOf(trace) : null;
      })
      .catch(() => null);
    names.set(id, found);
  }
  return found;
}

/** The name of the trace `id` (null: none asked, or the agent doesn't have it). */
export function useTraceName(id: string | null): string | null {
  const [name, setName] = useState<{ id: string; name: string | null } | null>(null);
  useEffect(() => {
    if (id === null) return;
    let live = true;
    void ask(id).then((found) => live && setName({ id, name: found }));
    return () => {
      live = false;
    };
  }, [id]);
  return name?.id === id ? name.name : null;
}
