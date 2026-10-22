// A Python literal as repr() writes one (a task's arguments, its result) read into the JSON value it stands for, so
// it shows as JSON does: `{'attempts': 3}` as {"attempts": 3}, a tuple as an array, None as null. Anything else (an
// object's repr, a cut value) is not a literal: undefined, and it shows as it came.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface Reader {
  text: string;
  at: number;
}

const WORDS = new Map<string, Json>([
  ["None", null],
  ["True", true],
  ["False", false],
]);

/** The JSON value a Python literal stands for, or undefined when the text is not one, whole. */
export function pythonLiteral(text: string): Json | undefined {
  const reader = { text: text.trim(), at: 0 };
  try {
    const value = item(reader);
    blank(reader);
    return reader.at === reader.text.length ? value : undefined;
  } catch {
    return undefined;
  }
}

function blank(reader: Reader): void {
  while (/\s/.test(reader.text[reader.at] ?? "")) reader.at += 1;
}

// What reads a value, by its first character; any other starts a scalar (a number, None, True, False).
const READERS = new Map<string, (reader: Reader) => Json>([
  ["{", (reader) => dict(reader)],
  ["[", (reader) => sequence(reader, "]")],
  ["(", (reader) => sequence(reader, ")")],
  ["'", (reader) => string(reader)],
  ['"', (reader) => string(reader)],
]);

function item(reader: Reader): Json {
  blank(reader);
  const read = READERS.get(reader.text[reader.at] ?? "") ?? scalar;
  return read(reader);
}

function scalar(reader: Reader): Json {
  const match = /^(None|True|False|-?(?:\d[\d_]*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(reader.text.slice(reader.at));
  if (!match?.[1]) throw new Error("not a literal");
  reader.at += match[1].length;
  const word = WORDS.get(match[1]);
  return word === undefined ? Number(match[1].replaceAll("_", "")) : word;
}

function string(reader: Reader): string {
  const quote = reader.text[reader.at] ?? "";
  reader.at += 1;
  let out = "";
  while (open(reader, quote)) {
    out += character(reader);
    reader.at += 1;
  }
  reader.at += 1;
  return out;
}

/** Whether a string goes on: its quote not reached; the end of the text first is no literal. */
function open(reader: Reader, quote: string): boolean {
  if (reader.at >= reader.text.length) throw new Error("unclosed string");
  return reader.text[reader.at] !== quote;
}

function character(reader: Reader): string {
  const char = reader.text[reader.at] ?? "";
  return char === "\\" ? escaped(reader) : char;
}

const ESCAPES = new Map([
  ["n", "\n"],
  ["t", "\t"],
  ["r", "\r"],
  ["\\", "\\"],
  ["'", "'"],
  ['"', '"'],
]);

function escaped(reader: Reader): string {
  reader.at += 1;
  const char = reader.text[reader.at] ?? "";
  const known = ESCAPES.get(char);
  if (known !== undefined) return known;
  throw new Error("escape not read");
}

function sequence(reader: Reader, closer: string): Json[] {
  const items: Json[] = [];
  reader.at += 1;
  each(reader, closer, () => items.push(item(reader)));
  return items;
}

function dict(reader: Reader): { [key: string]: Json } {
  const out: { [key: string]: Json } = {};
  reader.at += 1;
  each(reader, "}", () => {
    const key = item(reader);
    blank(reader);
    if (reader.text[reader.at] !== ":") throw new Error("not a dict");
    reader.at += 1;
    out[typeof key === "string" ? key : JSON.stringify(key)] = item(reader);
  });
  return out;
}

/** The items of a bracket up to its closer, commas between them and one allowed after the last. */
function each(reader: Reader, closer: string, read: () => void): void {
  while (!at(reader, closer)) {
    read();
    separator(reader, closer);
  }
  reader.at += 1;
}

function at(reader: Reader, char: string): boolean {
  blank(reader);
  return reader.text[reader.at] === char;
}

/** After an item: a comma, or the closer right there. */
function separator(reader: Reader, closer: string): void {
  if (at(reader, ",")) reader.at += 1;
  else if (!at(reader, closer)) throw new Error("expected a comma");
}

// A task's values that are Python literals as its SDK writes them: shown as JSON wherever they show.
const TASK_LITERALS = new Set(["task.args", "task.kwargs", "task.result"]);

/** An attribute's value to show: a task's arguments and result as the JSON they stand for, the rest as they came. */
export function shownValue(key: string, value: unknown): unknown {
  if (!(TASK_LITERALS.has(key) && typeof value === "string")) return value;
  return pythonLiteral(value) ?? value;
}
