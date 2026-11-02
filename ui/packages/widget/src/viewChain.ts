// What a view or a request did down its calls, for the pill: a view's own trace has no queries or findings, its calls
// went to other apps (a BFF, a gateway, the services behind it); a BFF's request ran none itself, the services it
// called did. Once it ended, the console is asked for its chain (`GET /traces/{id}/chain`) over the next seconds, as
// the apps' traces arrive, and its numbers are counted as the panel's tabs and list count them (DB, HTTP calls,
// Issues): one source of truth for the pill, its card and the list. Until the first answer they are pending.

import { type ChainCounts, chainCounts } from "@tracepanel/ui/lib/chainCounts";
import { chainCutAt } from "@tracepanel/ui/lib/live";
import type { Chain } from "@tracepanel/ui/types";

/** When the chain is asked for, after it ended (ms): a gateway sends its spans a few seconds late. */
const CHAIN_ASKS_MS = [150, 600, 1500, 3000, 6000, 12_000] as const;

/** What its chain says: its counts, and where its own trace was cut with a call unanswered (null if it wasn't). */
export interface ChainFacts {
  counts: ChainCounts;
  cut: number | null;
}

/** The facts, comparable: the pill draws again only when they changed. */
export function factsKey(facts: ChainFacts | null): string {
  if (!facts) return "";
  const { counts, cut } = facts;
  return `${counts.queries}/${counts.calls}/${counts.issues}/${counts.traces}/${cut ?? ""}`;
}

/** The facts of one answer of `GET /traces/{id}/chain`, if it was there. */
function factsOf(chain: Chain): ChainFacts | null {
  const counts = chainCounts(chain);
  if (!counts) return null;
  return { counts, cut: chainCutAt(chain) };
}

/**
 * Asks the console for the chain of `id` at each of CHAIN_ASKS_MS, while `wanted()` (the pill still shows it); `use`
 * takes each answer's facts. `done(answered)` once it stops: unreachable, no longer wanted, or the asks ran out.
 */
export async function followChain(
  get: (url: URL) => Promise<unknown>,
  api: URL,
  id: string,
  wanted: () => boolean,
  use: (facts: ChainFacts) => void,
  unreachable: unknown,
  done: (answered: boolean) => void = () => undefined,
): Promise<void> {
  const url = new URL(`api/traces/${encodeURIComponent(id)}/chain`, api);
  let waited = 0;
  let answered = false;
  for (const at of CHAIN_ASKS_MS) {
    await new Promise((resolve) => window.setTimeout(resolve, at - waited));
    waited = at;
    if (!wanted()) break;
    const body = await get(url);
    if (body === unreachable) break;
    const facts = body ? factsOf(body as Chain) : null;
    if (facts) {
      answered = true;
      use(facts);
    }
  }
  done(answered);
}
