import { Fragment, useMemo } from "react";
import { type Language, type SourceToken, tokenizeLines } from "./highlight";
import { keyed } from "./keys";
import { STRUCTURE_LIMIT } from "./lib/values";

/** A line's tokens, each in its class (styles.css colours them under .dt-source and .dt-syntax); a blank line holds its height. */
export function TokenLine({ tokens }: { tokens: readonly SourceToken[] }) {
  if (tokens.length === 0) return " ";
  return keyed(tokens, (token) => token.text).map(({ key, item: token }) =>
    token.type === "plain" ? (
      <span key={key}>{token.text}</span>
    ) : (
      <span key={key} className={`token ${token.type}`}>
        {token.text}
      </span>
    ),
  );
}

/**
 * Code coloured, a span a line: a value laid out (JSON, a Python repr) or a log message that is a JSON document. Past
 * the size worth colouring (`limit`: a body is read whole, so worth more) it is shown as it came; `lines` shows only the
 * first ones (a folded value).
 */
export function CodeLines({
  text,
  language,
  lines,
  limit = STRUCTURE_LIMIT,
}: {
  text: string;
  language: Language;
  lines?: number | undefined;
  limit?: number;
}) {
  const tokens = useMemo(
    () => (text.length > limit ? null : tokenizeLines(text.split("\n"), language, true)),
    [text, language, limit],
  );
  if (tokens === null) return text;
  // A line break between lines, as text: the code copies and reads (textContent) as it is laid out.
  return keyed(tokens.slice(0, lines), (line) => line.map((token) => token.text).join("")).map(
    ({ key, item: line }, index) => (
      <Fragment key={key}>
        {index ? "\n" : null}
        <span>
          <TokenLine tokens={line} />
        </span>
      </Fragment>
    ),
  );
}
