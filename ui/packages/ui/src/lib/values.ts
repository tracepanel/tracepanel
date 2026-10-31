// How a value reads wherever names and values are listed (an attribute, a log record's field, a setting, a local):
// a word as it came, a list one item a line, a structure (JSON, a Python repr) laid out and coloured.
import type { Language } from "../highlight";
import { jsonDocument } from "../json";
import type { Attrs } from "../types";

/** Past this size a value is shown as it came: laid out and coloured, it would cost more than it tells. */
export const STRUCTURE_LIMIT = 16 * 1024;

/** A value as it is shown: text, a list of items, or code in a language. */
export type Shape =
  | { kind: "text"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "code"; text: string; language: Language };

type Scalar = string | number | boolean | null;

function isScalar(value: unknown): value is Scalar {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/** The value as text, as it came: what a copy button copies. A list or an object as JSON. */
export function rawText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value) ?? String(value);
}

/** How a value is shown: a list of scalars one a line, an object or a JSON document indented, a repr laid out. */
export function shapeOf(value: unknown): Shape {
  if (typeof value === "string") return shapeOfText(value);
  const raw = rawText(value);
  return raw.length > STRUCTURE_LIMIT || isScalar(value) ? { kind: "text", text: raw } : shapeOfStructure(value, raw);
}

/** A list of scalars one a line (an empty one as it came); anything deeper as JSON, indented. */
function shapeOfStructure(value: unknown, raw: string): Shape {
  if (!(Array.isArray(value) && value.every(isScalar))) {
    return { kind: "code", text: JSON.stringify(value, null, 2), language: "javascript" };
  }
  return value.length ? { kind: "list", items: value.map(scalarText) } : { kind: "text", text: raw };
}

function scalarText(item: Scalar): string {
  return typeof item === "string" ? item : String(item);
}

function shapeOfText(text: string): Shape {
  if (text.length > STRUCTURE_LIMIT) return { kind: "text", text };
  return codeOf(text) ?? { kind: "text", text };
}

/** Text that is code: a JSON document indented, a Python repr laid out; null for any other text. */
function codeOf(text: string): Shape | null {
  const json = jsonDocument(text);
  if (json !== null) return { kind: "code", text: json, language: "javascript" };
  return isRepr(text) ? { kind: "code", text: prettyRepr(text.trim()) ?? text, language: "python" } : null;
}

const PYTHON_WORDS = new Set(["True", "False", "None"]);
const CLOSING = new Map([
  ["[", "]"],
  ["{", "}"],
  ["(", ")"],
]);
const CLOSERS = new Set(CLOSING.values());
const QUOTES = new Set(["'", '"']);

/**
 * Whether text reads as a Python repr: True, False or None, or a list, dict, set or tuple whole (its brackets and
 * quotes balance, the first bracket closes at the end). Text that only starts with a bracket ("[1/3] step") is not.
 */
export function isRepr(text: string): boolean {
  const trimmed = text.trim();
  if (PYTHON_WORDS.has(trimmed)) return true;
  if (!CLOSING.has(trimmed.charAt(0))) return false;
  return pairs(trimmed)?.get(0) === trimmed.length - 1;
}

/** Where a quoted string that opens at `at` closes, or -1 when it doesn't. */
function stringEnd(text: string, at: number): number {
  const quote = text.charAt(at);
  for (let index = at + 1; index < text.length; index++) {
    if (text.charAt(index) === "\\") index++;
    else if (text.charAt(index) === quote) return index;
  }
  return -1;
}

/** A scan of a repr: where each bracket and quoted string that opened closes, and the brackets still open. */
interface Scan {
  text: string;
  ends: Map<number, number>;
  open: number[];
}

/** Where each bracket and each quoted string closes, by where it opens; null when they don't balance. */
function pairs(text: string): Map<number, number> | null {
  const scan: Scan = { text, ends: new Map(), open: [] };
  let at = 0;
  while (at < text.length) {
    const end = step(scan, at);
    if (end === -1) return null;
    at = end + 1;
  }
  return scan.open.length ? null : scan.ends;
}

