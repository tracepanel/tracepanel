import { useEffect, useState } from "react";
import { TokenBlock } from "./CopyButton";
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
  return <TokenBlock text={shown.text} tokens={shown.tokens} prefix="tp-gql-" label="Copy query" />;
}
