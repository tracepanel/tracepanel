import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";

/** Copies `text` to the clipboard; the icon turns into a check for a moment. */
export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      className={cn("size-7 bg-background shadow-none", className)}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
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
      {copied ? <CheckIcon className="text-ok" /> : <CopyIcon />}
    </Button>
  );
}
