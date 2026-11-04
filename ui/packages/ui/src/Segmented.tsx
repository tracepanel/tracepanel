import type { ReactNode } from "react";
import { cn } from "./lib/utils";

export interface Segment<T extends string> {
  id: T;
  label: ReactNode;
  count?: number | undefined;
}

/** The track of pills, muted, every pill switch in the console sits on: Segmented, an entry point's lists. */
export const SEGMENT_TRACK = "inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-lg bg-muted p-0.5";

/** One pill on the track: the chosen one raised, the others quiet until hovered. */
export function segmentClass(selected: boolean): string {
  return cn(
    "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm no-underline transition-colors",
    selected ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
  );
}

/**
 * A part's name as a single raised pill on the track, where there is nothing to switch (Related traces, Workflow):
 * it reads as the parts with a switch do, not as a heading of another kind.
 */
export function SegmentLabel({ children, count }: { children: ReactNode; count?: number | undefined }) {
  return (
    <span className={SEGMENT_TRACK}>
      <span className={segmentClass(true)}>
        {children}
        {count ? <span className="text-xs font-normal text-muted-foreground tabular-nums">{count}</span> : null}
      </span>
    </span>
  );
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
    <div className={SEGMENT_TRACK} role="tablist" aria-label={label}>
      {segments.map((segment) => (
        <button
          type="button"
          role="tab"
          key={segment.id}
          aria-selected={segment.id === value}
          // One stop in the Tab order, the selected tab; ← → Home End move between them.
          tabIndex={segment.id === value ? 0 : -1}
          onClick={() => onChange(segment.id)}
          onKeyDown={(event) => {
            const ids = segments.map((each) => each.id);
            const at = ids.indexOf(value);
            const next =
              event.key === "ArrowRight"
                ? ids[(at + 1) % ids.length]
                : event.key === "ArrowLeft"
                  ? ids[(at - 1 + ids.length) % ids.length]
                  : event.key === "Home"
                    ? ids[0]
                    : event.key === "End"
                      ? ids.at(-1)
                      : undefined;
            if (next === undefined) return;
            event.preventDefault();
            onChange(next);
            // The list may be drawn again for the new view: found again by its name, its selected tab focused.
            const name = event.currentTarget.parentElement?.getAttribute("aria-label") ?? "";
            const root = event.currentTarget.ownerDocument;
            requestAnimationFrame(() =>
              root.querySelector<HTMLElement>(`[role="tablist"][aria-label="${name}"] [aria-selected="true"]`)?.focus(),
            );
          }}
          className={segmentClass(segment.id === value)}
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
