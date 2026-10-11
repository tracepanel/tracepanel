import { RUNTIME_PATHS, type RuntimeKind, runtimeName } from "@tracepanel/ui/lib/runtime";
import { cn } from "@tracepanel/ui/lib/utils";

/** What served a page, as its mark, in currentColor. */
export function RuntimeIcon({ kind, className }: { kind: RuntimeKind; className?: string }) {
  return (
    <svg
      className={cn("dt-icon", className)}
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="currentColor"
      role="img"
      aria-label={runtimeName(kind)}
    >
      <path d={RUNTIME_PATHS[kind]} />
    </svg>
  );
}
