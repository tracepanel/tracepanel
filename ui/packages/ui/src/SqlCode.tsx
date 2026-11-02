import { useMemo } from "react";
import { TokenBlock } from "./CopyButton";
import { formatSql, placeholders, tokenizeSql } from "./sql";

export interface SqlCodeProps {
  sql: string;
  /** Database vendor for formatting rules: postgresql (default), sqlite, mysql, microsoft or mssql (SQL Server). */
  vendor?: string | undefined;
  /** Keep the statement as written instead of reformatting it. */
  raw?: boolean | undefined;
}

/** A formatted, syntax-highlighted SQL statement with a copy button. */
export function SqlCode({ sql, vendor, raw }: SqlCodeProps) {
  const text = useMemo(() => (raw ? placeholders(sql) : formatSql(sql, vendor)), [sql, vendor, raw]);
  const tokens = useMemo(() => tokenizeSql(text), [text]);
  return <TokenBlock text={text} tokens={tokens} prefix="dt-sql-" label="Copy SQL" className="[tab-size:2]" />;
}
