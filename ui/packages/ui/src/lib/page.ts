// The views and actions tracepanel-js records in the browser, named "/books" or "/books › click "Save"".

/** Such a name in parts: what was done as a badge (VIEW, CLICK, SUBMIT, BG), the control it was done on, the page. */
export function pageParts(name: string): { badge: string; label: string; page: string | null } {
  const [page = name, action] = name.split(" › ");
  if (!action) return { badge: "VIEW", label: page, page: null };
  const [verb = "", ...rest] = action.split(" ");
  if (verb === "background") return { badge: "BG", label: "background", page };
  return { badge: verb.toUpperCase(), label: rest.join(" ") || verb, page };
}
