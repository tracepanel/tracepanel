import { useStuck } from "@tracepanel/ui/hooks/useStuck";
import { cn } from "@tracepanel/ui/lib/utils";
import type * as React from "react";

/**
 * `stickyHeader` keeps the header row in view while the page scrolls under it. The container then clips instead of
 * scrolling sideways (a scrolling container would hold the header in place itself), so such a table has to fit its
 * width: fixed column widths and one column that takes the rest.
 */
function Table({ stickyHeader = false, ...props }: React.ComponentProps<"table"> & { stickyHeader?: boolean }) {
  return stickyHeader ? <StickyTable {...props} /> : <PlainTable {...props} />;
}

function PlainTable({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table data-slot="table" className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  );
}

/**
 * A table whose header stays in view. While rows scroll under it, the container says so (`data-stuck`): the header
 * then casts a soft shadow on them (styles.css).
 */
function StickyTable({ className, ...props }: React.ComponentProps<"table">) {
  const { sentinel, stuck } = useStuck<HTMLDivElement>();
  return (
    <div data-slot="table-container" data-stuck={stuck || undefined} className="relative w-full overflow-x-clip">
      <div ref={sentinel} aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px" />
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm [&>thead]:sticky [&>thead]:top-0 [&>thead]:z-10", className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted light:border-border/60",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption data-slot="table-caption" className={cn("mt-4 text-sm text-muted-foreground", className)} {...props} />
  );
}

export { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow };
