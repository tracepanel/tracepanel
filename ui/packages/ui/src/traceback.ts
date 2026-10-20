// A log record's exception as the frames an error shows: the traceback text a record carries (Python's, a JVM's stack
// trace, a JavaScript stack) read back into the shape the agent stores an error in, so it opens as the Error tab does.
import type { ChainedError, Frame } from "./types";

/** An exception read from its text: its type and message, its frames (most recent call last), what it chained. */
export interface ParsedException {
  type: string;
  message: string;
  frames: Frame[];
  /** Inner exceptions, nearest first. */
  chain: ChainedError[];
}

type Relation = ChainedError["relation"];

/** One exception of a text: a chained one's relation to the one after it. */
interface Block {
  type: string;
  message: string;
  frames: Frame[];
}

function frame(filename: string, module: string, func: string, lineno: number, inApp: boolean, line?: string): Frame {
  return {
    filename,
    module,
    function: func,
    lineno,
    // biome-ignore lint/style/useNamingConvention: the stored error's field, as the schema names it.
    in_app: inApp,
    // The one line the text quotes, where it has one: shown as the frame's source.
    // biome-ignore lint/style/useNamingConvention: the stored error's field, as the schema names it.
    context_start: line ? lineno : null,
    context: line ? [line] : [],
    locals: null,
  };
}

/** "ValueError: bad input" → its type and message; a line with no colon is a type alone. */
function typeAndMessage(line: string): { type: string; message: string } {
  const at = line.indexOf(": ");
  return at === -1
    ? { type: line.trim(), message: "" }
    : { type: line.slice(0, at).trim(), message: line.slice(at + 2) };
}

/** The outermost exception first, its chain after it (nearest first): the shape ErrorView shows. */
function chained(blocks: readonly Block[], relations: readonly Relation[]): ParsedException | null {
  const [outer, ...inner] = blocks;
  if (!outer || outer.frames.length === 0) return null;
  return { ...outer, chain: inner.map((block, index) => ({ ...block, relation: relations[index] ?? "cause" })) };
}

/* ---------- Python ---------- */

// The lines between two tracebacks: the one above caused the one below, or failed while it was handled.
const PY_SEPARATORS = new Map<string, Relation>([
  ["The above exception was the direct cause of the following exception:", "cause"],
  ["During handling of the above exception, another exception occurred:", "context"],
]);
const PY_FRAME = /^\s*File "(.+)", line (\d+), in (.+)$/;
// What isn't the app's: the standard library, installed packages, frozen modules.
const PY_LIBRARY = /([\\/](site|dist)-packages[\\/])|([\\/]lib[\\/]python\d)|(^<frozen )/;
// The last of them in a path: a package under a Python of its own (lib/python3.12/site-packages) is the package.
const PY_PACKAGE_ROOT = /^.*[\\/](?:(?:site|dist)-packages|lib[\\/]python\d+\.\d+)[\\/]/;

/** A file's module, as its import names it: django/core/handlers/base.py → django.core.handlers.base. */
function pythonModule(path: string): string {
  return path
    .replace(PY_PACKAGE_ROOT, "")
    .replace(/^[\\/]+/, "")
    .replace(/\.py$/, "")
    .replace(/[\\/]__init__$/, "")
    .replaceAll(/[\\/]/g, ".");
}

/** Under the line of a frame: the source it quotes, unless it is a marker (^^^^) or the next frame. */
function sourceLine(next = ""): string | undefined {
  return quotes(next) ? next.trim() : undefined;
}

/** Whether a line quotes source: indented further than a frame's, and no marker (^^^^) or frame itself. */
function quotes(line: string): boolean {
  return /^\s{4}/.test(line) && !PY_FRAME.test(line) && !/^\s*[~^\s]*$/.test(line);
}

function pythonFrame(match: RegExpExecArray, next: string | undefined): Frame {
  const [, path = "", lineno = "0", func = ""] = match;
  const library = PY_LIBRARY.test(path);
  // A library's file under its package (django/db/…), the app's as the traceback has it.
  const filename = library ? path.replace(PY_PACKAGE_ROOT, "") : path;
  return frame(filename, pythonModule(path), func, Number(lineno), !library, sourceLine(next));
}

/** The exception's line: the last that isn't indented, under the frames; more lines of its message after it. */
function pythonEnd(lines: readonly string[]): { type: string; message: string } {
  const start = lines.findIndex((line) => line !== "" && !/^\s/.test(line) && !line.startsWith("Traceback"));
  const head = typeAndMessage(lines[start] ?? "");
  const more = lines.slice(start + 1).filter((line) => line.trim() !== "");
  return { type: head.type, message: [head.message, ...more].join("\n").trim() };
}

