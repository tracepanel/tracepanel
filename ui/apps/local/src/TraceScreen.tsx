import {
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
}: TraceScreenProps) {
  const [trace, setTrace] = useState<Trace | null | undefined>(undefined);
  const related = useRelated(id, source);
  // EXPLAIN only where the app behind the console runs it.
  const explainable = useCapability(source, "explain");
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new `onLoaded` is no new trace to load.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    // The trace on screen stays until the next one is loaded: following new requests swaps one for the other
    // instead of blinking through an empty pane.
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
  if (trace === undefined) {
    return (
      <div className="app-loading" role="status">
        <span className="sr-only">Loading</span>
      </div>
    );
  }
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
      related={related(trace.id)}
      links={links}
      initialSpan={initialSpan}
      variant={variant}
    />
  );
}
