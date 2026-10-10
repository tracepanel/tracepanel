import { Lexer, parse, print, Source, TokenKind } from "graphql";

/**
 * GraphQL documents through graphql-js, the reference implementation: `print(parse())` formats them, its lexer
 * tokenizes them for highlighting. A document that does not parse (cut off at 2000 characters) is shown as stored.
 */
export function formatGraphql(document: string): string {
  try {
    return print(parse(document, { noLocation: true }));
  } catch {
    return document;
  }
}

export type GraphqlTokenType =
  | "keyword"
  | "type"
  | "variable"
  | "argument"
  | "directive"
  | "string"
  | "number"
  | "punctuation"
  | "text";

const KEYWORDS = new Set(["query", "mutation", "subscription", "fragment", "on", "true", "false", "null"]);

/** Tokens for highlighting, gaps (whitespace, commas, comments) as text: joined, they are the input again. */
export function tokenizeGraphql(text: string): { type: GraphqlTokenType; text: string }[] {
  const lexer = new Lexer(new Source(text));
  const tokens: { type: GraphqlTokenType; text: string }[] = [];
  let at = 0;
  let parens = 0;
  // What came before decides what a name is: `$` → variable, `@` → directive, `on` / `fragment` → type, ...
  let previous = "";
  let afterColon = false;
  try {
    for (let token = lexer.advance(); token.kind !== TokenKind.EOF; token = lexer.advance()) {
      if (token.start > at) tokens.push({ type: "text", text: text.slice(at, token.start) });
      const raw = text.slice(token.start, token.end);
      let type: GraphqlTokenType = "punctuation";
      if (token.kind === TokenKind.STRING || token.kind === TokenKind.BLOCK_STRING) type = "string";
      else if (token.kind === TokenKind.INT || token.kind === TokenKind.FLOAT) type = "number";
      else if (token.kind === TokenKind.NAME) {
        const next = lexer.lookahead();
        if (previous === "$") type = "variable";
        else if (previous === "@") type = "directive";
        else if (previous === "on" || previous === "fragment" || (afterColon && parens > 0 && /^[A-Z]/.test(raw)))
          type = "type";
        else if (KEYWORDS.has(raw) && previous !== "{" && next.kind !== TokenKind.COLON) type = "keyword";
        else if (parens > 0 && next.kind === TokenKind.COLON) type = "argument";
        else type = "text";
      } else if (token.kind === TokenKind.DOLLAR) type = "variable";
      else if (token.kind === TokenKind.AT) type = "directive";
      if (token.kind === TokenKind.PAREN_L) parens += 1;
      if (token.kind === TokenKind.PAREN_R) parens = Math.max(parens - 1, 0);
      afterColon =
        token.kind === TokenKind.COLON ||
        (afterColon && (token.kind === TokenKind.BRACKET_L || token.kind === TokenKind.BRACKET_R));
      previous = token.kind === TokenKind.NAME ? raw : token.kind;
      tokens.push({ type, text: raw });
      at = token.end;
    }
  } catch {
    // Not valid GraphQL past this point: the rest stays plain.
  }
  if (at < text.length) tokens.push({ type: "text", text: text.slice(at) });
  return tokens;
}
