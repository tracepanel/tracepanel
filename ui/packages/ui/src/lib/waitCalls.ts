// What a profile's calls and waits are named: a call by what it is ("SQL snowflake", "HTTP GET
// analytics.example.com"), a wait by what it waited for ("waiting · sleep"). A profile's calls are shares of their
// own (lib/timeShares). Plain data, no React.
import type { Span } from "../types";
import { type Frame, WAITING } from "./profile";

/** A wait named by what was in flight: the calls it waited for, by their span ids (the call tree opens there). */
export type WaitFrame = Frame & { calls?: readonly string[] };

/** What a wait with no call in flight says: the frame that waited ("sleep"), else that no call was. */
const NO_CALL = `${WAITING} (no call)`;

function text(attrs: Span["attrs"], key: string): string | null {
  const value = attrs[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Where an HTTP call went: its host, as the call tree names it. */
function hostOf(span: Span): string | null {
  const full = text(span.attrs, "url.full") ?? text(span.attrs, "http.url");
  if (full) {
    try {
      return new URL(full).hostname;
    } catch {
      // Not a URL: its address below.
    }
  }
  return text(span.attrs, "server.address") ?? text(span.attrs, "net.peer.name");
}

/** What a call is, in a wait's name: "SQL snowflake", "HTTP GET analytics.example.com", "redis". */
export function callLabel(span: Span): string {
  const system =
    text(span.attrs, "db.system") ??
    text(span.attrs, "db.vendor") ??
    text(span.attrs, "messaging.system") ??
    text(span.attrs, "rpc.system");
  if (span.kind === "sql") return ["SQL", system].filter(Boolean).join(" ");
  if (span.kind === "http.client") {
    const method = text(span.attrs, "http.request.method") ?? text(span.attrs, "http.method");
    return ["HTTP", method, hostOf(span)].filter(Boolean).join(" ");
  }
  return system && system !== span.kind ? `${span.kind} ${system}` : span.kind;
}

/** A wait's frame: hatched as every wait (`waiting`), named by what it waited for. */
export function waitFrame(label: string | null, calls: readonly string[] = []): WaitFrame {
  return {
    function: label ? `${WAITING} · ${label}` : NO_CALL,
    module: null,
    file: "",
    line: 0,
    // biome-ignore lint/style/useNamingConvention: a frame as the SDKs send it.
    in_app: false,
    waiting: true,
    ...(calls.length ? { calls } : {}),
  };
}
