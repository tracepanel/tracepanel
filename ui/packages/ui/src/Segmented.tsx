import type { ReactNode } from "react";
import { cn } from "./lib/utils";

export interface Segment<T extends string> {
  id: T;
  label: ReactNode;
  count?: number | undefined;
}

/**
 * A choice of views inside a tab: pills on a muted track, the chosen one raised. The same control wherever a pane
 * switches what it shows (a request's parts, a profile's frames).
 */
export function Segmented<T extends string>({
  segments,
  value,
  onChange,
  label,
}: {
  segments: readonly Segment<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div
      className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-lg bg-muted p-0.5"
      role="tablist"
      aria-label={label}
    >
      {segments.map((segment) => (
        <button
          type="button"
          role="tab"
          key={segment.id}
          aria-selected={segment.id === value}
          onClick={() => onChange(segment.id)}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition-colors",
            segment.id === value
              ? "bg-background font-medium text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
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
