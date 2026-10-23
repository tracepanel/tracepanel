import { Button } from "@tracepanel/ui/components/ui/button";
import { TableRow } from "@tracepanel/ui/components/ui/table";
import { cn } from "@tracepanel/ui/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
  type SyntheticEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { follow, openInNewTab } from "./routes";

/* Console building blocks on top of shadcn/ui: table rows, meters, loading, page header. The lists themselves are
   DataTable, from @tracepanel/ui. */

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
  fresh,
  className,
  ...props
}: ComponentProps<typeof TableRow> & {
  tone?: "warn" | "error" | undefined;
  selected?: boolean;
  href?: string;
  /** Called before `href` is followed, however (click, Enter, a new tab). */
  opening?: (() => void) | undefined;
  /** Just arrived: highlighted for a moment, as the widget's list highlights a new request. */
  fresh?: boolean | undefined;
}) {
  return (
    <TableRow
      data-tone={tone}
      data-state={selected ? "selected" : undefined}
      data-new={fresh ? "" : undefined}
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

/** A horizontal bar for a value relative to the largest in the table, with the value beside it; a narrow column narrows the bar. */
export function Meter({ value, max, children }: { value: number; max: number; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <span className="h-2 w-24 min-w-6 shrink overflow-hidden rounded-full bg-muted-foreground/15">
        <span
          className="block h-full rounded-full bg-chart-1"
          style={{ width: `${(value / Math.max(max, 1)) * 100}%` }}
        />
      </span>
      <span className="shrink-0 tabular-nums">{children}</span>
    </span>
  );
}

/** What loads, hidden in its place under a loading bar until `ready`: then all of it at once, nothing moving. */
export function Reveal({ ready, children }: { ready: boolean; children: ReactNode }) {
  return (
    <div className="relative">
      {ready ? null : (
        <div className="absolute inset-x-0 top-0">
          <Loading />
        </div>
      )}
      <div className={cn(!ready && "invisible")} aria-busy={!ready}>
        {children}
      </div>
    </div>
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
      <h1 className="shrink-0 text-3xl font-semibold tracking-tight light:text-[1.375rem] light:tracking-[-0.025em]">
        {title}
      </h1>
      {description ? (
        <p className="min-w-0 flex-1 truncate text-md text-muted-foreground light:text-sm">{description}</p>
      ) : null}
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

/** How many of the chips, `widths` px each, fit in `room` px with `gap` between them and a "+N" chip after them. */
function chipsThatFit(widths: readonly number[], room: number, gap: number, more: number): number {
  const all = widths.reduce((sum, width) => sum + width, 0) + gap * (widths.length - 1);
  if (all <= room) return widths.length;
  let used = more;
  let count = 0;
  for (const width of widths) {
    if (used + gap + width > room) break;
    used += gap + width;
    count += 1;
  }
  return count;
}

/**
 * Chips on one line, as many as fit and a "+N" for the rest, every one named on hover: a narrow column never cuts a
 * chip in half. A copy of them all, hidden, is what gets measured.
 */
export function FitChips({ chips, names }: { chips: readonly ReactNode[]; names: readonly string[] }) {
  const row = useRef<HTMLSpanElement>(null);
  const ruler = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(chips.length);
  useLayoutEffect(() => {
    const element = row.current;
    const measured = ruler.current;
    if (!(element && measured)) return;
    const fit = () => {
      const parts = Array.from(measured.children, (child) => (child as HTMLElement).offsetWidth);
      const more = parts.pop() ?? 0;
      const gap = Number.parseFloat(getComputedStyle(measured).columnGap) || 0;
      setShown(element.clientWidth === 0 ? chips.length : chipsThatFit(parts, element.clientWidth, gap, more));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [chips.length]);
  const hidden = chips.length - shown;
  return (
    <span ref={row} className="relative flex min-w-0 gap-1" title={hidden > 0 ? names.join(", ") : undefined}>
      {chips.slice(0, shown)}
      {hidden > 0 ? <span className="shrink-0 text-xs leading-[1.125rem] text-muted-foreground">+{hidden}</span> : null}
      <span ref={ruler} aria-hidden="true" className="pointer-events-none invisible absolute top-0 left-0 flex gap-1">
        {chips}
        <span className="text-xs leading-[1.125rem]">+{chips.length}</span>
      </span>
    </span>
  );
}
