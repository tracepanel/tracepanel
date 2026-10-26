import { type RuntimeKind, runtimeMark, runtimeName } from "@tracepanel/ui/lib/runtime";
import { cn } from "@tracepanel/ui/lib/utils";
import { AppWindowIcon } from "lucide-react";

/**
 * What served a page: its owner's mark, unaltered, where the owner allows one; else the plain app icon. The panel's
 * pill draws the same choice.
 */
export function RuntimeIcon({ kind, className }: { kind: RuntimeKind; className?: string }) {
  const name = runtimeName(kind);
  const mark = runtimeMark(kind);
  if (!mark) {
    return <AppWindowIcon className={cn("dt-icon size-3.5", className)} role="img" aria-label={name} />;
  }
  return (
    <svg
      className={cn("dt-icon", className)}
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill={mark.color ?? "currentColor"}
      role="img"
      aria-label={name}
    >
      <path d={mark.path} />
    </svg>
  );
}
