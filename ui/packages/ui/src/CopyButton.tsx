import { cn } from "@tracepanel/ui/lib/utils";
import { CheckIcon, CopyIcon, LinkIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "./components/ui/button";
import { isMasked } from "./lib/values";

const ICONS = { copy: CopyIcon, link: LinkIcon };

/**
 * A block of code or text and its copy button in its top right corner, shown while the block is hovered or the button
 * has focus: the one look of every block that copies (SQL, a GraphQL document, a body, a plan, a message). `text` is
 * the whole value as stored, never a preview cut for the screen.
 */
export function CopyBlock({
  text,
  label,
  className,
  children,
}: {
  text: string;
  label: string;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className={cn("group/copy relative min-w-0", className)}>
      {children}
      <CopyButton
        text={text}
        label={label}
        className="absolute top-2 right-2 opacity-0 transition-opacity group-hover/copy:opacity-100 focus-visible:opacity-100"
      />
    </div>
  );
}

/**
 * Code in colour, a statement or a document (SQL, GraphQL), in the box every such block has and with its copy button:
 * each token in its class (`tp-sql-keyword`), plain text as it is.
 */
export function TokenBlock({
  text,
  tokens,
  prefix,
  label,
  className,
}: {
  text: string;
  tokens: readonly { type: string; text: string }[];
  /** The tokens' classes: `tp-sql-`, `tp-gql-`. */
  prefix: string;
  label: string;
  className?: string | undefined;
}) {
  return (
    <CopyBlock text={text} label={label} className="overflow-hidden rounded-md border bg-muted/60">
      <pre
        className={cn(
          "m-0 max-h-[30rem] overflow-auto px-4 py-3 pr-12 font-mono text-sm leading-relaxed whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]",
          className,
        )}
      >
        <code>
          {tokens.map((token, index) =>
            token.type === "text" ? (
              token.text
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: the tokens of one text never reorder.
              <span key={index} className={`${prefix}${token.type}`}>
                {token.text}
              </span>
            ),
          )}
        </code>
      </pre>
    </CopyBlock>
  );
}

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