function pythonBlock(text: string): Block {
  const lines = text.split("\n");
  const frames: Frame[] = [];
  lines.forEach((line, index) => {
    const match = PY_FRAME.exec(line);
    if (match) frames.push(pythonFrame(match, lines[index + 1]));
  });
  // The exception's own line comes after the last frame's.
  const lastFrame = lines.length - 1 - [...lines].reverse().findIndex((line) => PY_FRAME.test(line));
  return { ...pythonEnd(lines.slice(lastFrame + 1)), frames };
}

/** Python's: "Traceback (most recent call last):", innermost cause first, the exception raised last. */
function python(text: string): ParsedException | null {
  const blocks: Block[] = [];
  const relations: Relation[] = [];
  let current: string[] = [];
  for (const line of text.split("\n")) {
    const relation = PY_SEPARATORS.get(line.trim());
    if (relation === undefined) current.push(line);
    else {
      blocks.push(pythonBlock(current.join("\n")));
      relations.push(relation);
      current = [];
    }
  }
  blocks.push(pythonBlock(current.join("\n")));
  // Raised last is the one the record is about: first, its causes after it, nearest first.
  return chained(blocks.reverse(), relations.reverse());
}

/* ---------- the JVM ---------- */

const JAVA_FRAME = /^\s*at ([\w$.<>/]+)\.([\w$<>]+)\(([^)]*)\)\s*$/;
const JAVA_LIBRARY =
  /^(java|javax|jdk|sun|com\.sun|kotlin|kotlinx|scala|org\.springframework|org\.apache|org\.hibernate|io\.netty|reactor|org\.eclipse|com\.fasterxml|ch\.qos|org\.slf4j|io\.micrometer|io\.opentelemetry|com\.zaxxer|org\.junit|io\.grpc)\./;

/** "Foo.java:12" → the file and the line; "Native Method" and "Unknown Source" have neither. */
function javaPlace(where: string): [string, number] {
  const [file = where, line = "0"] = where.split(":");
  return [file, Number(line)];
}

function javaFrame([, owner = "", method = "", where = ""]: RegExpExecArray): Frame {
  const [file, lineno] = javaPlace(where);
  // The class without the module it is in (java.base/java.lang.Thread).
  const name = owner.replace(/^[\w.$-]+\//, "");
  const simple = name.split(".").at(-1) ?? name;
  return frame(file, name, `${simple}.${method}`, lineno, !JAVA_LIBRARY.test(name));
}

/** A JVM block: its "Type: message" line, then its frames, most recent first, turned to most recent last. */
function javaBlock(lines: readonly string[]): Block {
  const frames = lines.flatMap((line) => {
    const match = JAVA_FRAME.exec(line);
    return match ? [javaFrame(match)] : [];
  });
  return { ...typeAndMessage(lines[0] ?? ""), frames: frames.reverse() };
}

/** A JVM's stack trace: the exception first, each "Caused by:" the cause of the one above it. */
function java(text: string): ParsedException | null {
  const parts = text.trim().split(/\n(?:\s*)Caused by: /);
  const blocks = parts.map((part) => javaBlock(part.split("\n")));
  return chained(blocks, []);
}

/* ---------- JavaScript ---------- */

const JS_FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):\d+\)?\s*$/;
const JS_LIBRARY = /(node_modules[\\/])|(^node:)|(^internal[\\/])/;

function jsFrame([, func = "<anonymous>", path = "", lineno = "0"]: RegExpExecArray): Frame {
  const module = path.replace(/^.*node_modules[\\/]/, "").replace(/\.[cm]?[jt]sx?$/, "");
  return frame(path, module, func, Number(lineno), !JS_LIBRARY.test(path));
}

/** A JavaScript stack: "TypeError: message", then its frames, most recent first, turned to most recent last. */
function javascript(text: string): ParsedException | null {
  const lines = text.trim().split("\n");
  const first = lines.findIndex((line) => JS_FRAME.test(line));
  const frames = lines.flatMap((line) => {
    const match = JS_FRAME.exec(line);
    return match ? [jsFrame(match)] : [];
  });
  const head = typeAndMessage(lines.slice(0, first).join("\n"));
  return chained([{ ...head, frames: frames.reverse() }], []);
}

/* ---------- which one ---------- */

/** Each runtime's text, told by its first frame's line: Python's names the file, a JVM's the class and the file. */
const READERS: readonly [RegExp, (text: string) => ParsedException | null][] = [
  [/^Traceback \(most recent call last\):$/m, python],
  [/^\s*at [\w$.<>/]+\([^)]*\)\s*$/m, java],
  [/^\s*at .+:\d+:\d+\)?\s*$/m, javascript],
];

/** A traceback's frames, or null when the text isn't one of a runtime the console knows. */
export function parseTraceback(text: string): ParsedException | null {
  const reader = READERS.find(([test]) => test.test(text))?.[1];
  return reader ? reader(text.replaceAll("\r\n", "\n")) : null;
}
