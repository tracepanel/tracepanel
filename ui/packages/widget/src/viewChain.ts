// What a browser's view did down its calls, for the pill: a view's own trace has no queries or findings, its calls
// went to other apps (a BFF, a gateway, the services behind it). Once the view ends, the console is asked for its chain
// (`GET /traces/{id}/chain`) over the next seconds, as the apps' traces arrive, and its numbers are counted as the
// panel's tabs count them (DB, HTTP calls, Issues).

import { type ChainCounts, chainCounts } from "@tracepanel/ui/lib/chainCounts";
import type { Chain } from "@tracepanel/ui/types";

/** When the chain is asked for, after the view ended (ms): a gateway sends its spans a few seconds late. */
const VIEW_ASKS_MS = [500, 1500, 3000, 6000, 12_000] as const;

/** The counts, comparable: the pill draws again only when they changed. */
export function countsKey(counts: ChainCounts | null): string {
  return counts ? `${counts.queries}/${counts.calls}/${counts.issues}/${counts.traces}` : "";
}

/**
 * Asks the console for the view's chain at each of VIEW_ASKS_MS, while `wanted()` (the pill still shows this view);
 * `use` takes each answer's counts. Stops quietly when the console is unreachable.
 */
export async function followViewChain(
  get: (url: URL) => Promise<unknown>,
  api: URL,
  id: string,
  wanted: () => boolean,
  use: (counts: ChainCounts) => void,
  unreachable: unknown,
): Promise<void> {
  const url = new URL(`api/traces/${encodeURIComponent(id)}/chain`, api);
  let waited = 0;
  for (const at of VIEW_ASKS_MS) {
    await new Promise((resolve) => window.setTimeout(resolve, at - waited));
    waited = at;
    if (!wanted()) return;
    const body = await get(url);
    if (body === unreachable) return;
    const counts = body ? chainCounts(body as Chain) : null;
    if (counts) use(counts);
  }
}
