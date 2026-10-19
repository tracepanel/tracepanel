/**
 * A line of a query plan in parts to colour, as the databases write them: PostgreSQL's and MySQL's text plans
 * ("Index Scan using posts_pkey on posts  (cost=0.15..8.17 rows=1 width=4)", "Filter: (author_id = 1)"), SQLite's
 * ("SEARCH posts USING INDEX posts_author (author_id=?)") and MySQL's table ("table=posts  type=ALL  rows=100").
 */
export type PlanToken = {
  type: "op" | "label" | "keyword" | "name" | "key" | "number" | "string" | "text";
  text: string;
};

/**
 * What a line starts with: nothing to pick out in MySQL's table (pairs only), a detail's label ("Filter:"), SQLite's
 * SCAN or SEARCH and its table, or an operation.
 */
const HEADS: [RegExp, PlanToken["type"][]][] = [
  [/^(?=\w+=)/, []],
  [/^([A-Z][A-Za-z ]*:)(?= |$)/, ["label"]],
  [/^(SCAN|SEARCH)( TABLE)?( )(\S+)/, ["op", "op", "text", "name"]],
  [/^([A-Za-z][A-Za-z -]*?)(?= on | using | USING | {2}\(| \(|$)/, ["op"]],
];

/** Through the rest: the name after on/using (or MySQL's table= and key=), key=value pairs, quoted strings and numbers (with ms, kB, ranges). */
const REST =
  /(\b(?:on|using|USING(?: COVERING)? INDEX|USING INTEGER PRIMARY KEY|USING) |\b(?:table|key|possible_keys)=)(\S+)|\b([A-Za-z_]+(?: time)?)=|('[^']*')|(\b\d+(?:\.\d+)?(?:\.\.\d+(?:\.\d+)?)?(?:ms|kB)?\b)/g;

function head(text: string): [PlanToken[], string] {
  for (const [pattern, types] of HEADS) {
    const match = pattern.exec(text);
    if (match) return [partsOf(match, types), text.slice(match[0].length)];
  }
  return [[], text];
}

function partsOf(match: RegExpExecArray, types: PlanToken["type"][]): PlanToken[] {
  return match
    .slice(1)
    .flatMap((part, index): PlanToken[] => (part ? [{ type: types[index] ?? "text", text: part }] : []));
}

function rest(text: string): PlanToken[] {
  const tokens: PlanToken[] = [];
  let last = 0;
  for (const match of text.matchAll(REST)) {
    if (match.index > last) tokens.push({ type: "text", text: text.slice(last, match.index) });
    tokens.push(...restMatch(match));
    last = match.index + match[0].length;
  }
  if (last < text.length) tokens.push({ type: "text", text: text.slice(last) });
  return tokens;
}

function restMatch([whole, prefix, name, key, string]: RegExpMatchArray): PlanToken[] {
  if (prefix) return prefixed(prefix, name);
  if (key) return [{ type: "key", text: `${key}=` }];
  return [{ type: string ? "string" : "number", text: whole }];
}

/** "on posts", "USING INDEX posts_author", "table=posts": the word before, then the name. */
function prefixed(prefix: string, name: string | undefined): PlanToken[] {
  return [{ type: prefix.endsWith("=") ? "key" : "keyword", text: prefix }, ...nameOf(name ?? "")];
}

/** A table or index name; a parenthesis glued to it ("posts_author(author_id=?)") stays text. */
function nameOf(text: string): PlanToken[] {
  const at = text.indexOf("(");
  if (at <= 0) return [{ type: "name", text }];
  return [{ type: "name", text: text.slice(0, at) }, ...rest(text.slice(at))];
}

export function tokenizePlan(text: string): PlanToken[] {
  const [start, remaining] = head(text);
  return [...start, ...rest(remaining)];
}
