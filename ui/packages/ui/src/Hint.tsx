import type { FocusEvent, ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";

function keyboardOnly(event: FocusEvent<HTMLElement>): void {
  if (!event.currentTarget.matches(":focus-visible")) event.preventDefault();
}

/**
 * What a control does, on hover: its name in bold, a line on what happens, and its key. The one tooltip of every icon
 * button, in the panel and the console alike.
 */
export function Hint({
  title,
  detail,
  keys,
  side = "bottom",
  children,
}: {
  title: string;
  detail?: ReactNode | undefined;
  keys?: string | undefined;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
}) {
  return (
    <Tooltip>
      {/* Opened by focus only from the keyboard: a clicked button keeps focus, and its hint would stay over the next. */}
      <TooltipTrigger asChild onFocus={keyboardOnly}>
        {children}
      </TooltipTrigger>
      <TooltipContent
        side={side}
        sideOffset={8}
        arrow={false}
        className="grid max-w-72 gap-1 rounded-lg border bg-popover px-3 py-2 text-left text-popover-foreground shadow-[var(--dt-popover-shadow)]"
      >
        <span className="flex items-center justify-between gap-4 text-sm font-medium">
          {title}
          {keys ? (
            <kbd className="rounded border bg-muted px-1.5 font-mono text-[11px] leading-5 text-muted-foreground">
              {keys}
            </kbd>
          ) : null}
        </span>
        {detail ? <span className="text-xs text-pretty text-muted-foreground">{detail}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}
