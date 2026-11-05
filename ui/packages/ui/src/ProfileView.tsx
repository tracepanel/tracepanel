import {
  type MouseEvent,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { HiddenColumns } from "./DataTable";
import { bytes, duration } from "./format";
import type { TraceScope } from "./hooks/useTraceChain";
import {
  type AppProfile,
  appProfiles,
  type MemoryOf,
  memorySums,
  mergeMemories,
  mergeProfiles,
  mostTimeIn,
  type ScopedProfile,
  scopedProfiles,
} from "./lib/chainProfile";
import { type Memory, memoryProfile, type SitePlace, sitePlaces } from "./lib/memory";
import { percent, percents } from "./lib/percent";
import { plural } from "./lib/plural";
import {
  allFrames,
  type Box,
  FRAMEWORK,
  type Frame,
  functions,
  layout,
  mostlyYours,
  type Node,
  ownCode,
  type Profile,
  packageOf,
  packageTimes,
  profileReason,
  shareFrame,
  summaryOf,
  tree,
  WAITING,
  YOUR_CODE,
} from "./lib/profile";
import { serviceRuntime, traceRuntime } from "./lib/runtime";
import type { Windows } from "./lib/slice";
import { appSplit, ofWhat, type SaidShare, type Split, shareIn, splitOf } from "./lib/split";
import { type Readable, splitByProfile } from "./lib/timeShares";
import { cn } from "./lib/utils";
import { useRemembered, VIEW_KEYS } from "./lib/viewMemory";
import type { WaitFrame } from "./lib/waitCalls";
import { timed } from "./lib/waiting";
import { rawWindowProfile, sayProfile, windowProfile } from "./lib/windowProfile";
import { litKey, litScope } from "./lit";
import { AppChip } from "./primitives";
import { ScopeHeader } from "./ScopeBar";
import { Segmented } from "./Segmented";
import { largestFirst, ShareBar, ShareFace } from "./Shares";
import { HEAD_TEXT } from "./TableColumns";
import { useHeldSlice } from "./TimeSlice";
import type { Trace } from "./types";

/** A package's color: a fill for boxes, a solid one for dots and bars. Your code is the brand's; the rest in order. */
interface Tone {
  fill: string;
  dot: string;
  /** The bar's segment, lit: its ring in the dot's colour, solid. */
  lit: string;
}

const PALETTE: readonly Tone[] = [
  { fill: "bg-sky-500/30 hover:bg-sky-500/50", dot: "bg-sky-500", lit: "[--dt-lit:var(--color-sky-500)]" },
  {
    fill: "bg-emerald-500/30 hover:bg-emerald-500/50",
    dot: "bg-emerald-500",
    lit: "[--dt-lit:var(--color-emerald-500)]",
  },
  { fill: "bg-amber-500/30 hover:bg-amber-500/50", dot: "bg-amber-500", lit: "[--dt-lit:var(--color-amber-500)]" },
  { fill: "bg-rose-500/30 hover:bg-rose-500/50", dot: "bg-rose-500", lit: "[--dt-lit:var(--color-rose-500)]" },
  { fill: "bg-cyan-500/30 hover:bg-cyan-500/50", dot: "bg-cyan-500", lit: "[--dt-lit:var(--color-cyan-500)]" },
  { fill: "bg-orange-500/30 hover:bg-orange-500/50", dot: "bg-orange-500", lit: "[--dt-lit:var(--color-orange-500)]" },
];
const YOURS: Tone = { fill: "bg-brand/40 hover:bg-brand/60", dot: "bg-brand", lit: "[--dt-lit:var(--color-brand)]" };
// Waiting is no package's time: neutral, hatched, as the time strip draws it.
const WAITS: Tone = {
  fill: "dt-hatched bg-muted-foreground/15 hover:bg-muted-foreground/25",
  dot: "dt-hatched bg-muted-foreground/50",
  lit: "[--dt-lit:var(--color-muted-foreground)]",
};
const REST: Tone = {
  fill: "bg-muted-foreground/20 hover:bg-muted-foreground/30",
  dot: "bg-muted-foreground/50",
  lit: "[--dt-lit:var(--color-muted-foreground)]",
};

/**
 * A share of the trace's time that no package is (a call's, the collector's, the framework's: lib/timeShares), in
 * its category's colour, as the time strip and the call tree draw it.
 */
const SHARE_TONES: Readonly<Record<string, Tone>> = {
  sql: {
    fill: "[--dt-k:var(--dt-k-sql)] bg-(--dt-k)/35 hover:bg-(--dt-k)/55",
    dot: "[--dt-k:var(--dt-k-sql)] bg-(--dt-k)",
    lit: "[--dt-lit:var(--dt-k-sql)]",
  },
  cache: {
    fill: "[--dt-k:var(--dt-k-cache)] bg-(--dt-k)/35 hover:bg-(--dt-k)/55",
    dot: "[--dt-k:var(--dt-k-cache)] bg-(--dt-k)",
    lit: "[--dt-lit:var(--dt-k-cache)]",
  },
  redis: {
    fill: "[--dt-k:var(--dt-k-redis)] bg-(--dt-k)/35 hover:bg-(--dt-k)/55",
    dot: "[--dt-k:var(--dt-k-redis)] bg-(--dt-k)",
    lit: "[--dt-lit:var(--dt-k-redis)]",
  },
  http: {
    fill: "[--dt-k:var(--dt-k-http)] bg-(--dt-k)/35 hover:bg-(--dt-k)/55",
    dot: "[--dt-k:var(--dt-k-http)] bg-(--dt-k)",
    lit: "[--dt-lit:var(--dt-k-http)]",
  },
  datastore: {
    fill: "[--dt-k:var(--dt-k-datastore)] bg-(--dt-k)/35 hover:bg-(--dt-k)/55",
    dot: "[--dt-k:var(--dt-k-datastore)] bg-(--dt-k)",
    lit: "[--dt-lit:var(--dt-k-datastore)]",
  },
  messaging: {
    fill: "[--dt-k:var(--dt-k-messaging)] bg-(--dt-k)/35 hover:bg-(--dt-k)/55",
    dot: "[--dt-k:var(--dt-k-messaging)] bg-(--dt-k)",
    lit: "[--dt-lit:var(--dt-k-messaging)]",
  },
  storage: {
    fill: "[--dt-k:var(--dt-k-storage)] bg-(--dt-k)/35 hover:bg-(--dt-k)/55",
    dot: "[--dt-k:var(--dt-k-storage)] bg-(--dt-k)",
    lit: "[--dt-lit:var(--dt-k-storage)]",
  },
  llm: {
    fill: "[--dt-k:var(--dt-k-llm)] bg-(--dt-k)/35 hover:bg-(--dt-k)/55",
    dot: "[--dt-k:var(--dt-k-llm)] bg-(--dt-k)",
    lit: "[--dt-lit:var(--dt-k-llm)]",
  },
  mail: {
    fill: "[--dt-k:var(--dt-k-mail)] bg-(--dt-k)/35 hover:bg-(--dt-k)/55",
    dot: "[--dt-k:var(--dt-k-mail)] bg-(--dt-k)",
    lit: "[--dt-lit:var(--dt-k-mail)]",
  },
  template: {
    fill: "[--dt-k:var(--dt-k-template)] bg-(--dt-k)/35 hover:bg-(--dt-k)/55",
    dot: "[--dt-k:var(--dt-k-template)] bg-(--dt-k)",
    lit: "[--dt-lit:var(--dt-k-template)]",
  },
  signal: {
    fill: "[--dt-k:var(--dt-k-signal)] bg-(--dt-k)/35 hover:bg-(--dt-k)/55",
    dot: "[--dt-k:var(--dt-k-signal)] bg-(--dt-k)",
    lit: "[--dt-lit:var(--dt-k-signal)]",
  },
  django: {
    fill: "[--dt-k:var(--dt-k-django)] bg-(--dt-k)/35 hover:bg-(--dt-k)/55",
    dot: "[--dt-k:var(--dt-k-django)] bg-(--dt-k)",
    lit: "[--dt-lit:var(--dt-k-django)]",
  },
  unprofiled: {
    fill: "[--dt-k:var(--dt-k-unprofiled)] bg-(--dt-k) hover:bg-muted-foreground/25",
    dot: "[--dt-k:var(--dt-k-unprofiled)] bg-(--dt-k)",
    lit: "[--dt-lit:var(--color-muted-foreground)]",
  },
  gc: {
    fill: "[--dt-k:var(--dt-k-gc)] bg-(--dt-k)/35 hover:bg-(--dt-k)/55",
    dot: "[--dt-k:var(--dt-k-gc)] bg-(--dt-k)",
    lit: "[--dt-lit:var(--dt-k-gc)]",
  },
};

type Palette = Map<string, Tone>;
type Share = { name: string; samples: number };

/** The shares that aren't a package: your code, the framework and the runtime around it, waiting. */
const KINDS_OF_TIME = new Set([YOUR_CODE, FRAMEWORK, WAITING]);

/**
 * Your code, then the packages that took most, one color each; the rest share one gray as "other". The framework
 * and the runtime around your code (Your code's one share for them) are that gray too, by their own name.
 */
function colors(names: readonly string[], shares: ReadonlyMap<string, string> = new Map()): Palette {
  const others = names.filter((name) => !(KINDS_OF_TIME.has(name) || shares.has(name))).slice(0, PALETTE.length);
  return new Map([
    [YOUR_CODE, YOURS],
    [FRAMEWORK, REST],
    [WAITING, WAITS],
    ...[...shares].map(([name, category]): [string, Tone] => [name, SHARE_TONES[category] ?? REST]),
    ...others.map((name, at): [string, Tone] => [name, PALETTE[at] ?? REST]),
  ]);
}

/** The shares of the trace's time a profile's frames stand for (ShareFrame), by name, with their category. */
function sharesIn(profile: Profile): Map<string, string> {
  const shares = new Map<string, string>();
  for (const frame of profile.frames) {
    const share = shareFrame(frame);
    if (share) shares.set(share.share, share.category);
  }
  return shares;
}

function toneOf(palette: Palette, name: string): Tone {
  return palette.get(name) ?? REST;
}

/** A package as the legend names it: itself when it has a color, "other" when it is folded in with the rest. */
function colored(palette: Palette, name: string): string {
  return palette.has(name) ? name : "other";
}

/** Faded while some packages are lit and this one isn't. */
function faded(lit: ReadonlySet<string>, name: string): boolean {
  return lit.size > 0 && !lit.has(name);
}

/** The lit packages with this one switched. */
function toggled(lit: ReadonlySet<string>, name: string): ReadonlySet<string> {
  const next = new Set(lit);
  if (!next.delete(name)) next.add(name);
  return next;
}

function where(frame: Frame): string {
  return frame.file ? `${frame.file}:${frame.line}` : "";
}

const ROW = 20;

/** The head of a list under the flame graph: one box with its header in it, as every table's. */
const LIST_HEAD = cn(
  "grid h-10 grid-cols-[minmax(0,1fr)_5rem_4.5rem] items-center gap-3 bg-(--dt-table-head) px-3 shadow-[inset_0_-1px_0_var(--dt-table-head-rule)] light:h-[2.125rem]",
  HEAD_TEXT,
);
/** A box narrower than this keeps its color but drops its name. */
const LABELLED = 0.035;

/** How much a box, a share or a row stands for, said: a time ("60 ms"), or bytes ("30 MB"). */
type Measure = (amount: number) => string;

const FRAMES = [
  { id: "own", label: "Your code" },
  { id: "all", label: "All frames" },
] as const;

type Kind = "time" | "memory";

// The view remembers Memory only: Time is where the tab opens.
const readKind = (value: string): Kind | undefined => (value === "memory" ? "memory" : undefined);
const writeKind = (kind: Kind): string | undefined => (kind === "memory" ? "memory" : undefined);

/** Time or Memory, as the view remembers it: Back to the Profile tab shows the same. */
function useKind(): [Kind, (kind: Kind) => void] {
  return useRemembered<Kind>(VIEW_KEYS.profileKind, "time", readKind, writeKind);
}

const readFrames = (value: string): boolean | undefined =>
  value === "own" ? true : value === "all" ? false : undefined;
const writeFrames = (own: boolean): string => (own ? "own" : "all");

/** Your code or All frames, one setting for Time and Memory: at first, your code where its time is mostly yours. */
interface Frames {
  own: boolean;
  onOwn: (own: boolean) => void;
}

/** Your code or All frames, as the view remembers it; at first, your code where the time profile is mostly yours. */
function useFrames(time: Profile): Frames {
  const [own, onOwn] = useRemembered(VIEW_KEYS.frames, () => mostlyYours(time), readFrames, writeFrames);
  return { own, onOwn };
}

const KINDS = [
  { id: "time", label: "Time" },
  { id: "memory", label: "Memory" },
] as const;

/** The Profile tab's content, when it is the tab open and the trace has a profile: its time, or its memory. */
function ProfilePane({
  trace,
  open,
  onShowRow,
}: {
  trace: Trace;
  open: boolean;
  onShowRow?: ((row: string) => void) | undefined;
}) {
  const range = useProfileRange(open);
  const [kind, setKind] = useKind();
  // Kept while the trace and the range are: the flame graph's zoom belongs to the profile it was made in.
  const scope = useMemo(() => (trace.profile ? scopeOf(trace, trace.profile, range) : null), [trace, range]);
  if (!(open && trace.profile && scope)) return null;
  return (
    <ProfileOf trace={trace} profile={trace.profile} scope={scope} kind={kind} onKind={setKind} onShowRow={onShowRow} />
  );
}

/** The profile's time, or, where it measured its memory and that is the choice, its memory. */
function ProfileOf({
  trace,
  profile,
  scope,
  kind,
  onKind,
  onShowRow,
}: {
  trace: Trace;
  profile: Profile;
  scope: Scope;
  kind: Kind;
  onKind: (kind: Kind) => void;
  onShowRow?: ((row: string) => void) | undefined;
}) {
  const memory = profile.memory;
  // One choice for both: Memory keeps what Time had, and back.
  const frames = useFrames(profile);
  // Only a profile that measured its memory has the choice.
  const kinds = memory ? <Segmented label="Profile of" segments={KINDS} value={kind} onChange={onKind} /> : null;
  if (memory && kind === "memory") {
    const what = { ...WHOLE_TRACE, reason: profileReason(trace), sampled: sampledSites(trace.attrs) };
    const head = <MemoryHead memory={memory} what={what} />;
    return <MemoryPane profile={profile} memory={memory} kinds={kinds} head={head} frames={frames} />;
  }
  return (
    <ProfileView
      key={scope.title}
      profile={scope.profile}
      own={scope.own}
      frames={frames}
      measure={(samples) => duration(samples * scope.profile.interval_us)}
      noun="Time"
      kinds={kinds}
      head={<ProfileHead whole={profile} trace={trace} scope={scope} />}
      split={scope.split}
      list={({ view, palette, measure }) => (
        <Functions rows={functions(view)} limit={30} palette={palette} time={measure} onShowRow={onShowRow} />
      )}
    />
  );
}

/** Where the trace's memory was: its allocation sites read as the time is, by package and as a flame of bytes. */
function MemoryPane({
  profile,
  memory,
  kinds,
  frames,
  head = <MemoryHead memory={memory} />,
}: {
  profile: Profile;
  memory: Memory;
  kinds: ReactNode;
  frames: Frames;
  head?: ReactNode;
}) {
  const sites = useMemo(() => memoryProfile(profile, memory), [profile, memory]);
  if (sites.samples === 0) {
    return (
      <div className="grid gap-6 p-4">
        <header className="flex flex-wrap items-end justify-between gap-3">
          {head}
          {kinds}
        </header>
        <p className="text-sm text-muted-foreground">No allocation sites were recorded.</p>
      </div>
    );
  }
  return (
    <ProfileView
      key="memory"
      profile={sites}
      frames={frames}
      measure={bytes}
      noun="Memory"
      kinds={kinds}
      head={head}
      list={({ view, palette }) =>
        frames.own ? (
          <OwnSites view={view} total={sites.samples} palette={palette} />
        ) : (
          <Sites profile={profile} memory={memory} total={sites.samples} palette={palette} />
        )
      }
    />
  );
}

/** "+1.2 MB": what a trace kept, its sign said. */
function signed(size: number): string {
  return size > 0 ? `+${bytes(size)}` : bytes(size);
}

/** What it kept and allocated in all: "net +1.2 MB · 90 MB allocated in all". */
function keptLine(memory: Memory): string {
  const kept = [`net ${signed(memory.net)}`];
  if (memory.allocated !== undefined) kept.push(`${bytes(memory.allocated)} allocated in all`);
  return kept.join(" · ");
}

/** Where the trace's memory was: of one trace, or of an app's several in a chain (their numbers added up). */
interface MemoryWhat {
  title: string;
  /** The app's chip, in a chain. */
  app?: ReactNode;
  traces: number;
  /** Why a stretch picked isn't what it shows. */
  note?: string | null;
  /** Why it was profiled ("Profiled: by the panel's cookie"), when its SDK says. */
  reason?: string | null;
  /** Its sites are samples, each standing for many bytes (Node's heap sampler): their bytes an estimate. */
  sampled?: boolean;
}

/** Node's sites are its heap sampler's: one allocation in about every 32 KB, each standing for that many bytes. */
function sampledSites(attrs: Trace["attrs"]): boolean {
  return attrs["telemetry.sdk.language"] === "nodejs";
}

/**
 * "The list: 25 KB held at the peak, by where it was allocated. Its shares are of these": what the sites add up to,
 * said apart from the peak, a different number (the peak is the level the memory reached; the sites, the largest
 * places what was held then was allocated in). None without sites.
 */
function sitesLine(memory: Memory, what: MemoryWhat): string | null {
  const held = (memory.sites ?? []).reduce((sum, site) => sum + Math.max(site.bytes, 0), 0);
  if (held === 0) return null;
  const end = what.traces > 1 ? "at the end of each trace" : "at the end of the trace";
  const when = memory.sites_at === "end" ? `still held ${end}, not at its peak` : "held at the peak";
  const amount = `${what.sampled ? "≈ " : ""}${bytes(held)}`;
  return `The list: ${amount} ${when}, by where it was allocated${what.sampled ? " (sampled)" : ""}. Its shares are of these`;
}

const WHOLE_TRACE: MemoryWhat = { title: "Memory of the whole trace", traces: 1 };

/**
 * What the trace allocated: its peak, what it kept and allocated in all, and what the numbers can't tell apart. Of
 * an app's traces in a chain: its chip, and of several, their numbers added up, the peak the largest.
 */
function MemoryHead({ memory, what = WHOLE_TRACE }: { memory: Memory; what?: MemoryWhat }) {
  const several = what.traces > 1;
  return (
    <div className="grid gap-0.5" data-memory-head="">
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        {what.app}
        {what.title}
      </span>
      <span className="text-2xl font-semibold tracking-tight tabular-nums">
        {bytes(memory.peak)}
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          {several ? "peak of one of them, above where it started" : "peak, above where it started"}
        </span>
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">{keptLine(memory)}</span>
      <NoteLine text={sitesLine(memory, what)} />
      <MemoryNotes memory={memory} what={what} />
    </div>
  );
}

/** What the numbers can't tell apart: a stretch they can't narrow, other traces counted. */
function MemoryNotes({ memory, what }: { memory: Memory; what: MemoryWhat }) {
  return (
    <>
      <NoteLine text={what.reason} />
      <NoteLine text={what.note} />
      {memory.shared ? (
        <span className="text-xs text-warn">Includes other traces that ran in the process meanwhile</span>
      ) : null}
    </>
  );
}

/** The stretches the tab was opened at (its own, gone once it closes), else the call tree's range. */
function useProfileRange(open: boolean): Windows | null {
  const { slice, stretch, profileAt } = useHeldSlice();
  useEffect(() => {
    if (!open) profileAt(null);
  }, [open, profileAt]);
  return useMemo(() => stretch ?? (slice.range ? [slice.range] : null), [stretch, slice.range]);
}

/** What the tab profiles: a stretch picked (when the profile says when its stacks were seen), else the whole trace. */
interface Scope {
  profile: Profile;
  /** What Your code reads: its waits named by what was in flight (lib/waitCalls); All frames keeps the frames. */
  own: Profile;
  /** Where its time went, as every view of it says it (lib/split): its bar, its head. */
  split: Split;
  title: string;
  /** Why a stretch picked isn't what it shows: the profile doesn't say when. */
  note: string | null;
}

/** A trace as its profile's scope reads it: its clock, its calls (who waited), its SDK's language. */
type Profiled = Pick<Trace, "start" | "duration" | "spans" | "attrs"> & { kind?: string; profile?: Profile };

function scopeOf(trace: Profiled, profile: Profile, range: Windows | null): Scope {
  const shared = trace.profile === profile ? trace : { ...trace, profile };
  // Timed (or with no samples, the spans saying it all), it reads in the trace's own time and shares, as the time
  // strip and the call tree do (lib/split): stretches narrow it to their time.
  if (splitByProfile(shared)) {
    const split = splitOf(shared, range);
    return {
      profile: windowProfile(shared, range),
      own: windowProfile(shared, range, true),
      split,
      title: `Profile of ${split.of}`,
      note: null,
    };
  }
  const split = splitOf(shared, null);
  const note = range ? "Its samples aren't timed: the range picked can't narrow it." : null;
  return { profile, own: profile, split, title: `Profile of ${split.of}`, note };
}

/** "≈ " before a time the profile estimates rather than counts. */
function about(profile: Profile): string {
  return profile.estimated_from === undefined ? "" : "≈ ";
}

/**
 * "103 ms profiled of the trace's 123 ms": what the profile covers of what it is of, as its split says them (the rest
 * its code's time it didn't sample, its bar's Not profiled).
 */
function coverLine(split: Split): string {
  return `profiled of ${ofWhat(split)}`;
}

/** "≈ 103 ms profiled of the trace's 123 ms": the head's big number, as the split says it. */
function SplitCover({ split, about: estimate }: { split: Split; about: string }) {
  return (
    <span className="text-2xl font-semibold tracking-tight tabular-nums" data-cover="">
      {estimate}
      {split.covered}
      <span className="ml-2 text-sm font-normal text-muted-foreground">{coverLine(split)}</span>
    </span>
  );
}

/** A line of the head in small print, when there is something to say. */
function NoteLine({ text }: { text: string | null | undefined }) {
  return text ? <span className="text-xs text-muted-foreground">{text}</span> : null;
}

/** Why the trace was profiled, when its SDK says: "Profiled: by the panel's cookie". */
function Reason({ trace }: { trace: Trace }) {
  return <NoteLine text={profileReason(trace)} />;
}

/** The time it couldn't sample (its thread ran other traces), and, timed, that the samples around it fill it in. */
function Dropped({ whole, timed: filled }: { whole: Profile; timed: boolean }) {
  if (!whole.dropped) return null;
  return (
    <span className="text-xs text-warn">
      {duration(whole.dropped * whole.interval_us)} not sampled: other traces ran on the same thread
      {filled ? ", filled in from the samples around it" : ""}
    </span>
  );
}

/**
 * What the profile covers: how long it sampled of the trace's time, and, where samples weren't taken (the trace's
 * thread ran other traces too), how long and why.
 */
function ProfileHead({ whole, trace, scope }: { whole: Profile; trace: Trace; scope: Scope }) {
  return (
    <div className="grid gap-0.5" data-split-head="">
      <span className="text-xs text-muted-foreground">{scope.title}</span>
      <SplitCover split={scope.split} about={about(whole)} />
      <span className="text-xs text-muted-foreground" data-sampled="">
        {scope.note ?? scope.split.sampled}
      </span>
      <Reason trace={trace} />
      <Dropped whole={whole} timed={timed(whole)} />
    </div>
  );
}

/** What the list under the flame graph is drawn from: the frames shown, the packages' colours, how much is said. */
interface Shown {
  view: Profile;
  palette: Palette;
  measure: Measure;
}

/**
 * Where the trace's time (or memory) went in code: by package, as a flame graph of your code or of every frame, then
 * a list (the functions by their time, the sites by their bytes).
 */
function ProfileView({
  profile,
  own: ownProfile,
  frames: { own, onOwn: setOwn },
  head,
  measure,
  noun,
  kinds,
  list,
  split,
}: {
  profile: Profile;
  /** What Your code reads, where it reads the profile otherwise (its waits named by what was in flight). */
  own?: Profile | undefined;
  /** Where its time went (lib/split): its bar says these shares, in either view. Memory's bar is by package. */
  split?: Split | undefined;
  frames: Frames;
  head: ReactNode;
  measure: Measure;
  noun: string;
  kinds: ReactNode;
  list: (shown: Shown) => ReactNode;
}) {
  const [lit, setLit] = useState<ReadonlySet<string>>(new Set());
  const view = useMemo(() => (own ? ownCode(ownProfile ?? profile) : allFrames(profile)), [profile, ownProfile, own]);
  // Your code's shares are its own and the framework's around it; every frame's, each package's.
  const packages = useMemo(() => packageTimes(view), [view]);
  const palette = useMemo(
    () =>
      colors(
        packages.map((item) => item.name),
        sharesIn(view),
      ),
    [packages, view],
  );
  return (
    <div className="@container grid gap-6 p-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        {head}
        <div className="flex flex-wrap items-center gap-2">
          {kinds}
          <Segmented
            label="Frames shown"
            segments={FRAMES}
            value={own ? "own" : "all"}
            onChange={(id) => {
              setOwn(id === "own");
              // The packages lit are the other view's.
              setLit(new Set());
            }}
          />
        </div>
      </header>
      <Packages
        noun={noun}
        parts={split ? splitParts(split) : packageParts(summed(packages, palette), palette, measure)}
        lit={lit}
        onLight={(name) => setLit(toggled(lit, name))}
        onClear={() => setLit(new Set())}
      />
      {/* Keyed: a zoom belongs to the frames it was made in. */}
      <Flame key={String(own)} profile={view} palette={palette} lit={lit} time={measure} />
      {list({ view, palette, measure })}
    </div>
  );
}

/** The colored packages, then everything else as one "other". */
function summed(packages: readonly Share[], palette: Palette): Share[] {
  const named = packages.filter((item) => palette.has(item.name));
  const other = packages.filter((item) => !palette.has(item.name)).reduce((sum, item) => sum + item.samples, 0);
  return other ? [...named, { name: "other", samples: other }] : named;
}

/**
 * A share's name in the bar's legend, as the time strip's legend says its shares: "Your code", "Waiting".
 */
function shareName(name: string): string {
  return KINDS_OF_TIME.has(name) ? `${name.charAt(0).toUpperCase()}${name.slice(1)}` : name;
}

/** Waiting after every package, the framework and the runtime before it, and the rest folded together before them. */
function rankOf(share: Share): number {
  if (share.name === WAITING) return 4;
  if (share.name === FRAMEWORK) return 2;
  return share.name === "other" ? 1 : 0;
}

/** One share on the bar and in its legend, said: its key (the flame's package it lights), name, amount, percent. */
interface BarShare {
  key: string;
  name: string;
  size: number;
  value: string;
  percent: string;
  tone: Tone;
}

/** The package a share's frames are in the flame graph (lib/profile's packageOf): what lighting it lights. */
function packageOfShare(share: SaidShare): string {
  if (share.share === "code") return YOUR_CODE;
  return share.share === WAITING ? WAITING : share.label;
}

/** A share's colour on the bar: Your code's, waiting's, else its category's, as the strip draws it. */
function shareTone(share: SaidShare): Tone {
  if (share.share === "code") return YOURS;
  if (share.share === WAITING) return WAITS;
  return SHARE_TONES[share.share] ?? REST;
}

/** A split's shares as the bar says them: what it says, in its order, nothing worked out again. */
function splitParts(split: Split): BarShare[] {
  return split.shares.map((share) => ({
    key: packageOfShare(share),
    name: share.label,
    size: share.us,
    value: share.time,
    percent: share.percent,
    tone: shareTone(share),
  }));
}

/** Memory's packages as the bar says them: largest first, percents of what they add up to. */
function packageParts(packages: readonly Share[], palette: Palette, measure: Measure): BarShare[] {
  const ordered = largestFirst(packages, (share) => share.samples, rankOf);
  const said = percents(
    ordered.map((share) => share.samples),
    ordered.reduce((sum, share) => sum + share.samples, 0),
  );
  return ordered.map(({ name, samples }, at) => ({
    key: name,
    name: shareName(name),
    size: samples,
    value: measure(samples),
    percent: said[at] ?? "0%",
    tone: toneOf(palette, name),
  }));
}

/** Where the time went by share (the memory by package): one bar of them, then their legend; a click lights frames. */
function Packages({
  noun,
  parts,
  lit,
  onLight,
  onClear,
}: {
  noun: string;
  parts: readonly BarShare[];
  lit: ReadonlySet<string>;
  onLight: (name: string) => void;
  onClear: () => void;
}) {
  const total = parts.reduce((sum, part) => sum + part.size, 0);
  const bar = parts.map((part) => ({
    key: part.key,
    size: part.size,
    className: cn(part.tone.dot, part.tone.lit),
    title: `${part.name}: ${part.value}`,
    faded: faded(lit, part.key),
  }));
  return (
    // A segment hovered lights its legend item, and the legend item its segment.
    <section className="grid gap-3" aria-label={`${noun} by package`} {...litScope}>
      <ShareBar parts={bar} total={total} />
      <ul className="dt-breakdown-legend">
        {parts.map((part) => (
          <li key={part.key}>
            <button
              type="button"
              className="dt-share"
              {...litKey(part.key, true)}
              aria-pressed={lit.has(part.key)}
              onClick={() => onLight(part.key)}
            >
              <ShareFace
                swatch={<span className={cn("dt-dot", part.tone.dot)} />}
                name={part.name}
                value={part.value}
                share={part.percent}
              />
            </button>
          </li>
        ))}
      </ul>
      {lit.size ? (
        <button type="button" className="justify-self-start px-2 text-xs text-brand hover:underline" onClick={onClear}>
          Show every package
        </button>
      ) : null}
    </section>
  );
}

/** The box under the pointer, and where the pointer is in the window (clientX, clientY). */
interface Hovered {
  node: Node;
  x: number;
  y: number;
}

/** A flame graph from the outermost call down: a click zooms in, a hover tells. */
function Flame({
  profile,
  palette,
  lit,
  time,
}: {
  profile: Profile;
  palette: Palette;
  lit: ReadonlySet<string>;
  time: Measure;
}) {
  const root = useMemo(() => tree(profile), [profile]);
  const [focus, setFocus] = useState<Node>(root);
  const boxes = useMemo(() => layout(focus), [focus]);
  const depth = Math.max(0, ...boxes.map((box) => box.depth)) + 1;
  const [hover, setHover] = useState<Hovered | null>(null);
  const track = (event: MouseEvent, node: Node) => setHover({ node, x: event.clientX, y: event.clientY });
  return (
    <section className="grid gap-2" aria-label="Flame graph">
      <div className="flex h-5 items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>Calls, outermost on top. Click one to zoom in.</span>
        {focus !== root ? (
          <button type="button" className="text-brand hover:underline" onClick={() => setFocus(root)}>
            Show all
          </button>
        ) : null}
      </div>
      <div className="relative max-h-[30rem] overflow-y-auto rounded-lg border bg-card p-1.5">
        <div className="relative w-full" style={{ height: depth * (ROW + 2) }} role="img" aria-label="Flame graph">
          {boxes.map((box) => (
            <FlameBox
              key={box.node.key}
              box={box}
              tone={toneOf(palette, box.node.frame ? packageOf(box.node.frame) : "")}
              faded={box.node.frame !== null && faded(lit, colored(palette, packageOf(box.node.frame)))}
              onZoom={() => {
                setFocus(box.node);
                setHover(null);
              }}
              onHover={(event) => track(event, box.node)}
              onLeave={() => setHover(null)}
            />
          ))}
        </div>
        {hover ? <Tip key={hover.node.key} hovered={hover} total={root.total} time={time} /> : null}
      </div>
    </section>
  );
}

/** Room kept between the tip and the pointer, and between the tip and the window's edges. */
const TIP_GAP = 18;
const TIP_EDGE = 8;

/**
 * Where the tip goes: below the pointer, else above it where it doesn't fit below (a box in the bottom rows), and
 * always inside the window.
 */
function tipPlace(x: number, y: number, size: { width: number; height: number }): { left: number; top: number } {
  const [width, height] = [window.innerWidth, window.innerHeight];
  const left = Math.min(Math.max(TIP_EDGE, x - 120), width - size.width - TIP_EDGE);
  const below = y + TIP_GAP;
  const top = below + size.height + TIP_EDGE <= height ? below : y - TIP_GAP - size.height;
  return { left: Math.max(TIP_EDGE, left), top: Math.min(Math.max(TIP_EDGE, top), height - size.height - TIP_EDGE) };
}

/**
 * What the box under the pointer is: its function, where it is, whole, and its time. Over the page, fixed where the
 * pointer is: the flame's card scrolls and clips what is inside it, so a tip of its bottom rows would be cut.
 */
function Tip({ hovered: { node, x, y }, total, time }: { hovered: Hovered; total: number; time: Measure }) {
  const tip = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  // Measured where the pointer moves: another box's tip is another Tip (keyed by its box), measured anew.
  useLayoutEffect(() => {
    const at = tip.current;
    if (at) setPlace(tipPlace(x, y, { width: at.offsetWidth, height: at.offsetHeight }));
  }, [x, y]);
  const frame = node.frame;
  if (!frame) return null;
  return createPortal(
    <div
      ref={tip}
      role="tooltip"
      className="pointer-events-none fixed z-50 grid w-max max-w-md gap-1 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg"
      style={place ?? { left: x, top: y + TIP_GAP, visibility: "hidden" }}
    >
      <span className="font-mono font-medium [overflow-wrap:anywhere]">{frame.function}</span>
      <span className="font-mono text-muted-foreground [overflow-wrap:anywhere]">{where(frame)}</span>
      <span className="tabular-nums">
        {time(node.total)} · {percent(node.total, total)} · {time(node.self)} in itself
      </span>
    </div>,
    document.body,
  );
}

function FlameBox({
  box: { node, depth, left, width },
  tone,
  faded,
  onZoom,
  onHover,
  onLeave,
}: {
  box: Box;
  tone: Tone;
  faded: boolean;
  onZoom: () => void;
  onHover: (event: MouseEvent) => void;
  onLeave: () => void;
}) {
  const frame = node.frame;
  if (!frame) return null;
  return (
    <button
      type="button"
      aria-label={`${frame.function} ${where(frame)}`}
      onClick={onZoom}
      onMouseMove={onHover}
      onMouseLeave={onLeave}
      className={cn(
        "absolute truncate rounded px-1.5 text-left font-mono text-[11px] text-foreground transition-opacity",
        tone.fill,
        faded && "opacity-25",
      )}
      style={{
        top: depth * (ROW + 2),
        left: `calc(${left * 100}% + 1px)`,
        width: `calc(${width * 100}% - 2px)`,
        height: ROW,
        lineHeight: `${ROW}px`,
      }}
    >
      {width >= LABELLED && frame.function}
    </button>
  );
}

type FunctionRow = { frame: Frame; self: number; total: number };

/** A list's rows: the functions, most first and `limit` of them, then the summaries apart (FRAMEWORK, WAITING). */
function apart<T extends { frame: Frame }>(rows: readonly T[], limit: number): { named: T[]; summaries: T[] } {
  const named = rows.filter((row) => summaryOf(row.frame) === null).slice(0, limit);
  const summaries = rows
    .filter((row) => summaryOf(row.frame) !== null)
    .sort((a, b) => summaryRank(a.frame) - summaryRank(b.frame));
  return { named, summaries };
}

/** The framework & runtime before waiting, as the bar has them. */
function summaryRank(frame: Frame): number {
  return summaryOf(frame) === WAITING ? 1 : 0;
}

/** A list row's grid, as its head's: the name, then two numbers. */
const LIST_ROW = "grid grid-cols-[minmax(0,1fr)_5rem_4.5rem] items-center gap-3 px-3 py-1.5";

/**
 * The functions by the time they ran themselves: each with where it is, whole, and a bar of its share; under them,
 * apart, what no function is (the framework & runtime, waiting).
 */
function Functions({
  rows,
  limit,
  palette,
  time,
  onShowRow,
}: {
  rows: readonly FunctionRow[];
  limit: number;
  palette: Palette;
  time: Measure;
  /** Opens the call tree at a wait's call. */
  onShowRow?: ((row: string) => void) | undefined;
}) {
  const { named, summaries } = apart(rows, limit);
  const most = Math.max(1, ...named.map((row) => row.self), ...summaries.map((row) => row.self));
  return (
    // One box with its header in it, as every table's: the head's band and hairline, its names' case and colour.
    <section className="overflow-hidden rounded-lg border bg-card" aria-label="Functions">
      <div className={LIST_HEAD}>
        <span>Function</span>
        <span className="text-right">Itself</span>
        <span className="text-right">In all</span>
      </div>
      <ol className="m-0 list-none p-0">
        {named.map(({ frame, self, total }) => (
          <ListLine
            key={`${frame.file}:${frame.line}:${frame.function}:${frame.waiting === true}`}
            name={frame.function}
            waited={packageOf(frame) === WAITING}
            place={where(frame)}
            tone={toneOf(palette, packageOf(frame))}
            amount={self}
            most={most}
            value={self ? time(self) : "—"}
            other={time(total)}
          />
        ))}
      </ol>
      <Summaries
        rows={summaries.map((row) => ({
          name: row.frame.function,
          kind: summaryOf(row.frame) ?? FRAMEWORK,
          amount: row.self,
          other: time(row.total),
          call: onShowRow ? callOf(row.frame) : undefined,
        }))}
        palette={palette}
        most={most}
        measure={time}
        onShowRow={onShowRow}
      />
    </section>
  );
}

/** A summary row: what no function is, its amount, and the list's second number. */
interface SummaryRow {
  name: string;
  /** Its colour's: the framework & runtime's, or waiting's (hatched), whatever the wait is named. */
  kind?: string | undefined;
  amount: number;
  other: string;
  /** A wait's first call, where the call tree opens. */
  call?: string | undefined;
}

/** A wait's first call (lib/waitCalls), for the call tree to open at. */
function callOf(frame: Frame): string | undefined {
  return (frame as WaitFrame).calls?.[0];
}

/**
 * Under a list's functions, after a rule: what no function is, the framework & runtime and waiting, muted, without
 * a place, never ranked among the functions. The same in every language's list, of time or of memory.
 */
function Summaries({
  rows,
  palette,
  most,
  measure,
  onShowRow,
}: {
  rows: readonly SummaryRow[];
  palette: Palette;
  most: number;
  measure: Measure;
  onShowRow?: ((row: string) => void) | undefined;
}) {
  if (rows.length === 0) return null;
  return (
    <ol className="m-0 list-none border-t-2 bg-muted/20 p-0" aria-label="Not a function">
      {rows.map((row) => {
        const tone = toneOf(palette, row.kind ?? row.name);
        return (
          <li
            key={row.name}
            className={cn(LIST_ROW, "border-t first:border-t-0 text-muted-foreground")}
            data-summary=""
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className={cn("size-2 shrink-0 rounded-sm", tone.dot)} />
              <SummaryName name={row.name} call={row.call} onShowRow={onShowRow} />
            </div>
            <div className="grid gap-1">
              <span className="text-right text-xs tabular-nums">{row.amount ? measure(row.amount) : "—"}</span>
              <span className="h-1 overflow-hidden rounded-full bg-muted">
                <span
                  className={cn("block h-full rounded-full", tone.dot)}
                  style={{ width: `${(row.amount / most) * 100}%` }}
                />
              </span>
            </div>
            <span className="text-right text-xs tabular-nums">{row.other}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** A summary's name; a wait's, a link to its call in the call tree where the trace's tree is at hand. */
function SummaryName({
  name,
  call,
  onShowRow,
}: {
  name: string;
  call: string | undefined;
  onShowRow: ((row: string) => void) | undefined;
}) {
  if (!(call && onShowRow)) return <span className="text-xs italic">{name}</span>;
  return (
    <button
      type="button"
      className="dt-link-button truncate text-left text-xs italic"
      title="Open its call in the call tree"
      onClick={() => onShowRow(call)}
    >
      {name}
    </button>
  );
}

/**
 * A row of a list under the flame graph: a function, where it is (or, for a site, the line of yours that led there),
 * its amount with a bar of its share, and the list's second number. Every list's rows look alike.
 */
function ListLine({
  name,
  place,
  tone,
  amount,
  most,
  value,
  other,
  title,
  waited = false,
}: {
  name: string;
  /** A frame that waited (All frames lists them): said as waiting's share says it, as Your code's waits are. */
  waited?: boolean;
  place: string;
  tone: Tone;
  amount: number;
  most: number;
  value: string;
  other: string;
  title?: string;
}) {
  return (
    <li className={cn(LIST_ROW, "border-t first:border-t-0 hover:bg-muted/40")}>
      <div className="flex min-w-0 items-start gap-2">
        <span className={cn("mt-1 size-2 shrink-0 rounded-sm", tone.dot)} />
        <div className="grid min-w-0 gap-0.5">
          <span className={cn("font-mono text-xs [overflow-wrap:anywhere]", waited && "text-muted-foreground italic")}>
            {waited ? `${WAITING} · ${name}` : name}
          </span>
          <span className="font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{place}</span>
        </div>
      </div>
      <div className="grid gap-1">
        <span className="text-right text-xs tabular-nums" title={title}>
          {value}
        </span>
        <span className="h-1 overflow-hidden rounded-full bg-muted">
          <span className={cn("block h-full rounded-full", tone.dot)} style={{ width: `${(amount / most) * 100}%` }} />
        </span>
      </div>
      <span className="text-right text-xs text-muted-foreground tabular-nums">{other}</span>
    </li>
  );
}

/** Where the memory was, largest first: the function that allocated, the line of yours that led there, its bytes. */
function Sites({
  profile,
  memory,
  total,
  palette,
}: {
  profile: Profile;
  memory: Memory;
  total: number;
  palette: Palette;
}) {
  const places = sitePlaces(profile, memory);
  const most = Math.max(1, ...places.map(({ site }) => site.bytes));
  return (
    <section className="overflow-hidden rounded-lg border bg-card" aria-label="Allocation sites">
      <SitesHead />
      <ol className="m-0 list-none p-0">
        {places.map((place) => (
          <SiteLine
            key={`${place.site.frames.join(",")}:${place.site.bytes}:${place.site.count}`}
            place={place}
            palette={palette}
            most={most}
            total={total}
          />
        ))}
      </ol>
    </section>
  );
}

/** The head of the list of allocation sites, in either view. */
function SitesHead() {
  return (
    <div className={LIST_HEAD}>
      <span>Allocated in</span>
      <span className="text-right">Bytes</span>
      <span className="text-right">Share</span>
    </div>
  );
}

/**
 * Your code's allocation sites, as its flame graph has them: each function of yours with the bytes allocated in it
 * and in the libraries it called, largest first; under them, apart, the framework & runtime's (sites with none of
 * your code). No library's function is a row.
 */
function OwnSites({ view, total, palette }: { view: Profile; total: number; palette: Palette }) {
  const { named, summaries } = apart(
    functions(view).filter((row) => row.self > 0),
    Number.POSITIVE_INFINITY,
  );
  const most = Math.max(1, ...named.map((row) => row.self), ...summaries.map((row) => row.self));
  return (
    <section className="overflow-hidden rounded-lg border bg-card" aria-label="Allocation sites">
      <SitesHead />
      <ol className="m-0 list-none p-0">
        {named.map(({ frame, self }) => (
          <ListLine
            key={`${frame.file}:${frame.line}:${frame.function}`}
            name={frame.function}
            place={where(frame)}
            tone={toneOf(palette, packageOf(frame))}
            amount={self}
            most={most}
            value={bytes(self)}
            other={percent(self, total)}
          />
        ))}
      </ol>
      <Summaries
        rows={summaries.map((row) => ({ name: row.frame.function, amount: row.self, other: percent(row.self, total) }))}
        palette={palette}
        most={most}
        measure={bytes}
      />
    </section>
  );
}

function SiteLine({
  place: { site, allocated, own },
  palette,
  most,
  total,
}: {
  place: SitePlace;
  palette: Palette;
  most: number;
  total: number;
}) {
  return (
    <ListLine
      name={allocated.function}
      place={where(own)}
      tone={toneOf(palette, packageOf(allocated))}
      amount={site.bytes}
      most={most}
      value={bytes(site.bytes)}
      other={percent(site.bytes, total)}
      title={`${site.count.toLocaleString()} blocks`}
    />
  );
}

/* ---------- a chain's profiles ---------- */

/**
 * The Profile tab: the trace's own profile, or, over a chain of calls or under a row of the call tree, each app's
 * profile in it (its traces' merged, a row's stretch of its own), never one flame across apps.
 */
export function ProfileTab({
  trace,
  open,
  chain,
  onShowRow,
}: {
  trace: Trace;
  open: boolean;
  chain: TraceScope;
  /** Opens the call tree at a row: a wait's call. */
  onShowRow?: ((row: string) => void) | undefined;
}) {
  const profiles = useMemo(() => scopedProfiles(chain.members, chain.scope), [chain.members, chain.scope]);
  // A code or wait row's stretches (the link's `at`) are this trace's: its own profile of them, in a chain too.
  const { stretch } = useHeldSlice();
  const own =
    (stretch !== null && trace.profile !== undefined) ||
    (profiles.length === 1 && profiles[0]?.member.id === trace.id && profiles[0].windows === null);
  if (own || (profiles.length === 0 && !chain.scope))
    return <ProfilePane trace={trace} open={open} onShowRow={onShowRow} />;
  if (!open) return null;
  return <ChainProfiles profiles={profiles} chain={chain} />;
}

/**
 * The scope's chip, "All apps" and a chip per profiled app; what each app's profile adds up to; their flames. Where
 * an app's traces measured their memory, its memory instead of its time, as a trace's own Profile tab has it.
 */
function ChainProfiles({ profiles, chain }: { profiles: readonly ScopedProfile[]; chain: TraceScope }) {
  const apps = useMemo(() => appProfiles(profiles), [profiles]);
  const memories = useMemo(() => appMemories(apps), [apps]);
  const [picked, setPicked] = useState<string | null>(null);
  // Which app's tab is open beside the tree: the same one, in time and in memory.
  const [tab, setTab] = useState<string | null>(null);
  const [kind, setKind] = useKind();
  const runtimes = useMemo(() => new Map(apps.map((app) => [app.app, appRuntime(app)])), [apps]);
  const counts = useMemo(() => new Map(apps.map((app) => [app.app, app.traces.length])), [apps]);
  // Only a chain with a trace that measured its memory has the choice.
  const measured = memories.size > 0;
  const memory = measured && kind === "memory";
  const listed = apps.filter((app) => (picked === null || app.app === picked) && (!memory || memories.has(app.app)));
  return (
    <>
      <ScopeHeader
        scope={chain.scope}
        onScope={chain.setScope}
        apps={{ apps: apps.map((app) => app.app), runtimes, counts, picked, onPick: setPicked }}
        summary={chainSummary(listed, memory ? memories : null)}
        end={measured ? <Segmented label="Profile of" segments={KINDS} value={kind} onChange={setKind} /> : null}
      />
      {memory ? (
        <ChainMemory apps={listed} memories={memories} tab={tab} onTab={setTab} />
      ) : (
        <ChainTime apps={listed} tab={tab} onTab={setTab} />
      )}
    </>
  );
}

/** How many traces the tab shows: profiled, or with their memory; nothing when it shows none. */
function chainSummary(apps: readonly AppProfile[], memories: ReadonlyMap<string, AppMemory> | null): string | null {
  if (apps.length === 0) return null;
  if (!memories) {
    return plural(
      apps.reduce((sum, app) => sum + app.traces.length, 0),
      "profiled trace",
      "profiled traces",
    );
  }
  const traces = apps.reduce((sum, app) => sum + (memories.get(app.app)?.traces ?? 0), 0);
  return `${plural(traces, "trace", "traces")} with their memory`;
}

/** Beside the tree there is room for one app: the apps as tabs, no table of what the tab then says. */
function OneApp({
  apps,
  app,
  onTab,
  children,
}: {
  apps: readonly AppProfile[];
  app: AppProfile | undefined;
  onTab: (app: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="dt-profile-one" data-one-app="">
      {apps.length > 1 && app ? (
        <Segmented
          label="App"
          segments={apps.map((each) => ({ id: each.app, label: each.app }))}
          value={app.app}
          onChange={onTab}
        />
      ) : null}
      {children}
    </div>
  );
}

/** Each app's time: what it adds up to, then its flame. */
function ChainTime({
  apps,
  tab,
  onTab,
}: {
  apps: readonly AppProfile[];
  tab: string | null;
  onTab: (app: string) => void;
}) {
  const views = useMemo(() => new Map(apps.map((app) => [app.app, appView(app)])), [apps]);
  const beside = useContext(HiddenColumns) !== null;
  if (apps.length === 0) return <p className="dt-note">Nothing profiled under this.</p>;
  if (beside) {
    const app = apps.find((each) => each.app === tab) ?? apps[0];
    const view = app && views.get(app.app);
    return (
      <OneApp apps={apps} app={app} onTab={onTab}>
        {app && view ? <AppProfileSection key={app.app} app={app} view={view} /> : null}
      </OneApp>
    );
  }
  return (
    <>
      <ProfileSums apps={apps} views={views} />
      {apps.map((app) => {
        const view = views.get(app.app);
        return view ? <AppProfileSection key={app.app} app={app} view={view} /> : null;
      })}
    </>
  );
}

/** Each app's memory: what it adds up to, then where it was. */
function ChainMemory({
  apps,
  memories,
  tab,
  onTab,
}: {
  apps: readonly AppProfile[];
  memories: ReadonlyMap<string, AppMemory>;
  tab: string | null;
  onTab: (app: string) => void;
}) {
  const beside = useContext(HiddenColumns) !== null;
  if (apps.length === 0) return <p className="dt-note">No memory measured under this.</p>;
  if (beside) {
    const app = apps.find((each) => each.app === tab) ?? apps[0];
    const measured = app && memories.get(app.app);
    return (
      <OneApp apps={apps} app={app} onTab={onTab}>
        {app && measured ? <AppMemorySection key={app.app} app={app} measured={measured} /> : null}
      </OneApp>
    );
  }
  return (
    <>
      <MemorySums apps={apps} memories={memories} />
      {apps.map((app) => {
        const measured = memories.get(app.app);
        return measured ? <AppMemorySection key={app.app} app={app} measured={measured} /> : null;
      })}
    </>
  );
}

/** An app's memory in the scope: one trace's, or its traces' added up; how many traces measured it. */
interface AppMemory extends MemoryOf {
  app: string;
  traces: number;
  title: string;
  /** Why a stretch picked isn't what it shows: memory isn't timed. */
  note: string | null;
}

/** The apps whose traces measured their memory, each with it. */
function appMemories(apps: readonly AppProfile[]): ReadonlyMap<string, AppMemory> {
  return new Map(apps.flatMap((app) => appMemory(app) ?? []).map((each) => [each.app, each]));
}

function appMemory(app: AppProfile): AppMemory | undefined {
  const measured = app.traces.filter((each) => each.profile.memory);
  const merged = mergeMemories(measured.map((each) => each.profile));
  if (!merged) return undefined;
  const title = measured.length > 1 ? `Memory of ${measured.length} traces` : "Memory of the whole trace";
  const narrowed = measured.some((each) => each.windows !== null);
  const note = narrowed ? "Its memory isn't timed: the stretch picked can't narrow it." : null;
  return { ...merged, app: app.app, traces: measured.length, title, note };
}

/** What an app runs on, from its first profiled trace: the mark on its chip. */
function appRuntime(app: AppProfile): string | undefined {
  return serviceRuntime(app.traces.map((each) => traceRuntime(each.member.trace.attrs))) ?? undefined;
}

/**
 * An app's profile in the scope: one trace's (its stretch), or its traces' merged, Your code's waits named by what
 * was in flight in each trace, as a trace's own Profile tab names them. Several traces' split is theirs added up and
 * said once (lib/split), their merged stacks rounded to it.
 */
function appView(app: AppProfile): Scope {
  const scopes = app.traces.map((each) => scopeOf(each.member.trace, each.profile, each.windows));
  const [one] = scopes;
  if (scopes.length === 1 && one) return one;
  const parts = app.traces.map((each) => ({
    trace: { ...each.member.trace, profile: each.profile },
    windows: each.windows,
  }));
  const split = appSplit(parts);
  const readable = parts.every((part) => splitByProfile(part.trace));
  const merged = (named: boolean) =>
    readable
      ? sayProfile(
          mergeProfiles(parts.map((part) => rawWindowProfile(part.trace as Readable, part.windows, named))),
          split,
        )
      : mergeProfiles(scopes.map((each) => (named ? each.own : each.profile)));
  return { profile: merged(false), own: merged(true), split, title: `Profile of ${split.of}`, note: null };
}

/** What each app's profiles add up to, a row an app in aligned columns: the time's, or the memory's. */
function SumsTable({ label, columns, children }: { label: string; columns: readonly string[]; children: ReactNode }) {
  return (
    <div className="dt-profile-sums-wrap">
      <table className="dt-profile-sums" aria-label={label}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const TIME_SUMS = ["App", "Profiled", "Waiting", "Most time in"] as const;
const MEMORY_SUMS = ["App", "Peak", "Net", "Most memory in"] as const;

/** Each app's profiled time, of it waiting, and the function that ran most. */
function ProfileSums({ apps, views }: { apps: readonly AppProfile[]; views: ReadonlyMap<string, Scope> }) {
  return (
    <SumsTable label="What the profiles add up to" columns={TIME_SUMS}>
      {apps.map((app) => (
        <ProfileSumRow key={app.app} app={app} view={views.get(app.app)} />
      ))}
    </SumsTable>
  );
}

/** One app's row: its chip, its profiled time, of it waiting, the function most time went in. */
function ProfileSumRow({ app, view }: { app: AppProfile; view: Scope | undefined }) {
  if (!view) return null;
  const top = mostTimeIn(view.profile);
  return (
    <tr>
      <td>
        <AppChip name={app.app} runtime={appRuntime(app)} compact />
      </td>
      {/* As its section's head and bar say them: its split's (lib/split). */}
      <td>{view.split.covered}</td>
      <td>{shareIn(view.split, WAITING)?.time ?? "—"}</td>
      <td>{top ? <code title={top}>{top}</code> : "—"}</td>
    </tr>
  );
}

/** One app's flame and functions, under its name: an app's own, never mixed with another's. */
function AppProfileSection({ app, view }: { app: AppProfile; view: Scope }) {
  const frames = useFrames(view.profile);
  return (
    <section
      className="dt-app-profile"
      aria-label={`Profile of ${app.app}`}
      data-traces={app.traces.map((each) => each.member.trace.id).join(",")}
    >
      <ProfileView
        key={view.title}
        profile={view.profile}
        own={view.own}
        frames={frames}
        measure={(samples) => duration(samples * view.profile.interval_us)}
        noun="Time"
        kinds={null}
        split={view.split}
        head={
          <div className="grid gap-0.5" data-split-head="">
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <AppChip name={app.app} runtime={appRuntime(app)} />
              {view.title}
            </span>
            <SplitCover
              split={view.split}
              about={app.traces.some((each) => each.profile.estimated_from !== undefined) ? "≈ " : ""}
            />
            <span className="text-xs text-muted-foreground" data-sampled="">
              {view.note ?? view.split.sampled}
            </span>
          </div>
        }
        list={({ view: frames, palette, measure }) => (
          <Functions rows={functions(frames)} limit={15} palette={palette} time={measure} />
        )}
      />
    </section>
  );
}

/** Each app's memory: its peak, what it kept, the function that allocated most. */
function MemorySums({ apps, memories }: { apps: readonly AppProfile[]; memories: ReadonlyMap<string, AppMemory> }) {
  return (
    <SumsTable label="What the memory adds up to" columns={MEMORY_SUMS}>
      {apps.map((app) => (
        <MemorySumRow key={app.app} app={app} measured={memories.get(app.app)} />
      ))}
    </SumsTable>
  );
}

function MemorySumRow({ app, measured }: { app: AppProfile; measured: AppMemory | undefined }) {
  if (!measured) return null;
  const sums = memorySums(measured);
  return (
    <tr>
      <td>
        <AppChip name={app.app} runtime={appRuntime(app)} compact />
      </td>
      <td>{bytes(sums.peak)}</td>
      <td>{signed(sums.net)}</td>
      <td>{sums.top ? <code title={sums.top}>{sums.top}</code> : "—"}</td>
    </tr>
  );
}

/** One app's memory, under its name: its allocation sites as a trace's Memory view has them. */
function AppMemorySection({ app, measured }: { app: AppProfile; measured: AppMemory }) {
  // The app's time profile decides the first choice, as a trace's own Profile tab has it.
  const frames = useFrames(measured.profile);
  return (
    <section className="dt-app-profile" aria-label={`Memory of ${app.app}`}>
      <MemoryPane
        key={measured.title}
        profile={measured.profile}
        memory={measured.memory}
        frames={frames}
        kinds={null}
        head={
          <MemoryHead
            memory={measured.memory}
            what={{
              title: measured.title,
              app: <AppChip name={app.app} runtime={appRuntime(app)} />,
              traces: measured.traces,
              note: measured.note,
              sampled: app.traces.some((each) => sampledSites(each.member.trace.attrs)),
            }}
          />
        }
      />
    </section>
  );
}
