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

/** A span's kind as the call tree names it: the root is the request, the handler's span a view or a handler. */
export function spanKindLabel(kind: string | undefined, attrs: Attrs): string {
  if (kind === "http") return "request";
  if (kind === "view") return handlerWord(attrs).toLowerCase();
  return kind ?? "";
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
