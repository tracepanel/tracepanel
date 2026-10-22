// JSON as the console shows it wherever text may be JSON: a request's body, a log record's message.

/** JSON text indented two spaces a level; null when the text isn't JSON. */
export function indentedJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

/** A JSON object or array, indented: a message that is a document, not one value (a number, a quoted word). */
export function jsonDocument(text: string): string | null {
  return /^\s*[[{]/.test(text) ? indentedJson(text) : null;
}

/** How each of JSON's own characters is laid out, at a depth: the piece it becomes and the depth after it. */
const LAYOUT: Record<string, (depth: number) => [string, number]> = {
  "{": (depth) => [`{${newline(depth + 1)}`, depth + 1],
  "[": (depth) => [`[${newline(depth + 1)}`, depth + 1],
  "}": (depth) => [`${newline(depth - 1)}}`, Math.max(depth - 1, 0)],
  "]": (depth) => [`${newline(depth - 1)}]`, Math.max(depth - 1, 0)],
  ",": (depth) => [`,${newline(depth)}`, depth],
  ":": (depth) => [": ", depth],
};

function newline(depth: number): string {
  return `\n${"  ".repeat(Math.max(depth, 0))}`;
}

/**
 * JSON cut short (a body kept up to its limit) laid out as indentedJson() lays out a whole document: a line a value,
 * two spaces a level. It reads the text as it goes, quotes included, and never needs its end.
 */
export function indentedPartialJson(text: string): string {
  const out: string[] = [];
  let depth = 0;
  let at = 0;
  while (at < text.length) {
    const [piece, next, after] = step(text, at, depth);
    out.push(piece);
    depth = next;
    at = after;
  }
  return out.join("");
}

/** The piece the text at `at` becomes: a string whole, an empty object or list as it is, else one character laid out. */
function step(text: string, at: number, depth: number): [string, number, number] {
  const char = text.charAt(at);
  if (char === '"') {
    const end = stringEnd(text, at);
    return [text.slice(at, end), depth, end];
  }
  const closer = { "{": "}", "[": "]" }[char];
  const next = solidAfter(text, at);
  if (closer !== undefined && text.charAt(next) === closer) return [`${char}${closer}`, depth, next + 1];
  const [piece, after] = LAYOUT[char]?.(depth) ?? [/\s/.test(char) ? "" : char, depth];
  return [piece, after, at + 1];
}

/** Where the string that opens at `at` ends, past its closing quote; the text's end when it was cut inside it. */
function stringEnd(text: string, at: number): number {
  let end = at + 1;
  while (end < text.length) {
    const char = text.charAt(end);
    if (char === '"') return end + 1;
    end += char === "\\" ? 2 : 1;
  }
  return text.length;
}

/** The first character after `at` that isn't white space. */
function solidAfter(text: string, at: number): number {
  let next = at + 1;
  while (next < text.length && /\s/.test(text.charAt(next))) next += 1;
  return next;
}
