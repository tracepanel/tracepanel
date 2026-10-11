import { useMemo } from "react";
import { CopyButton } from "./CopyButton";
import { formatSql, placeholders, tokenizeSql } from "./sql";

export interface SqlCodeProps {
  sql: string;
  /** Database vendor for formatting rules: postgresql (default), sqlite, mysql. */
  vendor?: string | undefined;
  /** Keep the statement as written instead of reformatting it. */
  raw?: boolean | undefined;
}

/** A formatted, syntax-highlighted SQL statement with a copy button. */
export function SqlCode({ sql, vendor, raw }: SqlCodeProps) {
  const text = useMemo(() => (raw ? placeholders(sql) : formatSql(sql, vendor)), [sql, vendor, raw]);
  const tokens = useMemo(() => tokenizeSql(text), [text]);
  return (
    <div className="group/sql relative min-w-0 overflow-hidden rounded-md border bg-muted/60">
      <pre className="m-0 max-h-[30rem] overflow-auto px-4 py-3 pr-12 font-mono text-sm leading-relaxed text-foreground [tab-size:2]">
        <code>
          {tokens.map((token, index) =>
            token.type === "text" ? (
              token.text
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: tokens of one statement never reorder.
              <span key={index} className={`dt-sql-${token.type}`}>
                {token.text}
              </span>
            ),
          )}
        </code>
      </pre>
      <CopyButton
        text={text}
        label="Copy SQL"
        className="absolute top-2 right-2 opacity-0 transition-opacity group-hover/sql:opacity-100 focus-visible:opacity-100"
      />
    </div>
  );
}
