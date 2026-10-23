import {
  type App,
  type DataSource,
  Empty,
  type ExploreItem,
  type Related,
  type Trace,
  TraceView,
  type TraceViewProps,
} from "@tracepanel/ui";
import { type ReactNode, useEffect, useState } from "react";
import { useCapability } from "./hooks";
import { track, useRefresh } from "./refresh";
import { withShare } from "./ShareDialog";

/** A just-finished request may not be stored yet (the SDK writes in the background): retry briefly. */
const TRACE_RETRIES = 6;
const TRACE_RETRY_MS = 300;

export interface TraceScreenProps {
  id: string;
  source: DataSource;
  /** The Explore menu for the loaded trace. */
  explore?: ((trace: Trace) => ExploreItem[]) | undefined;
  onTabChange?: TraceViewProps["onTabChange"];
  variant?: "full" | "compact" | "strip" | undefined;
  initialTab?: TraceViewProps["initialTab"];
  preferredTab?: TraceViewProps["preferredTab"];
  actions?: TraceViewProps["actions"];
  /** In the panel, before the tabs: the way back to the trace this one was opened from. */
  lead?: TraceViewProps["lead"];
  /** Where linked traces, issues, statements and logs lead. */
  links?: TraceViewProps["links"];
  /** A span to open in the call tree. */
  initialSpan?: string | undefined;
  /** The way back when the trace is gone (the console's page); the panel has none to offer. */
  back?: ReactNode;
  /** A Share button, when the source can make a snapshot: the console's trace page. */
  shareable?: boolean | undefined;
  /** Called once the trace has loaded, or is known to be gone: a page around it shows with it. */
  onLoaded?: (() => void) | undefined;
}

// What each app said, as last loaded: the next trace of the same app opens with its App tab at once (the panel
// reopens the tab used last).
const told = new Map<string, App | null>();

/** What the app that served the trace said about itself, reloaded for each trace: the panel's App tab. */
function useApp(source: DataSource, service: string | null): App | null {
  const [, setLoaded] = useState(0);
  useEffect(() => {
    if (service === null || !source.app) return;
    let cancelled = false;
    const keep = (app: App | null) => {
      told.set(service, app);
      if (!cancelled) setLoaded((count) => count + 1);
    };
    source.app(service).then(keep, () => keep(null));
    return () => {
      cancelled = true;
    };
  }, [source, service]);
  return service === null ? null : (told.get(service) ?? null);
}

/** The service whose App tab the panel shows (its variants are compact and strip); none on a page. */
function serviceOf(trace: Trace | null | undefined, variant: TraceScreenProps["variant"]): string | null {
  const service = trace?.attrs["service.name"];
  const panel = variant === "compact" || variant === "strip";
  return panel && typeof service === "string" ? service : null;
}

/**
 * Traces linked to this one, reloaded while it is open (tasks a request enqueued finish later). Kept with the id
 * they are for: while the next trace loads, the one on screen doesn't get the next one's links.
 */
function useRelated(id: string, source: DataSource): (traceId: string) => Related | undefined {
  const [related, setRelated] = useState<{ id: string; related: Related } | undefined>(undefined);
  const { cycle, tick } = useRefresh();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` reloads on "refresh now", `cycle` on the clock.
  useEffect(() => {
    let cancelled = false;
    track(source.related(id)).then(
      (result) => !cancelled && setRelated({ id, related: result }),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [id, source, cycle, tick]);
  return (traceId) => (related?.id === traceId ? related.related : undefined);
}

/** Its queries' EXPLAIN, where the app behind the console runs it. */
function explainer(source: DataSource, traceId: string, explainable: boolean) {
  return explainable ? (span: string, analyze: boolean) => source.explain(traceId, span, analyze) : undefined;
}

/** The loading bar: on the page inset as the trace's head will be, across the panel. */
function TraceLoading({ variant }: { variant: TraceScreenProps["variant"] }) {
  return (
    <div className={variant === "full" ? "app-loading mx-4" : "app-loading"} role="status">
      <span className="sr-only">Loading</span>
    </div>
  );
}

/**
 * The trace, once loaded (null when it is gone), retried briefly while it may not be stored yet. The trace on screen
 * stays until the next one is loaded: following new requests swaps one for the other instead of blinking through an
 * empty pane.
 */
function useTrace(id: string, source: DataSource, onLoaded: (() => void) | undefined): Trace | null | undefined {
  const [trace, setTrace] = useState<Trace | null | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new `onLoaded` is no new trace to load.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const show = (result: Trace | null) => {
      setTrace(result);
      onLoaded?.();
    };
    const attempt = (left: number) => {
      source.getTrace(id).then(
        (result) => {
          if (cancelled) return;
          if (result === null && left > 0) timer = window.setTimeout(() => attempt(left - 1), TRACE_RETRY_MS);
          else show(result);
        },
        () => {
          if (!cancelled) show(null);
        },
      );
    };
    attempt(TRACE_RETRIES);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [id, source]);
  return trace;
}

export function TraceScreen({
  id,
  source,
  explore,
  onTabChange,
  variant,
  initialTab,
  preferredTab,
  actions,
  links,
  initialSpan,
  back,
  shareable,
  onLoaded,
  ...shown
}: TraceScreenProps) {
  const trace = useTrace(id, source, onLoaded);
  const related = useRelated(id, source);
  // The panel (compact, or docked as a strip) has an App tab: the console's trace page doesn't.
  const app = useApp(source, serviceOf(trace, variant));
  // EXPLAIN only where the app behind the console runs it.
  const explainable = useCapability(source, "explain");
  if (trace === undefined) return <TraceLoading variant={variant} />;
  if (trace === null) {
    return (
      <Empty title="Trace not found" action={back}>
        It is no longer in the local store: older traces are removed as new ones arrive, and the store starts fresh
        after a Tracepanel upgrade.
      </Empty>
    );
  }
  return (
    <TraceView
      key={trace.id}
      trace={trace}
      explore={explore?.(trace)}
      onTabChange={onTabChange}
      onExplain={explainer(source, trace.id, explainable)}
      initialTab={initialTab}
      preferredTab={preferredTab}
      actions={withShare(trace, source, actions, shareable === true)}
      {...shown}
      related={related(trace.id)}
      links={links}
      initialSpan={initialSpan}
      variant={variant}
      app={app}
    />
  );
}
