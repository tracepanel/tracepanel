import { cn } from "@tracepanel/ui/lib/utils";

/**
 * The tracepanel mark: a trace waterfall, three nested spans stepping in; the deepest (the slowest call) is lime.
 * Keep in sync with the copies in the widget badge and the favicon.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-7 shrink-0", className)} aria-hidden="true">
      <rect x="3" y="6" width="26" height="5.5" rx="2.75" fill="#7c4ff0" />
      <rect x="9" y="13.25" width="18" height="5.5" rx="2.75" fill="#a587ff" />
      <rect x="15" y="20.5" width="10" height="5.5" rx="2.75" fill="#b6e24a" />
    </svg>
  );
}

/** Mark plus the lowercase wordmark. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5 text-[21px] font-semibold tracking-[-0.03em]", className)}>
      <LogoMark />
      <span>
        <span className="text-brand">trace</span>panel
      </span>
    </span>
  );
}
