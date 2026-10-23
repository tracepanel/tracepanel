import type { ReactNode } from "react";
import { cn } from "./lib/utils";

export interface Segment<T extends string> {
  id: T;
  label: ReactNode;
  count?: number | undefined;
}

// The two looks: pills on a muted track (a pane's views), or the page's section headings (a trace's parts on its
// Request tab, among its other sections), the chosen one in the heading's colour, the others muted.
const LOOKS = {
  pills: {
    track: "gap-0.5 rounded-lg bg-muted p-0.5",
    item: "rounded-md px-2.5 py-1",
    chosen: "bg-background font-medium text-foreground shadow-sm",
  },
  heading: {
    track: "gap-x-4 gap-y-1",
    item: "font-medium",
    chosen: "text-foreground",
  },
} as const;

/**
 * A choice of views inside a tab: pills on a muted track, the chosen one raised. The same control wherever a pane
 * switches what it shows (a request's parts, a profile's frames); `heading`, as a section of the page is headed.
 */
export function Segmented<T extends string>({
  segments,
  value,
  onChange,
  label,
  look = "pills",
}: {
  segments: readonly Segment<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  look?: keyof typeof LOOKS | undefined;
}) {
  const shape = LOOKS[look];
  return (
    <div className={cn("inline-flex max-w-full flex-wrap items-center", shape.track)} role="tablist" aria-label={label}>
      {segments.map((segment) => (
        <button
          type="button"
          role="tab"
          key={segment.id}
          aria-selected={segment.id === value}
          onClick={() => onChange(segment.id)}
          className={cn(
            "flex items-center gap-1.5 text-sm transition-colors",
            shape.item,
            segment.id === value ? shape.chosen : "text-muted-foreground hover:text-foreground",
          )}
        >
          {segment.label}
          {segment.count ? (
            <span className="text-xs font-normal text-muted-foreground tabular-nums">{segment.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
