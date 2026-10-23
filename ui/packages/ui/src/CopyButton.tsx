import { cn } from "@tracepanel/ui/lib/utils";
import { CheckIcon, CopyIcon, LinkIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "./components/ui/button";
import { isMasked } from "./lib/values";

const ICONS = { copy: CopyIcon, link: LinkIcon };

interface CopyButtonProps {
  text: string;
  label?: string;
  className?: string;
  icon?: "copy" | "link";
}

/**
 * Copies `text` to the clipboard; the icon (`link` for an address) turns into a check for a moment. A value the SDK
 * masked (a password, a session id) has none, wherever it shows: there is nothing to copy but the asterisks.
 */
export function CopyButton(props: CopyButtonProps) {
  return isMasked(props.text) ? null : <CopyAction {...props} />;
}

function CopyAction({ text, label = "Copy", className, icon = "copy" }: CopyButtonProps) {
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
