import { cn } from "@tracepanel/ui/lib/utils";
import { CheckIcon, CopyIcon, LinkIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "./components/ui/button";

const ICONS = { copy: CopyIcon, link: LinkIcon };

/** Copies `text` to the clipboard; the icon (`link` for an address) turns into a check for a moment. */
export function CopyButton({
  text,
  label = "Copy",
  className,
  icon = "copy",
}: {
  text: string;
  label?: string;
  className?: string;
  icon?: "copy" | "link";
}) {
  const [copied, setCopied] = useState(false);
  const said = copied ? "Copied" : label;
  const Icon = copied ? CheckIcon : ICONS[icon];
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      className={cn("size-7 bg-background shadow-none", className)}
      aria-label={said}
      title={said}
      onClick={(event) => {
        event.stopPropagation();
        navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          },
          () => undefined,
        );
      }}
    >
      <Icon className={cn(copied && "text-ok")} />
    </Button>
  );
}
