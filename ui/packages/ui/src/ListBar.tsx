import type { ReactNode } from "react";

/**
 * The line over a list in a trace's tab: how many there are (records, queries, calls), and at its end what the tab
 * offers for them, a switch of views or a way to a page. The same line on the Logs, DB, Cache and HTTP calls tabs.
 */
export function ListBar({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <div className="flex min-h-13 items-center gap-3 px-4 py-2.5 text-base text-muted-foreground">
      <span className="tabular-nums">{children}</span>
      {end ? <div className="ml-auto flex shrink-0 items-center gap-2">{end}</div> : null}
    </div>
  );
}
