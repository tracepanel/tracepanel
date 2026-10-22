// Signals in a trace, as the Python SDK records Django's: a send is a `signal` span, each receiver it ran a `function`
// span under it, with the exception it raised (send_robust() catches it: the trace stays ok). Plain data, no React.
import type { Span } from "../types";

type Attrs = Record<string, unknown>;

/** A receiver's span: a function a signal ran. */
export function isReceiver(span: Pick<Span, "kind">, parent: Pick<Span, "kind"> | undefined): boolean {
  return span.kind === "function" && parent?.kind === "signal";
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** What a send is a repeat of: its signal and its sender, `post_save auth.Group`. */
export function sendTemplate(span: Pick<Span, "name" | "attrs">): string {
  const sender = text(span.attrs["signal.sender"]);
  return sender ? `${span.name} ${sender}` : span.name;
}

/** What a span raised, as an error reads (`ConnectionError: warehouse offline`); null when it raised nothing. */
export function raised(attrs: Attrs): { type: string; message: string | null } | null {
  const type = text(attrs["exception.type"]);
  return type ? { type: type.replace(/^builtins\./, ""), message: text(attrs["exception.message"]) } : null;
}

/** The same, on one line. */
export function raisedLine(attrs: Attrs): string | null {
  const found = raised(attrs);
  if (!found) return null;
  return found.message ? `${found.type}: ${found.message}` : found.type;
}

/** Where a receiver is defined: `shop/receivers.py:12`. */
export function definedAt(attrs: Attrs): string | null {
  const file = text(attrs["code.filepath"]);
  if (!file) return null;
  const line = attrs["code.lineno"];
  return typeof line === "number" ? `${file}:${line}` : file;
}

/** How many receivers a send ran: the ones it names, else its receivers' spans. */
export function receiverCount(span: Span, receivers: readonly Span[]): number {
  const named = span.attrs["signal.receivers"];
  return Array.isArray(named) ? named.length : receivers.length;
}

/** The receivers that raised. */
export function failedReceivers(receivers: readonly Span[]): number {
  return receivers.filter((receiver) => receiver.status === "error").length;
}

/** The sends nobody received, as the request's overview lists them: `pre_save auth.Group ×3`, one sent once bare. */
export function unreceived(attrs: Attrs): string[] {
  const listed = attrs["signal.unreceived"];
  if (!Array.isArray(listed)) return [];
  return listed.map((item) =>
    String(item).replace(/: (\d+)$/, (_, count: string) => (count === "1" ? "" : ` ×${count}`)),
  );
}
