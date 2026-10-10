import { format } from "sql-formatter";

/** Django's `%s` / `%(name)s` placeholders read as `?`; `%%` (a literal percent sign) is left alone. */
export function placeholders(sql: string): string {
  return sql.replace(/(?<!%)%(?:\([a-zA-Z_]\w*\))?s/g, "?");
}

/** Django's parametrized SQL, formatted, with placeholders shown as `?`. */
export function formatSql(sql: string, vendor = "postgresql"): string {
  return placeholders(formatRaw(sql, vendor));
}

function formatRaw(sql: string, vendor: string): string {
  const language = vendor === "sqlite" ? "sqlite" : vendor === "mysql" ? "mysql" : "postgresql";
  try {
    return format(sql, {
      language,
      keywordCase: "upper",
      tabWidth: 2,
      linesBetweenQueries: 1,
      paramTypes: { custom: [{ regex: String.raw`%\([a-zA-Z_]\w*\)s|%s` }] },
    });
  } catch {
    // Unusual statements still render, just with simple line breaks.
    return sql.replace(
      /\s+(FROM|WHERE|INNER JOIN|LEFT OUTER JOIN|LEFT JOIN|JOIN|GROUP BY|ORDER BY|LIMIT)\s+/g,
      "\n$1 ",
    );
  }
}

export type SqlTokenType = "keyword" | "identifier" | "string" | "number" | "param" | "comment" | "operator" | "text";

export interface SqlToken {
  type: SqlTokenType;
  text: string;
}

const KEYWORDS = new Set(
  (
    "SELECT FROM WHERE AND OR NOT IN IS NULL AS ON JOIN INNER LEFT RIGHT OUTER FULL CROSS GROUP BY ORDER " +
    "HAVING LIMIT OFFSET INSERT INTO VALUES UPDATE SET DELETE RETURNING DISTINCT COUNT SUM AVG MIN MAX " +
    "CASE WHEN THEN ELSE END EXISTS BETWEEN LIKE ILIKE ESCAPE ASC DESC UNION ALL WITH RECURSIVE CREATE " +
    "TABLE INDEX DROP ALTER BEGIN COMMIT ROLLBACK SAVEPOINT RELEASE TRUE FALSE COALESCE CAST OVER " +
    "PARTITION FILTER LATERAL FOR SHARE NOWAIT SKIP LOCKED"
  ).split(" "),
);

const TOKEN =
  /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^']|'')*')|("(?:[^"]|"")*"|`[^`]*`)|(%\([a-zA-Z_]\w*\)s|%s|\?|\$\d+)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(<=|>=|<>|!=|=|<|>|\*|\+|-|\/|\|\||,|\.|\(|\))|(\s+|.)/g;

export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  for (const match of sql.matchAll(TOKEN)) {
    const [text, comment, string, quoted, param, num, word, operator] = match;
    let type: SqlTokenType = "text";
    if (comment) type = "comment";
    else if (string) type = "string";
    else if (quoted) type = "identifier";
    else if (param) type = "param";
    else if (num) type = "number";
    else if (word) type = KEYWORDS.has(word.toUpperCase()) ? "keyword" : "identifier";
    else if (operator) type = "operator";
    const last = tokens.at(-1);
    if (last && last.type === type && type === "text") last.text += text;
    else tokens.push({ type, text });
  }
  return tokens;
}
