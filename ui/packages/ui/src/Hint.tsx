import { type FocusEvent, type ReactNode, useEffect, useState } from "react";
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
  off = false,
  children,
}: {
  /** Held shut: what it is on is open already (its menu), the hint would only cover it. */
  off?: boolean | undefined;
  title: string;
  detail?: ReactNode | undefined;
  keys?: string | undefined;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
}) {
  const [open, setOpen] = useOpenWhileHere();
  return (
    <Tooltip open={open && !off} onOpenChange={setOpen}>
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

/**
 * A hint's open state that lets go when the pointer leaves the document (the panel's frame, left fast for the page:
 * no pointerleave reaches the button), the window loses focus, anything is pressed or the view scrolls.
 */
function useOpenWhileHere(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const root = document.documentElement;
    root.addEventListener("mouseleave", close);
    window.addEventListener("blur", close);
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("scroll", close, true);
    return () => {
      root.removeEventListener("mouseleave", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);
  return [open, setOpen];
}
