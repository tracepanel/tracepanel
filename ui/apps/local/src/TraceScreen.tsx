import {
  type App,
  type DataSource,
  Empty,
  type ExploreItem,
  type Related,
  Skeleton,
  type Trace,
  TraceView,
  type TraceViewProps,
} from "@tracepanel/ui";
import { cn } from "@tracepanel/ui/lib/utils";
import { HourglassIcon, SearchXIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useCapability } from "./hooks";
import { track, useRefresh } from "./refresh";
import { withShare } from "./ShareDialog";

/** A just-finished request may not be stored yet (the SDK writes in the background): retry briefly. */
const TRACE_RETRIES = 6;
/** On the console's page, opened from a list or a link: a trace that isn't stored says so after one more look. */
const PAGE_RETRIES = 1;
const TRACE_RETRY_MS = 300;
/**
 * How long a trace may be on its way: a view or an action in the browser goes out once it ends (15 s at the longest),
 * a request once the SDK wrote it. Until then a trace that isn't stored is arriving, asked for again and again, less
 * often as it takes longer.
 */
export const ARRIVING_MS = 60_000;
const ARRIVING_RETRY_MS = 3000;
const ULID_TIME = 10;
// An app's clock a little ahead of the browser's.
const CLOCK_SKEW_MS = 10_000;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** When a trace started, by its id (a ULID: its first ten characters are the time, in ms); null for another id. */
function startedAt(id: string): number | null {
  let ms = 0;
  for (const char of id.slice(0, ULID_TIME)) {
    const value = CROCKFORD.indexOf(char);
    if (value === -1) return null;
    ms = ms * 32 + value;
  }
  return id.length === 26 ? ms : null;
}

/** Whether a trace that isn't stored may still arrive: it started a moment ago, by its id (not in the future). */
function recent(id: string): boolean {
  const started = startedAt(id);
  if (started === null) return false;
  const age = Date.now() - started;
  return age > -CLOCK_SKEW_MS && age < ARRIVING_MS;
}

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
  /** The part of the time picked in the call tree, and where it goes as it changes. */
  initialSlice?: TraceViewProps["initialSlice"];
  onSliceChange?: TraceViewProps["onSliceChange"];
  /** The way back when the trace is gone (the console's page); the panel has none to offer. */
  back?: ReactNode;
  /** A Share button, when the source can make a snapshot: the console's trace page. */
  shareable?: boolean | undefined;
  /** Called once the trace has loaded, with it (null when it isn't stored). */
  onLoaded?: ((trace: Trace | null) => void) | undefined;
  /**
   * Whether the trace is known to be on its way (the panel lists it; the agent hasn't stored it yet): it shows as
   * arriving and loads once it is stored. Unset: as its id says, a trace that started a moment ago may still arrive.
   */
  arriving?: boolean | undefined;
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

const loaders = new WeakMap<DataSource, (traceId: string) => Promise<Related>>();

/** Another trace's links, for the call tree to open the chain of calls: one function per source, so it keeps still. */
function relatedLoader(source: DataSource): (traceId: string) => Promise<Related> {
  let load = loaders.get(source);
  if (!load) {
    load = (traceId) => source.related(traceId);
    loaders.set(source, load);
  }
  return load;
}

/** Its queries' EXPLAIN, where the app behind the console runs it. */
function explainer(source: DataSource, traceId: string, explainable: boolean) {
  return explainable ? (span: string, analyze: boolean) => source.explain(traceId, span, analyze) : undefined;
}

/** The loading bar: on the page inset as the trace's head will be, across the panel. */
function TraceLoading({ variant }: { variant: TraceScreenProps["variant"] }) {
  // The trace's shape while it loads: its name, its tabs and the first rows where they will be, not a blank pane.
  return (
    <div className={cn("grid gap-5", variant === "full" ? "mx-4 pt-1" : "p-4")} role="status" aria-busy="true">
      <span className="sr-only">Loading</span>
      <div className="flex items-center gap-3">
        <Skeleton width="2.75rem" height="1.25rem" />
        <Skeleton width="18rem" height="1.75rem" />
        <Skeleton width="3rem" />
      </div>
      <div className="flex gap-6 border-b pb-2.5">
        {["6rem", "5.5rem", "4.5rem"].map((width) => (
          <Skeleton key={width} width={width} height="1.125rem" />
        ))}
      </div>
      <div className="grid gap-3.5">
        {["60%", "45%", "70%", "35%"].map((width) => (
          <Skeleton key={width} width={width} />
        ))}
      </div>
    </div>
  );
}

/** What the screen shows for a trace: it, null when it is gone, "arriving" while it is on its way. */
type Loaded = Trace | null | "arriving";

function isTrace(value: Loaded | undefined): value is Trace {
  return value !== undefined && value !== null && value !== "arriving";
}

function traceOf(value: Loaded | undefined): Trace | null {
  return isTrace(value) ? value : null;
}

interface Loading {
  id: string;
  source: DataSource;
  /** Quick looks left before it is gone, or on its way. */
  retries: number;
  /** Whether it may still arrive, asked after the quick looks. */
  onItsWay: () => boolean;
  show: (value: Loaded) => void;
}

