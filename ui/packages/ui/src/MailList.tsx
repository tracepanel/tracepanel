import { useState } from "react";
import { Badge } from "./components/ui/badge";
import { duration } from "./format";
import { type NameValue, NameValues } from "./NameValues";
import { Segmented } from "./Segmented";
import type { Attrs, Span } from "./types";

type View = "html" | "text";

const VIEWS = [
  { id: "html" as const, label: "HTML" },
  { id: "text" as const, label: "Text" },
];

/** Whether a field says anything: an empty list of addresses doesn't. */
function present(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

/** A field as it reads: an address, a list of them one a line, a dash when it says nothing. */
function said(value: unknown): unknown {
  return present(value) ? value : "—";
}

/** Who it went from and to and how it was sent; Cc only when it had any. */
function mailRows(attrs: Attrs): NameValue[] {
  const backend = String(said(attrs["mail.backend"])).replace(/^django\.core\.mail\.backends\./, "");
  const cc = present(attrs["mail.cc"]) ? [{ name: "Cc", value: attrs["mail.cc"] }] : [];
  return [
    { name: "From", value: said(attrs["mail.from"]) },
    { name: "To", value: said(attrs["mail.to"]) },
    ...cc,
    { name: "Backend", value: backend },
  ];
}

function Message({ span }: { span: Span }) {
  const attrs = span.attrs;
  const html = typeof attrs["mail.html"] === "string" ? attrs["mail.html"] : null;
  const text = typeof attrs["mail.body"] === "string" ? attrs["mail.body"] : null;
  const [view, setView] = useState<View>(html ? "html" : "text");
  const sent = attrs["mail.sent"];
  const failed = span.status === "error" || sent === 0;
  return (
    <article className="dt-mail" data-failed={failed ? "" : undefined}>
      <header className="dt-mail-head">
        <h3>{String(attrs["mail.subject"] || "(no subject)")}</h3>
        <Badge variant={failed ? "error" : "ok"} size="compact">
          {failed ? "Not sent" : "Sent"}
        </Badge>
        <span className="dt-mail-time">{duration(span.duration)}</span>
      </header>
      <NameValues rows={mailRows(attrs)} />
      {html || text ? (
        <>
          {html && text ? (
            <div className="dt-mail-switch">
              <Segmented label="Email as" segments={VIEWS} value={view} onChange={setView} />
            </div>
          ) : null}
          {view === "html" && html ? (
            // An empty sandbox: no scripts, no forms, no same-origin access for the email's markup.
            <iframe className="dt-mail-html" title="Email HTML" sandbox="" srcDoc={html} />
          ) : (
            <pre className="dt-mail-text">{text ?? ""}</pre>
          )}
        </>
      ) : (
        <p className="dt-note">The message body was not captured (TRACEPANEL capture_mail_body is off).</p>
      )}
    </article>
  );
}

/** Emails sent during the request, readable without a mailbox. */
export function MailList({ spans }: { spans: readonly Span[] }) {
  if (spans.length === 0) return <p className="dt-note">No emails were sent.</p>;
  return (
    <div className="dt-mails">
      {spans.map((span) => (
        <Message key={span.id} span={span} />
      ))}
    </div>
  );
}