/** Reads the character at `at`; where what it starts ends (a quoted string), or -1 when a bracket closes wrong. */
function step(scan: Scan, at: number): number {
  const char = scan.text.charAt(at);
  if (QUOTES.has(char)) return quoted(scan, at);
  if (CLOSING.has(char)) scan.open.push(at);
  else if (CLOSERS.has(char)) return closed(scan, at, char);
  return at;
}

function quoted(scan: Scan, at: number): number {
  const end = stringEnd(scan.text, at);
  if (end !== -1) scan.ends.set(at, end);
  return end;
}

function closed(scan: Scan, at: number, char: string): number {
  const start = scan.open.pop();
  if (start === undefined || CLOSING.get(scan.text.charAt(start)) !== char) return -1;
  scan.ends.set(start, at);
  return at;
}

/** A bracket group shorter than this stays on its line. */
const LINE_WIDTH = 60;

/**
 * A repr laid out as Python's pprint lays out a long one: a group that doesn't fit on a line opens, an item a line,
 * indented two spaces a level; a short one stays as it is. Null when its brackets or quotes don't balance (a repr
 * the SDK cut).
 */
export function prettyRepr(text: string): string | null {
  const ends = pairs(text);
  return ends ? layout({ text, ends }, 0, text.length, "") : null;
}

interface Scanned {
  text: string;
  ends: Map<number, number>;
}

/** The text from `from` to `to`, its long groups opened. */
function layout(scanned: Scanned, from: number, to: number, indent: string): string {
  const { text, ends } = scanned;
  let out = "";
  for (let at = from; at < to; at++) {
    const end = ends.get(at);
    if (end === undefined) {
      out += text.charAt(at);
      continue;
    }
    out += CLOSING.has(text.charAt(at)) ? group(scanned, at, end, indent) : text.slice(at, end + 1);
    at = end;
  }
  return out;
}

/** A bracket group: on one line when it is short, else an item a line. */
function group(scanned: Scanned, start: number, end: number, indent: string): string {
  const { text } = scanned;
  if (end - start < LINE_WIDTH) return text.slice(start, end + 1);
  const inner = `${indent}  `;
  const { items, trailing } = itemsOf(scanned, start + 1, end);
  const lines = items.map(([from, to]) => inner + layout(scanned, from, to, inner));
  return `${text[start]}\n${lines.join(",\n")}${trailing ? "," : ""}\n${indent}${text[end]}`;
}

/** Where a group's own commas are: not those in its strings and its inner groups. */
function commas({ text, ends }: Scanned, from: number, to: number): number[] {
  const found: number[] = [];
  for (let at = from; at < to; at = (ends.get(at) ?? at) + 1) {
    if (text.charAt(at) === ",") found.push(at);
  }
  return found;
}

/** The items of a group, split at its own commas, without the spaces around them; a comma at its end said apart. */
function itemsOf(scanned: Scanned, from: number, to: number): { items: [number, number][]; trailing: boolean } {
  const cuts = commas(scanned, from, to);
  const ends = [...cuts, to];
  const items = [from, ...cuts.map((at) => at + 1)].map((start, index) =>
    trimmed(scanned.text, start, ends[index] ?? to),
  );
  const trailing = cuts.length > 0 && scanned.text.slice(Math.max(...cuts) + 1, to).trim() === "";
  return { items: trailing ? items.slice(0, -1) : items, trailing };
}

/** The range without the spaces at its ends. */
function trimmed(text: string, from: number, to: number): [number, number] {
  const slice = text.slice(from, to);
  const start = from + slice.length - slice.trimStart().length;
  return [start, Math.max(start, to - (slice.length - slice.trimEnd().length))];
}

/** What every SDK writes in place of a secret it hid (a password, a token, a session id). */
export const MASK = "********";

/**
 * A value an SDK masked: the mask alone, or its repr (`'********'`, a masked setting or local). Nothing to copy: it
 * would copy the asterisks.
 */
export function isMasked(text: string): boolean {
  return text.trim().replace(/^(['"])(.*)\1$/, "$2") === MASK;
}

/** The attributes whose names `keep` keeps: the rest are shown elsewhere, or not at all. */
export function attrsWhere(attrs: Attrs, keep: (key: string) => boolean): Attrs {
  return Object.fromEntries(Object.entries(attrs).filter(([key]) => keep(key))) as Attrs;
}
