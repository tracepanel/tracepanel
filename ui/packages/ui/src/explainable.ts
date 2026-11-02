// Which statements EXPLAIN may run: the agent's rule (crates/server/src/explainable.rs), which every SDK shares too,
// with its cases in schema/explainable.json. A SELECT, or a WITH whose CTEs and final statement only read; a SELECT
// that locks rows is explained, not analyzed. Words are read outside quoted strings and names and comments.

export const NOT_SELECT = "Only SELECT statements can be explained.";
const ONE_STATEMENT = "Only one statement can be explained at a time.";
const CHANGING = new Set(["INSERT", "UPDATE", "DELETE", "MERGE"]);
/** What can follow a WITH's CTEs: the statement they are for. */
const MAIN = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "VALUES", "TABLE"]);

/**
 * A statement's tokens: a comment (`--`, a block; MySQL's `/*!`, whose inside MySQL runs, is only its opening), a
 * quoted string or name (`E'…'` with backslashes, `'…'` with `''`, `"…"`, `` `…` ``, `[…]`, PostgreSQL's
 * `$tag$…$tag$`), a word, a number, or any other sign. An unclosed one runs to the end.
 */
const TOKEN = new RegExp(
  [
    String.raw`--[^\n]*`,
    String.raw`\/\*!`,
    String.raw`\/\*[\s\S]*?(?:\*\/|$)`,
    String.raw`[Ee]'(?:[^'\\]|''|\\[\s\S])*(?:'|$)`,
    "'(?:[^']|'')*(?:'|$)",
    '"(?:[^"]|"")*(?:"|$)',
    String.raw`\x60(?:[^\x60]|\x60\x60)*(?:\x60|$)`,
    String.raw`\[[\p{L}_][^\]]*(?:\]|$)`,
    String.raw`\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$`,
    String.raw`[\p{L}_][\p{L}\p{N}_$]*`,
    String.raw`[0-9][\p{L}\p{N}_.]*`,
    String.raw`\S`,
  ].join("|"),
  "gu",
);
const WORD = /^[\p{L}_][\p{L}\p{N}_$]*$/u;

/** A word (upper-cased) or any other token, with its depth in parentheses. */
interface Token {
  text: string;
  word: boolean;
  depth: number;
}

const COMMENT = /^(?:--|\/\*)/;

/** Past a PostgreSQL dollar quote's closing tag (`$$`, `$tag$`) when `text` opens one, or the statement's end. */
function pastDollarQuote(statement: string, text: string): void {
  if (text.length < 2 || !text.startsWith("$")) return;
  const close = statement.indexOf(text, TOKEN.lastIndex);
  TOKEN.lastIndex = close === -1 ? statement.length : close + text.length;
}

/** The statement's tokens, without its comments: a quoted string or name is one token whose text is never read. */
function tokenize(statement: string): Token[] {
  const tokens: Token[] = [];
  let depth = 0;
  TOKEN.lastIndex = 0;
  for (let match = TOKEN.exec(statement); match; match = TOKEN.exec(statement)) {
    const text = match[0];
    if (COMMENT.test(text)) continue;
    pastDollarQuote(statement, text);
    if (text === ")") depth = Math.max(0, depth - 1);
    const word = WORD.test(text);
    tokens.push({ text: word ? text.toUpperCase() : text, word, depth });
    if (text === "(") depth += 1;
  }
  return tokens;
}

/** Whether the word at `at` is a lock's (FOR UPDATE, FOR NO KEY UPDATE, FOR KEY SHARE), not a statement's. */
const locking = (words: string[], at: number) => words[at - 1] === "FOR" || words[at - 1] === "KEY";

/** What changes data: an INSERT, UPDATE, DELETE or MERGE (inside the WITH when before `main`), or an INTO. */
function changeOf(words: string[], main: number): string | null {
  for (const [at, word] of words.entries()) {
    if (CHANGING.has(word) && !(word === "UPDATE" && locking(words, at))) {
      return at < main ? `${word} inside WITH` : word;
    }
  }
  return words.includes("INTO") ? "SELECT INTO" : null;
}

/** The lock a SELECT takes: FOR UPDATE, FOR SHARE, LOCK IN SHARE MODE. */
function lockOf(words: string[]): string | null {
  for (const [at, word] of words.entries()) {
    if (word === "UPDATE" && locking(words, at)) return "FOR UPDATE";
    if (word === "SHARE" && locking(words, at)) return "FOR SHARE";
    if (word === "SHARE" && words[at - 1] === "IN" && words[at - 2] === "LOCK") return "LOCK IN SHARE MODE";
  }
  return null;
}

/** Why a statement isn't explained (or with `analyze`, analyzed), or null when it is. */
export function explainRefusal(statement: string, analyze: boolean): string | null {
  const tokens = tokenize(statement);
  const words = tokens.map((token) => (token.word ? token.text : ""));
  if (words[0] !== "SELECT" && words[0] !== "WITH") return NOT_SELECT;
  const end = tokens.findIndex((token) => token.depth === 0 && token.text === ";");
  if (end !== -1 && end + 1 < tokens.length) return ONE_STATEMENT;
  // The statement a WITH's CTEs are for: what comes before it is inside the WITH.
  const found = tokens.findIndex((token) => token.word && token.depth === 0 && MAIN.has(token.text));
  const main = words[0] === "SELECT" ? 0 : found === -1 ? tokens.length : found;
  const change = changeOf(words, main);
  if (change) return `This query changes data (${change}): it isn't explained.`;
  if (words[main] !== "SELECT") return NOT_SELECT;
  const lock = analyze ? lockOf(words) : null;
  return lock ? `This query locks rows (${lock}): it can be explained, not analyzed.` : null;
}
