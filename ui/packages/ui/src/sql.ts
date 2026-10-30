import { formatDialect, mysql, postgresql, sqlite, transactsql } from "sql-formatter";

/** Django's `%s` / `%(name)s` placeholders read as `?`; `%%` (a literal percent sign) is left alone. */
export function placeholders(sql: string): string {
  return sql.replace(/(?<!%)%(?:\([a-zA-Z_]\w*\))?s/g, "?");
}

/** Django's parametrized SQL, formatted, with placeholders shown as `?`. */
export function formatSql(sql: string, vendor = "postgresql"): string {
  return placeholders(formatRaw(sql, vendor));
}

// Only the dialects a vendor can name: the others stay out of the bundle. SQL Server is Django's "microsoft",
// SQLAlchemy's and OpenTelemetry's "mssql".
const DIALECTS: Record<string, typeof postgresql> = { sqlite, mysql, microsoft: transactsql, mssql: transactsql };

function formatRaw(sql: string, vendor: string): string {
  const dialect = DIALECTS[vendor] ?? postgresql;
  try {
    return formatDialect(sql, {
      dialect,
      keywordCase: "upper",
      tabWidth: 2,
      linesBetweenQueries: 1,
      // SQL Server's drivers also write ? (JDBC, ODBC): its dialect knows only @P1.
      paramTypes: { custom: [{ regex: String.raw`%\([a-zA-Z_]\w*\)s|%s` }], positional: dialect === transactsql },
    });
  } catch {
    // Unusual statements still render, just with simple line breaks.
    return sql.replace(
      /\s+(FROM|WHERE|INNER JOIN|LEFT OUTER JOIN|LEFT JOIN|JOIN|GROUP BY|ORDER BY|LIMIT|OFFSET)\s+/g,
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
    "PARTITION FILTER LATERAL FOR SHARE NOWAIT SKIP LOCKED TOP FETCH FIRST NEXT ROW ROWS ONLY"
  ).split(" "),
);

// Names quoted as "standard SQL", `MySQL` or [SQL Server] (not an array's [1]); placeholders as each driver writes
// them: %s, %(name)s, ?, ?1, $1, @P1 or @name (not SQL Server's @@ functions), :1 or :name (not a :: cast).
const TOKEN =
  /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^']|'')*')|("(?:[^"]|"")*"|`[^`]*`|\[[A-Za-z_][^\],\n]*\])|(%\([a-zA-Z_]\w*\)s|%s|\?\d*|\$\d+|(?<!@)@\w+|(?<!:):(?!:)\w+)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(<=|>=|<>|!=|=|<|>|\*|\+|-|\/|\|\||,|\.|\(|\))|(\s+|.)/g;

// The regex's groups, in order: what each one's match is.
const GROUPS: SqlTokenType[] = ["comment", "string", "identifier", "param", "number", "keyword", "operator"];

/** What a match of TOKEN is: its group's type, a word a keyword only when it is one. */
function tokenType(match: RegExpMatchArray): SqlTokenType {
  const group = match.slice(1).findIndex((part) => part !== undefined);
  const type = GROUPS[group] ?? "text";
  return type === "keyword" && !KEYWORDS.has(match[0].toUpperCase()) ? "identifier" : type;
}

export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  for (const match of sql.matchAll(TOKEN)) {
    const text = match[0];
    const type = tokenType(match);
    const last = tokens.at(-1);
    if (last && last.type === type && type === "text") last.text += text;
    else tokens.push({ type, text });
  }
  return tokens;
}

/** A statement without its comments (an ORM's or sqlcommenter's tags, a note): what it does, as a check reads it. */
export function uncommented(sql: string): string {
  return tokenizeSql(sql)
    .map((token) => (token.type === "comment" ? " " : token.text))
    .join("")
    .trim();
}
