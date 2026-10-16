/**
 * Highlighting of the source around an error's frame: a window of a file, a few lines. A tokenizer of its own per
 * language, enough for keywords, strings, comments, numbers and calls, without a highlighter's grammars in the bundle.
 * A string or comment opened above the window is read as code, which is the price of a window.
 */

export type Language = "python" | "go" | "javascript" | "java" | "kotlin";

/** The classes a token takes, as Prism names them: the console's styles color them. */
export type SourceTokenType =
  | "keyword"
  | "boolean"
  | "string"
  | "number"
  | "comment"
  | "function"
  | "class-name"
  | "builtin"
  | "decorator"
  | "operator"
  | "punctuation"
  | "plain";

export interface SourceToken {
  type: SourceTokenType;
  text: string;
}

const EXTENSIONS: Record<string, Language> = {
  py: "python",
  go: "go",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "javascript",
  mts: "javascript",
  cts: "javascript",
  tsx: "javascript",
  java: "java",
  kt: "kotlin",
};

/** The language a frame's file is written in, by its name; null for one shown as plain text. */
export function languageOf(filename: string): Language | null {
  const extension = filename.split(/[?#]/)[0]?.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSIONS[extension] ?? null;
}

const words = (text: string): ReadonlySet<string> => new Set(text.split(/\s+/).filter(Boolean));

interface Grammar {
  keywords: ReadonlySet<string>;
  booleans: ReadonlySet<string>;
  builtins: ReadonlySet<string>;
  /** Comments, strings and annotations, tried in order before words and numbers. */
  spans: readonly [SourceTokenType, RegExp][];
}

const NUMBER = /(?:0[xob][\da-f_]+|\d[\d_]*(?:\.[\d_]+)?(?:e[+-]?\d+)?)[jlfdn]?\b/iy;
const WORD = /[A-Za-z_$][\w$]*/y;
const OPERATOR = /[-+*/%=<>!&|^~?:]+/y;
const PUNCTUATION = /[()[\]{},.;]/y;
const LINE_COMMENT = /\/\/[^\n]*/y;
const BLOCK_COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/y;
const DOUBLE_QUOTED = /"(?:\\.|[^"\\\n])*"?/y;
const SINGLE_QUOTED = /'(?:\\.|[^'\\\n])*'?/y;

