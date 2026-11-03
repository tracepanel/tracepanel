// What a view or a request did down its calls, for the pill: a view's own trace has no queries or findings, its calls
// went to other apps (a BFF, a gateway, the services behind it); a BFF's request ran none itself, the services it
// called did. Once it ended, the console is asked for its chain (`GET /traces/{id}/chain`) over the next seconds, as
// the apps' traces arrive, and its numbers are counted as the panel's tabs and list count them (DB, HTTP calls,
// Issues): one source of truth for the pill, its card and the list. Until the first answer they are pending, and a
// view's while a call of it still waits for its trace, as its row in the list says "…" then.

import { type ChainCounts, chainCounts } from "@tracepanel/ui/lib/chainCounts";
import { CUT_WAITING_MS, callsAwaited } from "@tracepanel/ui/lib/chainRows";
import { chainCutAt } from "@tracepanel/ui/lib/live";
import type { Chain } from "@tracepanel/ui/types";

/** When the chain is asked for, after it ended (ms): a gateway sends its spans a few seconds late. */
const CHAIN_ASKS_MS = [150, 600, 1500, 3000, 6000, 12_000] as const;
/** While a view's calls wait for their traces, it is asked for this often (ms), at the longest this long after. */
const AWAITED_ASK_MS = 1_000;
const AWAITED_MAX_MS = CUT_WAITING_MS + 15_000;

/**
 * What its chain says: its counts (null while a call of the view still waits for its trace: "…"), and where its own
 * trace was cut with a call unanswered (null if it wasn't).
 */
export interface ChainFacts {
  counts: ChainCounts | null;
  cut: number | null;
}

/** The facts, comparable: the pill draws again only when they changed. */
export function factsKey(facts: ChainFacts | null): string {
  if (!facts) return "";
  const { counts, cut } = facts;
  if (!counts) return `pending/${cut ?? ""}`;
  return `${counts.queries}/${counts.calls}/${counts.issues}/${counts.traces}/${cut ?? ""}`;
}

/** One answer's facts, and whether a call of the view still waits for its trace (`awaited`): then they're partial. */
type Answer = { facts: ChainFacts & { counts: ChainCounts }; awaited: boolean };

/** The facts of one answer of `GET /traces/{id}/chain`, if it was there, as of when it was asked (`at`, ms). */
function factsOf(chain: Chain, id: string, view: boolean, at: number): Answer | null {
  const counts = chainCounts(chain);
  if (!counts) return null;
  return { facts: { counts, cut: chainCutAt(chain) }, awaited: view && callsAwaited(chain, id, at) };
}

/** One ask: the chain's facts, null while it isn't there, "stop" when the console can't be reached. */
async function ask(
  get: (url: URL) => Promise<unknown>,
  url: URL,
  unreachable: unknown,
  read: (chain: Chain, at: number) => Answer | null,
): Promise<Answer | null | "stop"> {
  const at = Date.now();
  const body = await get(url);
  if (body === unreachable) return "stop";
  return body ? read(body as Chain, at) : null;
}

/** When to ask next (ms after it ended), after `waited`: soon while calls of the view wait, else the next of the asks. */
function nextAsk(waited: number, awaited: boolean): number | undefined {
  if (awaited) return waited + AWAITED_ASK_MS > AWAITED_MAX_MS ? undefined : waited + AWAITED_ASK_MS;
  return CHAIN_ASKS_MS.find((at) => at > waited);
}

/**
 * Asks the console for the chain of `id` at each of CHAIN_ASKS_MS, while `wanted()` (the pill still shows it); `use`
 * takes each answer's facts. A view's (`view`) only once none of its calls waits for its trace: asked every
 * AWAITED_ASK_MS until then, its numbers pending ("…"), as its row in the panel's list says them; the last answer's
 * if the asks ran out first. `done(answered)` once it stops: unreachable, no longer wanted, or the asks ran out.
 */
export async function followChain(
  get: (url: URL) => Promise<unknown>,
  api: URL,
  id: string,
  { wanted, view }: { wanted: () => boolean; view: boolean },
  use: (facts: ChainFacts) => void,
  unreachable: unknown,
  done: (answered: boolean) => void = () => undefined,
): Promise<void> {
  const url = new URL(`api/traces/${encodeURIComponent(id)}/chain`, api);
  const read = (chain: Chain, at: number) => factsOf(chain, id, view, at);
  const asking = async () => (wanted() ? await ask(get, url, unreachable, read) : "stop");
  let waited = 0;
  let answered = false;
  // The last answer's facts while a call of the view still waited: its numbers said only if no later answer comes.
  let partial: ChainFacts | null = null;
  for (let at = nextAsk(0, false); at !== undefined; at = nextAsk(waited, partial !== null)) {
    await new Promise((resolve) => window.setTimeout(resolve, (at as number) - waited));
    waited = at;
    const got = await asking();
    if (got === "stop") break;
    if (got === null) continue;
    partial = got.awaited ? got.facts : null;
    // Pending, its numbers "…", what its trace says of itself (cut) all the same.
    use(got.awaited ? { counts: null, cut: got.facts.cut } : got.facts);
    answered = true;
  }
  if (partial) use(partial);
  done(answered);
}