/**
 * Loads a trace: retried briefly while it may not be stored yet, then, while it is on its way, less and less often
 * until it is stored. Returns the way to stop.
 */
function loadTrace({ id, source, retries, onItsWay, show }: Loading): () => void {
  let cancelled = false;
  let timer: number | undefined;
  const later = (then: () => void, ms: number) => {
    timer = window.setTimeout(then, ms);
  };
  const missing = (left: number, delay: number) => {
    if (left > 0) return later(() => attempt(left - 1, delay), TRACE_RETRY_MS);
    if (!onItsWay()) return show(null);
    show("arriving");
    later(() => attempt(0, Math.min(delay * 1.5, ARRIVING_RETRY_MS)), delay);
  };
  const attempt = (left: number, delay: number) => {
    source.getTrace(id).then(
      (result) => {
        if (cancelled) return;
        if (result === null) missing(left, delay);
        else show(result);
      },
      () => !cancelled && show(null),
    );
  };
  attempt(retries, TRACE_RETRY_MS);
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
  };
}

/**
 * The trace, once loaded (null when it is gone), retried briefly while it may not be stored yet, and for as long as
 * it is on its way (`arriving`): it shows the moment it is stored. The trace on screen stays until the next one is
 * loaded: following new requests swaps one for the other instead of blinking through an empty pane.
 */
function useTrace(
  id: string,
  source: DataSource,
  onLoaded: ((trace: Trace | null) => void) | undefined,
  variant: TraceScreenProps["variant"],
  arriving: boolean | undefined,
): Loaded | undefined {
  const [loaded, setLoaded] = useState<{ id: string; value: Loaded } | undefined>(undefined);
  const waiting = useRef(arriving);
  waiting.current = arriving;
  // Stored at last, as the list says: asked for again at once.
  const known = arriving === false;
  const have = holds(loaded, id);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new `onLoaded` is no new trace to load.
  useEffect(() => {
    // Loaded already: the list catching up with the store is no reason to load it again.
    if (have) return;
    return loadTrace({
      id,
      source,
      retries: retriesFor(variant),
      onItsWay: () => waiting.current ?? recent(id),
      show: (value) => {
        setLoaded({ id, value });
        if (value !== "arriving") onLoaded?.(value);
      },
    });
  }, [id, source, variant, known]);
  return shownFor(loaded, id);
}

/** The panel follows requests as they happen, before the agent may have stored them; the page doesn't. */
function retriesFor(variant: TraceScreenProps["variant"]): number {
  return variant === "full" ? PAGE_RETRIES : TRACE_RETRIES;
}

/** Whether the trace `id` is loaded. */
function holds(loaded: { id: string; value: Loaded } | undefined, id: string): boolean {
  return loaded?.id === id && isTrace(loaded.value);
}

/**
 * What the screen shows while it is asked for `id`: what came of it, else the trace before it, which stays on screen
 * while this one loads (that one gone or arriving says nothing of this one).
 */
function shownFor(loaded: { id: string; value: Loaded } | undefined, id: string): Loaded | undefined {
  if (!loaded) return undefined;
  if (loaded.id === id) return loaded.value;
  return traceOf(loaded.value) ?? undefined;
}

/** The trace pane while there is no trace to show: loading, on its way, or gone. */
function NoTrace({
  loaded,
  variant,
  back,
}: {
  loaded: Loaded | undefined;
  variant: TraceScreenProps["variant"];
  back: ReactNode;
}) {
  if (loaded === undefined) return <TraceLoading variant={variant} />;
  if (loaded === "arriving") return <TraceArriving variant={variant} />;
  return (
    <Empty title="Trace not found" action={back} icon={SearchXIcon} page={true}>
      It is no longer in the local store: older traces are removed as new ones arrive, and the store starts fresh after
      a Tracepanel upgrade.
    </Empty>
  );
}

/** A trace the list has and the agent hasn't stored yet: it opens here as it arrives. */
function TraceArriving({ variant }: { variant: TraceScreenProps["variant"] }) {
  return (
    <div className={cn("grid", variant === "full" ? "" : "h-full")} role="status" aria-busy="true">
      <Empty title="Trace on its way" icon={HourglassIcon} page={true}>
        The agent hasn't stored it yet: a view or an action in the browser is sent once it ends, a request once its app
        has written it. It opens here as it arrives.
      </Empty>
    </div>
  );
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
  arriving,
  ...shown
}: TraceScreenProps) {
  const loaded = useTrace(id, source, onLoaded, variant, arriving);
  const trace = traceOf(loaded);
  const related = useRelated(id, source);
  // The panel (compact, or docked as a strip) has an App tab: the console's trace page doesn't.
  const app = useApp(source, serviceOf(trace, variant));
  // EXPLAIN only where the app behind the console runs it.
  const explainable = useCapability(source, "explain");
  if (trace === null) return <NoTrace loaded={loaded} variant={variant} back={back} />;
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
      loadRelated={relatedLoader(source)}
      links={links}
      initialSpan={initialSpan}
      variant={variant}
      app={app}
    />
  );
}