const GRAMMARS: Record<Language, Grammar> = {
  python: {
    keywords: words(`and as assert async await break class continue def del elif else except finally for from global
      if import in is lambda match case nonlocal not or pass raise return try while with yield`),
    booleans: words("True False None"),
    builtins: words(`print len range dict list set tuple str int float bool bytes object type isinstance getattr
      setattr hasattr super open sorted enumerate zip map filter min max sum any all iter next repr self cls`),
    spans: [
      ["comment", /#[^\n]*/y],
      ["string", /[rbfuRBFU]{0,2}("""|''')[\s\S]*?(?:\1|$)/y],
      ["string", /[rbfuRBFU]{0,2}(?:"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)/y],
      ["decorator", /@[\w.]+/y],
    ],
  },
  go: {
    keywords: words(`break case chan const continue default defer else fallthrough for func go goto if import
      interface map package range return select struct switch type var`),
    booleans: words("true false nil iota"),
    builtins: words(`append cap clear close complex copy delete imag len make max min new panic print println real
      recover any bool byte comparable error float32 float64 int int8 int16 int32 int64 rune string uint uint8
      uint16 uint32 uint64 uintptr`),
    spans: [
      ["comment", LINE_COMMENT],
      ["comment", BLOCK_COMMENT],
      ["string", /`[^`]*`?/y],
      ["string", DOUBLE_QUOTED],
      ["string", SINGLE_QUOTED],
    ],
  },
  javascript: {
    keywords: words(`abstract as async await break case catch class const continue debugger declare default delete
      do else enum export extends finally for from function get if implements import in instanceof interface
      keyof let namespace new of private protected public readonly return satisfies set static super switch this
      throw try type typeof var void while with yield`),
    booleans: words("true false null undefined NaN Infinity"),
    builtins: words(`console window document globalThis process require module exports Promise Array Object String
      Number Boolean Map Set JSON Math Date Error RegExp Symbol`),
    spans: [
      ["comment", LINE_COMMENT],
      ["comment", BLOCK_COMMENT],
      ["string", /`(?:\\[\s\S]|[^`\\])*`?/y],
      ["string", DOUBLE_QUOTED],
      ["string", SINGLE_QUOTED],
      ["decorator", /@[\w.]+/y],
    ],
  },
  java: {
    keywords: words(`abstract assert break case catch class const continue default do else enum extends final
      finally for goto if implements import instanceof interface native new package permits private protected
      public record return sealed static strictfp super switch synchronized this throw throws transient try var
      void volatile while yield boolean byte char double float int long short`),
    booleans: words("true false null"),
    builtins: words("String Object System Integer Long Double Boolean List Map Set Optional"),
    spans: [
      ["comment", LINE_COMMENT],
      ["comment", BLOCK_COMMENT],
      ["string", /"""[\s\S]*?(?:"""|$)/y],
      ["string", DOUBLE_QUOTED],
      ["string", SINGLE_QUOTED],
      ["decorator", /@[\w.]+/y],
    ],
  },
  kotlin: {
    keywords: words(`as break by class companion const constructor continue data do else enum external fun get if
      import in infix init inline interface internal is lateinit object open operator out override package private
      protected public reified return sealed set super suspend this throw try typealias val var vararg when where
      while`),
    booleans: words("true false null"),
    builtins: words("String Any Int Long Double Boolean Unit List Map Set listOf mapOf setOf println"),
    spans: [
      ["comment", LINE_COMMENT],
      ["comment", BLOCK_COMMENT],
      ["string", /"""[\s\S]*?(?:"""|$)/y],
      ["string", DOUBLE_QUOTED],
      ["string", SINGLE_QUOTED],
      ["decorator", /@[\w.:]+/y],
    ],
  },
};

function match(pattern: RegExp, code: string, at: number): string | null {
  pattern.lastIndex = at;
  return pattern.exec(code)?.[0] || null;
}

const SYMBOLS: readonly [SourceTokenType, RegExp][] = [
  ["number", NUMBER],
  ["operator", OPERATOR],
  ["punctuation", PUNCTUATION],
];

/** The token at `at`: a comment, string or annotation first, then a word, a number or a symbol, else a character. */
function tokenAt(code: string, at: number, grammar: Grammar): SourceToken {
  for (const [type, pattern] of grammar.spans) {
    const text = match(pattern, code, at);
    if (text) return { type, text };
  }
  const word = match(WORD, code, at);
  if (word) return { type: wordType(word, code, at + word.length, grammar), text: word };
  for (const [type, pattern] of SYMBOLS) {
    const text = match(pattern, code, at);
    if (text) return { type, text };
  }
  return { type: "plain", text: code[at] ?? "" };
}

/** The tokens of `code`, in order: their texts put together are `code`. Plain text runs together. */
function tokenize(code: string, language: Language): SourceToken[] {
  const grammar = GRAMMARS[language];
  const tokens: SourceToken[] = [];
  for (let at = 0; at < code.length; ) {
    const token = tokenAt(code, at, grammar);
    const last = tokens.at(-1);
    if (token.type === "plain" && last?.type === "plain") last.text += token.text;
    else tokens.push(token);
    at += token.text.length;
  }
  return tokens;
}

function wordType(word: string, code: string, after: number, grammar: Grammar): SourceTokenType {
  if (grammar.keywords.has(word)) return "keyword";
  if (grammar.booleans.has(word)) return "boolean";
  if (grammar.builtins.has(word)) return "builtin";
  if (/^\s*\(/.test(code.slice(after, after + 8))) return "function";
  if (/^[A-Z]/.test(word) && /[a-z]/.test(word)) return "class-name";
  return "plain";
}

/** The tokens of each line: a token across lines, such as a block comment, is split at each line's end. */
export function tokenizeLines(lines: readonly string[], language: Language): SourceToken[][] {
  const result: SourceToken[][] = [[]];
  for (const token of tokenize(lines.join("\n"), language)) {
    token.text.split("\n").forEach((part, index) => {
      if (index > 0) result.push([]);
      if (part) result.at(-1)?.push({ type: token.type, text: part });
    });
  }
  while (result.length < lines.length) result.push([]);
  return result;
}
