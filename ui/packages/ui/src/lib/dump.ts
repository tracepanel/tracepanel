// A dump: what a developer printed to look at (python-devtools' debug()), sent as a log record with `log.kind` dump,
// each argument in `dump.args` and the call's place in `code.origin`. Always shown, unlike a quiet record.
import { type Language, languageOf } from "../highlight";
import type { Log } from "../types";

type Dumped = Pick<Log, "attrs">;

/** An argument printed: as written in the call (null when unread), its value laid out, its type, its length. */
export interface DumpArg {
  expr: string | null;
  repr: string;
  type: string;
  len: number | null;
}

/** Whether a record is a dump; a record sent without attributes (an older SDK's) isn't. */
export function isDump(log: Dumped): boolean {
  return (log.attrs as Dumped["attrs"] | undefined)?.["log.kind"] === "dump";
}

function argOf(value: unknown): DumpArg | null {
  if (typeof value !== "object" || value === null) return null;
  const { expr, repr, type, len } = value as Record<string, unknown>;
  return {
    expr: typeof expr === "string" && expr ? expr : null,
    repr: typeof repr === "string" ? repr : String(repr ?? ""),
    type: typeof type === "string" ? type : "",
    len: typeof len === "number" ? len : null,
  };
}

/** The list as it came, or as JSON text (an exporter that keeps attributes as scalars sends it so). */
function listOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** A dump's arguments, in the order printed; none for any other record. */
export function dumpArgs(log: Dumped): DumpArg[] {
  return listOf(log.attrs["dump.args"]).flatMap((value) => argOf(value) ?? []);
}

/** Where the dump was called: `shop/views.py:12 in checkout`, else the record's file and line. */
export function dumpOrigin(log: Dumped): string | null {
  const origin = log.attrs["code.origin"];
  if (typeof origin === "string" && origin) return origin;
  const file = log.attrs["code.filepath"];
  if (typeof file !== "string" || !file) return null;
  const line = log.attrs["code.lineno"];
  return typeof line === "number" ? `${file}:${line}` : file;
}

/** The call site alone, file and line: `shop/views.py:12`. */
export function dumpSite(log: Dumped): string | null {
  return dumpOrigin(log)?.split(" in ")[0] ?? null;
}

/** An argument on one line: `order = Order(id=7, …)`, or its value alone when the call's text is unknown. */
export function argLine(arg: DumpArg): string {
  const value = arg.repr.replace(/\s+/g, " ").trim();
  return arg.expr ? `${arg.expr} = ${value}` : value;
}

// The SDKs' dumpers, by the logger they send under, and the language their values read as.
const DUMPERS = new Map<string, Language>([["devtools", "python"]]);

// The languages a dump says it is printed in (`dump.lang`), with the other names an SDK may give them.
const LANGUAGES = new Map<string, Language>([
  ["python", "python"],
  ["py", "python"],
  ["javascript", "javascript"],
  ["js", "javascript"],
  ["typescript", "javascript"],
  ["ts", "javascript"],
  ["node", "javascript"],
  ["go", "go"],
  ["golang", "go"],
  ["java", "java"],
  ["kotlin", "kotlin"],
  ["kt", "kotlin"],
  ["rust", "rust"],
  ["rs", "rust"],
]);

/** The language a dump says its values are in; undefined when it doesn't say, null for one not coloured. */
function saidLanguage(log: Pick<Log, "attrs">): Language | null | undefined {
  const said = log.attrs["dump.lang"];
  if (typeof said !== "string" || !said.trim()) return undefined;
  return LANGUAGES.get(said.trim().toLowerCase()) ?? null;
}

/**
 * What a dump's values are written in, to colour them: as it says (`dump.lang`), else its dumper's, else its file's;
 * null for plain text, such as a language the console has no tokenizer for.
 */
export function dumpLanguage(log: Pick<Log, "logger" | "attrs">): Language | null {
  const said = saidLanguage(log);
  if (said !== undefined) return said;
  const known = DUMPERS.get(log.logger);
  if (known) return known;
  const site = dumpSite(log);
  return site ? languageOf(site.replace(/:\d+$/, "")) : null;
}
