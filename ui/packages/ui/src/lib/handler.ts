// What the code that answered a request is called: Django's word, a view, in a Python app; a handler in the others
// (Spring, Ktor, Express, NestJS, Next.js, Go). The data keeps one name for it (code.view, a span of kind view);
// only the words shown differ. Plain data, no React: the console's panel and the page widget both say it.
import type { Span, Trace } from "../types";

type Attrs = Record<string, unknown>;

/** "View" in a Python app, and in one that doesn't name its language (the Python SDK came first); else "Handler". */
export function handlerWord(attrs: Attrs): "View" | "Handler" {
  const language = attrs["telemetry.sdk.language"];
  return typeof language !== "string" || language === "" || language === "python" ? "View" : "Handler";
}

/**
 * A span's kind as the call tree names it: the root is the request, the handler's span a view or a handler, a
 * function a signal ran (its parent's kind) its receiver.
 */
export function spanKindLabel(kind: string | undefined, attrs: Attrs, parentKind?: string | undefined): string {
  const own = ownKind(kind, parentKind);
  const word = KIND_WORDS.get(own);
  return word ? word(attrs) : own;
}

/** The kinds the call tree says in words of their own. */
const KIND_WORDS = new Map<string, (attrs: Attrs) => string>([
  ["http", () => "request"],
  // One name per thing: a task's run is a task, as its row says it where it was enqueued; a command is a job, as the
  // console calls it.
  ["task.run", () => "task"],
  ["command", () => "job"],
  // A migration's operation is an operation: the migration's row above says whose.
  ["migration.operation", () => "operation"],
  ["view", (attrs) => handlerWord(attrs).toLowerCase()],
]);

function ownKind(kind: string | undefined, parentKind: string | undefined): string {
  return kind === "function" && parentKind === "signal" ? "receiver" : (kind ?? "");
}

/**
 * The handler's full name, when its span has one the short name leaves out: Spring's BookController#list is
 * com.shop.BookController.list in its code.function.
 */
export function handlerFullName(trace: Pick<Trace, "attrs" | "spans">): string | null {
  const shown = trace.attrs["code.view"];
  if (typeof shown !== "string") return null;
  const span = trace.spans.find((each: Span) => each.kind === "view" && each.name === shown);
  const full = span?.attrs["code.function"];
  return typeof full === "string" && full !== shown ? full : null;
}
