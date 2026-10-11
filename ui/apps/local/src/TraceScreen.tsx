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
import { track, useRefresh } from "./refresh";

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
}: TraceScreenProps) {
  const [trace, setTrace] = useState<Trace | null | undefined>(undefined);
  const [related, setRelated] = useState<Related | undefined>(undefined);
  const { cycle, tick } = useRefresh();
  // Tasks a request enqueued finish later: keep looking while the trace is open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` reloads on "refresh now", `cycle` on the clock.
  useEffect(() => {
    let cancelled = false;
    track(source.related(id)).then(
      (result) => !cancelled && setRelated(result),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [id, source, cycle, tick]);
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    // The trace on screen stays until the next one is loaded: following new requests swaps one for the other
    // instead of blinking through an empty pane.
    const attempt = (left: number) => {
      source.getTrace(id).then(
        (result) => {
          if (cancelled) return;
          if (result === null && left > 0) timer = window.setTimeout(() => attempt(left - 1), TRACE_RETRY_MS);
          else setTrace(result);
        },
        () => {
          if (!cancelled) setTrace(null);
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
      onExplain={(span, analyze) => source.explain(trace.id, span, analyze)}
      initialTab={initialTab}
      preferredTab={preferredTab}
      actions={actions}
      related={related}
      links={links}
      initialSpan={initialSpan}
      variant={variant}
    />
  );
}
