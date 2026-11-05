import { useMemo } from "react";
import { TokenBlock } from "./CopyButton";
import { formatSql, placeholders, tokenizeSql, withValues } from "./sql";

export interface SqlCodeProps {
  sql: string;
  /** Database vendor for formatting rules: postgresql (default), sqlite, mysql, microsoft or mssql (SQL Server). */
  vendor?: string | undefined;
  /** Keep the statement as written instead of reformatting it. */
  raw?: boolean | undefined;
  /** The values one run of it had, and their names where the driver says them: shown in place of its placeholders. */
  values?: readonly unknown[] | undefined;
  names?: readonly unknown[] | undefined;
}

/** A formatted, syntax-highlighted SQL statement with a copy button. */
export function SqlCode({ sql, vendor, raw, values, names }: SqlCodeProps) {
  const text = useMemo(() => {
    const run = values?.length ? withValues(sql, values, names) : sql;
    return raw ? placeholders(run) : formatSql(run, vendor);
  }, [sql, vendor, raw, values, names]);
  const tokens = useMemo(() => tokenizeSql(text), [text]);
  return <TokenBlock text={text} tokens={tokens} prefix="dt-sql-" label="Copy SQL" className="[tab-size:2]" />;
}
