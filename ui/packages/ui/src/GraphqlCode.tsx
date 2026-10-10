import { useEffect, useState } from "react";
import { CopyButton } from "./CopyButton";
import type { GraphqlTokenType } from "./graphql";

type Token = { type: GraphqlTokenType; text: string };

/**
 * A formatted, syntax-highlighted GraphQL document with a copy button (the colours of SqlCode). graphql-js loads on
 * first use, in its own chunk: until then the document shows as stored.
 */
export function GraphqlCode({ document }: { document: string }) {
  const [shown, setShown] = useState<{ text: string; tokens: Token[] }>({
    text: document,
    tokens: [{ type: "text", text: document }],
  });
  useEffect(() => {
    let cancelled = false;
    import("./graphql").then(({ formatGraphql, tokenizeGraphql }) => {
      if (cancelled) return;
      const text = formatGraphql(document);
      setShown({ text, tokens: tokenizeGraphql(text) });
    });
    return () => {
      cancelled = true;
    };
  }, [document]);
  return (
    <div className="group/gql relative min-w-0 overflow-hidden rounded-md border bg-muted/60">
      <pre className="m-0 max-h-[480px] overflow-auto px-4 py-3 pr-12 font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-foreground">
        <code>
          {shown.tokens.map((token, index) =>
            token.type === "text" ? (
              token.text
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: tokens of one document never reorder.
              <span key={index} className={`dt-gql-${token.type}`}>
                {token.text}
              </span>
            ),
          )}
        </code>
      </pre>
      <CopyButton
        text={shown.text}
        label="Copy query"
        className="absolute top-2 right-2 opacity-0 transition-opacity group-hover/gql:opacity-100 focus-visible:opacity-100"
      />
    </div>
  );
}
