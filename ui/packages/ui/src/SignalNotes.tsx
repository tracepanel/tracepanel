// What a call tree row says of a signal after its name: a send's sender, how many receivers it ran and how many of
// them failed (send_robust() keeps the trace ok: this is where a failure shows), a receiver's file and line, or what
// it raised.
import { Badge } from "./components/ui/badge";
import { definedAt, failedReceivers, isReceiver, raisedLine, receiverCount } from "./lib/signals";
import type { Span } from "./types";

function Sender({ sender }: { sender: unknown }) {
  return typeof sender === "string" && sender ? (
    <span className="dt-map-sub" title={sender}>
      {sender}
    </span>
  ) : null;
}

function SendNotes({ span, receivers }: { span: Span; receivers: readonly Span[] }) {
  const count = receiverCount(span, receivers);
  const failed = failedReceivers(receivers);
  return (
    <>
      <Sender sender={span.attrs["signal.sender"]} />
      <span className="dt-map-sub" data-count="">
        {count} {count === 1 ? "receiver" : "receivers"}
      </span>
      {failed ? (
        <Badge variant="error" size="compact" data-failed="">
          {failed} failed
        </Badge>
      ) : null}
    </>
  );
}

function ReceiverNotes({ span }: { span: Span }) {
  const where = definedAt(span.attrs);
  const error = raisedLine(span.attrs);
  if (error) {
    return (
      <span className="dt-map-sub" data-error="" title={where ? `${error}\n${where}` : error}>
        {error}
      </span>
    );
  }
  return where ? (
    <span className="dt-map-sub" title={where}>
      {where}
    </span>
  ) : null;
}

/** A signal's or a receiver's notes; any other row has none. `under` are the spans right under the row. */
export function SignalNotes({ span, parent, under }: { span: Span; parent: Span | undefined; under: readonly Span[] }) {
  if (span.kind === "signal") {
    return <SendNotes span={span} receivers={under.filter((child) => isReceiver(child, span))} />;
  }
  return isReceiver(span, parent) ? <ReceiverNotes span={span} /> : null;
}
