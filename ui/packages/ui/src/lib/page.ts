// The views and actions tracepanel-js records in the browser, named "/books" or "/books › click "Save"".

/** Such a name in parts: what was done as a badge (VIEW, CLICK, SUBMIT, BG), the control it was done on, the page. */
export function pageParts(name: string): { badge: string; label: string; page: string | null } {
  const [page = name, action] = name.split(" › ");
  if (!action) return { badge: "VIEW", label: page, page: null };
  const [verb = "", ...rest] = action.split(" ");
  if (verb === "background") return { badge: "BG", label: "background", page };
  return { badge: verb.toUpperCase(), label: rest.join(" ") || verb, page };
}

/** A view's or an action's name as every list says it: what was done, then on which page ("Borrow" /books/1). */
export function pageName(name: string): string {
  const { label, page } = pageParts(name);
  return [label, page].filter(Boolean).join(" ");
}

/**
 * How soon after a view started the next one may start for it to be a redirect (ms): an SPA's route that sends on to
 * another as it renders (`/sms-campaigns` to `/sms-campaigns/campaigns`) does it in a few milliseconds. The agent
 * folds such a view into the next one by the same measure (REDIRECT_US).
 */
export const REDIRECT_MS = 100;

/** Where a view came from when the SPA redirected it at once: "/sms-campaigns" (the agent's page.redirected_from). */
export function redirectedFrom(attrs: Readonly<Record<string, unknown>>): string | null {
  const from = attrs["page.redirected_from"];
  return typeof from === "string" && from ? from : null;
}

/** What a redirected view says of where it came from: "redirected from /sms-campaigns". */
export function redirectNote(from: string): string {
  return `redirected from ${from}`;
}
