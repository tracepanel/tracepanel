import { Button } from "@tracepanel/ui/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@tracepanel/ui/components/ui/table";
import { cn } from "@tracepanel/ui/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import { type ComponentProps, type ReactNode, type SyntheticEvent, useEffect, useRef } from "react";
import { follow, openInNewTab } from "./routes";

/* Console building blocks on top of shadcn/ui: a GitHub-like boxed table, meters, loading, page header. */

export function DataTable({
  head,
  children,
  dense = false,
}: {
  head: ReactNode;
  children: ReactNode;
  dense?: boolean;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border bg-card",
        dense && "[&_td]:px-3 [&_td:first-child]:pl-4 [&_th]:px-3 [&_th:first-child]:pl-4",
      )}
    >
      {/* The size of every table's rows, the logs' too: one size of table text across the console. */}
      <Table className="text-base">
        <TableHeader className="bg-muted">
          <TableRow className="hover:bg-transparent">{head}</TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
      </Table>
    </div>
  );
}

export function Th({ num, className, ...props }: ComponentProps<typeof TableHead> & { num?: boolean }) {
  return (
    <TableHead
      className={cn(
        "h-10 px-5 text-xs font-semibold tracking-wide text-muted-foreground uppercase first:pl-6",
        num && "text-right",
        className,
      )}
      {...props}
    />
  );
}

export function Td({ num, className, ...props }: ComponentProps<typeof TableCell> & { num?: boolean }) {
  return <TableCell className={cn("px-5 py-3 first:pl-6", num && "text-right tabular-nums", className)} {...props} />;
}

// What a click inside a row means for itself rather than for the row.
const OWN_CLICK = "a, button, input, select, textarea, summary, [role=button]";

function ownClick(event: SyntheticEvent): boolean {
  const target = event.target as Element;
  return target !== event.currentTarget && target.closest(OWN_CLICK) !== null;
}

/** What makes a row a link: a click goes there, Cmd/Ctrl/Shift-click or a middle click opens a new tab, Enter too. */
function linkProps(target: string, opening?: () => void): ComponentProps<typeof TableRow> {
  const go = () => {
    opening?.();
    follow(target);
  };
  const newTab = () => {
    opening?.();
    openInNewTab(target);
  };
  return {
    role: "link",
    tabIndex: 0,
    onClick: (event) => {
      if (ownClick(event)) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey) newTab();
      else go();
    },
    // Without this a middle click starts the browser's autoscroll instead.
    onMouseDown: (event) => {
      if (event.button === 1 && !ownClick(event)) event.preventDefault();
    },
    onAuxClick: (event) => {
      if (event.button === 1 && !ownClick(event)) newTab();
    },
    onKeyDown: (event) => {
      if (event.key === "Enter" && event.target === event.currentTarget) go();
    },
  };
}

/**
 * A clickable row; `href` makes it a link (`#/…`), `tone` marks it with a colored edge, `selected` highlights the
 * open one. A row that expands in place takes `onClick` instead.
 */
export function Tr({
  tone,
  selected,
  href,
  opening,
  className,
  ...props
}: ComponentProps<typeof TableRow> & {
  tone?: "warn" | "error" | undefined;
  selected?: boolean;
  href?: string;
  /** Called before `href` is followed, however (click, Enter, a new tab). */
  opening?: (() => void) | undefined;
}) {
  return (
    <TableRow
      data-tone={tone}
      data-state={selected ? "selected" : undefined}
      {...(href === undefined ? {} : linkProps(href, opening))}
      className={cn(
        "cursor-pointer data-[state=selected]:bg-brand-soft",
        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        "data-[tone=error]:[&>td:first-child]:shadow-[inset_3px_0_0_var(--color-error)]",
        "data-[tone=warn]:[&>td:first-child]:shadow-[inset_3px_0_0_var(--color-warn)]",
        className,
      )}
      {...props}
    />
  );
}

/** A horizontal bar for a value relative to the largest in the table, with the value beside it. */
export function Meter({ value, max, children }: { value: number; max: number; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="h-2 w-24 overflow-hidden rounded-full bg-muted-foreground/15">
        <span
          className="block h-full rounded-full bg-chart-1"
          style={{ width: `${(value / Math.max(max, 1)) * 100}%` }}
        />
      </span>
      <span className="tabular-nums">{children}</span>
    </span>
  );
}

export function Loading() {
  return (
    <div role="status" className="h-0.5 overflow-hidden">
      <span className="sr-only">Loading</span>
      <div className="h-full w-2/5 animate-loading bg-gradient-to-r from-transparent via-brand to-transparent motion-reduce:animate-none" />
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Controls on the right, e.g. refresh. */
  actions?: ReactNode;
}) {
  return (
    <header className="flex min-w-0 items-center gap-4 px-10 pt-8">
      <h1 className="shrink-0 text-3xl font-semibold tracking-tight">{title}</h1>
      {description ? <p className="min-w-0 flex-1 truncate text-md text-muted-foreground">{description}</p> : null}
      {actions ? <div className="ml-auto">{actions}</div> : null}
    </header>
  );
}

export function Mono({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("font-mono", className)} {...props} />;
}

/** Older pages load on their own as the end of the list scrolls into view; the button does the same by hand. */
export function LoadMore({ label, loading, onMore }: { label: string; loading: boolean; onMore: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const more = useRef(onMore);
  more.current = onMore;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && more.current(), {
      rootMargin: "400px 0px",
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="flex justify-center py-5">
      <Button variant="outline" disabled={loading} onClick={onMore}>
        {loading ? "Loading…" : label}
      </Button>
    </div>
  );
}

/** Where this page sits: section › item; earlier crumbs are links. */
export function Breadcrumbs({ items }: { items: readonly { label: ReactNode; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-md">
      {items.map((item, index) => (
        // Only the current page (the last crumb, no link) shrinks and truncates; the links keep their width.
        <span
          key={item.href ?? `crumb-${index}`}
          className={cn("flex items-center gap-1.5", item.href ? "shrink-0" : "min-w-0")}
        >
          {index > 0 ? <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" /> : null}
          {item.href ? (
            <a
              href={item.href}
              className="shrink-0 text-muted-foreground no-underline hover:text-foreground hover:underline"
            >
              {item.label}
            </a>
          ) : (
            <span aria-current="page" className="min-w-0 truncate font-medium">
              {item.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}
