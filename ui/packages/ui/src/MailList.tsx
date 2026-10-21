import { useState } from "react";
import { Badge } from "./components/ui/badge";
import { duration } from "./format";
import type { Span } from "./types";

function addresses(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join(", ") : value ? String(value) : "—";
}

function Message({ span }: { span: Span }) {
  const attrs = span.attrs;
  const html = typeof attrs["mail.html"] === "string" ? attrs["mail.html"] : null;
  const text = typeof attrs["mail.body"] === "string" ? attrs["mail.body"] : null;
  const [view, setView] = useState<"html" | "text">(html ? "html" : "text");
  const sent = attrs["mail.sent"];
  const failed = span.status === "error" || sent === 0;
  const cc = addresses(attrs["mail.cc"]);
  const rows: [string, string][] = [
    ["From", String(attrs["mail.from"] ?? "—")],
    ["To", addresses(attrs["mail.to"])],
    ...(cc !== "—" && cc !== "" ? ([["Cc", cc]] as [string, string][]) : []),
    ["Backend", String(attrs["mail.backend"] ?? "—").replace(/^django\.core\.mail\.backends\./, "")],
  ];
  return (
    <article className="dt-mail" data-failed={failed ? "" : undefined}>
      <header className="dt-mail-head">
        <h3>{String(attrs["mail.subject"] || "(no subject)")}</h3>
        <Badge variant={failed ? "error" : "ok"} size="compact">
          {failed ? "Not sent" : "Sent"}
        </Badge>
        <span className="dt-mail-time">{duration(span.duration)}</span>
      </header>
      <dl className="dt-props dt-mail-props">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {html || text ? (
        <>
          {html && text ? (
            <div className="dt-segmented dt-mail-switch">
              <button type="button" aria-pressed={view === "html"} onClick={() => setView("html")}>
                HTML
              </button>
              <button type="button" aria-pressed={view === "text"} onClick={() => setView("text")}>
                Text
              </button>
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
