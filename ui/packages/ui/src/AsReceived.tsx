// What came over OTLP for a span the agent mapped from an OpenTelemetry one, at the end of its details.
import { ChevronRightIcon } from "./icons";
import { type NameValue, NameValues, RowsLookContext } from "./NameValues";
import type { Span } from "./types";

type Received = NonNullable<Span["received"]>;

/**
 * The span as it came, by the names it came with: its name, its OpenTelemetry kind and scope, then its attributes,
 * those the span keeps with the same value read from the span (`same` names the key there).
 */
function receivedRows(span: Span, received: Received): NameValue[] {
  const attrs: Record<string, unknown> = { ...received.attrs };
  for (const [name, kept] of Object.entries(received.same ?? {})) {
    if (kept in span.attrs) attrs[name] = span.attrs[kept];
  }
  const rows: NameValue[] = [{ name: "name", value: received.name }];
  if (received.span_kind) rows.push({ name: "kind", value: received.span_kind });
  if (received.scope) rows.push({ name: "scope", value: received.scope });
  const sorted = Object.keys(attrs).sort((a, b) => a.localeCompare(b));
  return [...rows, ...sorted.map((name) => ({ name, value: attrs[name] }))];
}

/**
 * A span mapped from an OpenTelemetry one: why it became what it is (a call, a step, whether it links the trace of
 * the service it called), then what the agent got, collapsed. Nothing for any other span.
 */
export function AsReceived({ span }: { span: Span }) {
  const received = span.received;
  if (!received) return null;
  return (
    <details className="dt-received" aria-label="As received over OTLP">
      <summary>
        <ChevronRightIcon />
        As received over OTLP
      </summary>
      <div className="grid gap-2 pt-2">
        <p className="m-0 text-sm text-muted-foreground" data-mapped-as="">
          {received.mapped_as}
        </p>
        <RowsLookContext value="plain">
          <NameValues rows={receivedRows(span, received)} />
        </RowsLookContext>
      </div>
    </details>
  );
}
