import { type MouseEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { bytes, duration } from "./format";
import { type Memory, memoryProfile, type SitePlace, sitePlaces } from "./lib/memory";
import { percent } from "./lib/percent";
import {
  allFrames,
  type Box,
  type Frame,
  functions,
  layout,
  mostlyYours,
  type Node,
  ownCode,
  type Profile,
  packageOf,
  packageTimes,
  tree,
  WAITING,
  YOUR_CODE,
} from "./lib/profile";
import { rangeLabel, type TimeRange } from "./lib/slice";
import { cn } from "./lib/utils";
import { timed, wallClock } from "./lib/waiting";
import { Segmented } from "./Segmented";
import { largestFirst, ShareBar, ShareFace } from "./Shares";
import { HEAD_TEXT } from "./TableColumns";
import { useHeldSlice } from "./TimeSlice";
import type { Trace } from "./types";

/** A package's color: a fill for boxes, a solid one for dots and bars. Your code is the brand's; the rest in order. */
interface Tone {
  fill: string;
  dot: string;
}

const PALETTE: readonly Tone[] = [
  { fill: "bg-sky-500/30 hover:bg-sky-500/50", dot: "bg-sky-500" },
  { fill: "bg-emerald-500/30 hover:bg-emerald-500/50", dot: "bg-emerald-500" },
  { fill: "bg-amber-500/30 hover:bg-amber-500/50", dot: "bg-amber-500" },
  { fill: "bg-rose-500/30 hover:bg-rose-500/50", dot: "bg-rose-500" },
  { fill: "bg-cyan-500/30 hover:bg-cyan-500/50", dot: "bg-cyan-500" },
  { fill: "bg-orange-500/30 hover:bg-orange-500/50", dot: "bg-orange-500" },
];
const YOURS: Tone = { fill: "bg-brand/40 hover:bg-brand/60", dot: "bg-brand" };
// Waiting is no package's time: neutral, hatched, as the time strip draws it.
const WAITS: Tone = {
  fill: "dt-hatched bg-muted-foreground/15 hover:bg-muted-foreground/25",
  dot: "dt-hatched bg-muted-foreground/50",
};
const REST: Tone = { fill: "bg-muted-foreground/20 hover:bg-muted-foreground/30", dot: "bg-muted-foreground/50" };

type Palette = Map<string, Tone>;
type Share = { name: string; samples: number };

/** Your code, then the packages that took most, one color each; the rest share one gray as "other". */
function colors(names: readonly string[]): Palette {
  const others = names.filter((name) => name !== YOUR_CODE && name !== WAITING).slice(0, PALETTE.length);
  return new Map([
    [YOUR_CODE, YOURS],
    [WAITING, WAITS],
    ...others.map((name, at): [string, Tone] => [name, PALETTE[at] ?? REST]),
  ]);
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

const KINDS = [
  { id: "time", label: "Time" },
  { id: "memory", label: "Memory" },
] as const;

/** The Profile tab's content, when it is the tab open and the trace has a profile: its time, or its memory. */
export function ProfilePane({ trace, open }: { trace: Trace; open: boolean }) {
  const range = useProfileRange(open);
  const [kind, setKind] = useState<Kind>("time");
  // Kept while the profile and the range are: the flame graph's zoom belongs to the profile it was made in.
  const scope = useMemo(
    () => (trace.profile ? scopeOf(trace.profile, range, trace.duration) : null),
    [trace.profile, range, trace.duration],
  );
  if (!(open && trace.profile && scope)) return null;
  return <ProfileOf trace={trace} profile={trace.profile} scope={scope} kind={kind} onKind={setKind} />;
}

/** The profile's time, or, where it measured its memory and that is the choice, its memory. */
function ProfileOf({
  trace,
  profile,
  scope,
  kind,
  onKind,
}: {
  trace: Trace;
  profile: Profile;
  scope: Scope;
  kind: Kind;
  onKind: (kind: Kind) => void;
}) {
  const memory = profile.memory;
  // Only a profile that measured its memory has the choice.
  const kinds = memory ? <Segmented label="Profile of" segments={KINDS} value={kind} onChange={onKind} /> : null;
  if (memory && kind === "memory") return <MemoryPane profile={profile} memory={memory} kinds={kinds} />;
  return (
    <ProfileView
      key={scope.title}
      profile={scope.profile}
      measure={(samples) => duration(samples * scope.profile.interval_us)}
      noun="Time"
      kinds={kinds}
      head={<ProfileHead whole={profile} shown={scope.profile} trace={trace} scope={scope} />}
      list={({ view, palette, measure }) => (
        <Functions rows={functions(view).slice(0, 30)} palette={palette} time={measure} />
      )}
    />
  );
}

/** Where the trace's memory was: its allocation sites read as the time is, by package and as a flame of bytes. */
function MemoryPane({ profile, memory, kinds }: { profile: Profile; memory: Memory; kinds: ReactNode }) {
  const sites = useMemo(() => memoryProfile(profile, memory), [profile, memory]);
  const head = <MemoryHead memory={memory} />;
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
      measure={bytes}
      noun="Memory"
      kinds={kinds}
      head={head}
      list={({ palette }) => <Sites profile={profile} memory={memory} total={sites.samples} palette={palette} />}
    />
  );
}

/** "+1.2 MB": what a trace kept, its sign said. */
function signed(size: number): string {
  return size > 0 ? `+${bytes(size)}` : bytes(size);
}

/** What the trace allocated: its peak, what it kept and allocated in all, and what the numbers can't tell apart. */
function MemoryHead({ memory }: { memory: Memory }) {
  const kept = [`net ${signed(memory.net)}`];
  if (memory.allocated !== undefined) kept.push(`${bytes(memory.allocated)} allocated in all`);
  return (
    <div className="grid gap-0.5">
      <span className="text-xs text-muted-foreground">Memory of the whole trace</span>
      <span className="text-2xl font-semibold tracking-tight tabular-nums">
        {bytes(memory.peak)}
        <span className="ml-2 text-sm font-normal text-muted-foreground">peak, above where it started</span>
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">{kept.join(" · ")}</span>
      {memory.sites_at === "end" ? (
        <span className="text-xs text-muted-foreground">Where it was at the end of the trace, not its peak</span>
      ) : null}
      {memory.shared ? (
        <span className="text-xs text-warn">Includes other traces that ran in the process meanwhile</span>
      ) : null}
    </div>
  );
}

/** The stretch the tab was opened at (its own, gone once it closes), else the call tree's range. */
function useProfileRange(open: boolean): TimeRange | null {
  const { slice, stretch, profileAt } = useHeldSlice();
  useEffect(() => {
    if (!open) profileAt(null);
  }, [open, profileAt]);
  return stretch ?? slice.range;
}

/** What the tab profiles: a stretch picked (when the profile says when its stacks were seen), else the whole trace. */
interface Scope {
  profile: Profile;
  title: string;
  /** Why a stretch picked isn't what it shows: the profile doesn't say when. */
  note: string | null;
  /** In the trace's own time (the profile says when its samples were taken), not in samples. */
  timed: boolean;
}

function scopeOf(profile: Profile, range: TimeRange | null, total: number): Scope {
  // Timed, it reads in the trace's own time, as the time strip does; a range narrows it.
  if (timed(profile)) {
    const title = range ? `Profile of ${rangeLabel(range)}` : "Profile of the whole trace";
    return { profile: wallClock(profile, total, range), title, note: null, timed: true };
  }
  const note = range ? "Its samples aren't timed: the range picked can't narrow it." : null;
  return { profile, title: "Profile of the whole trace", note, timed: false };
}

/** "110 samples, one every 10 ms": what the profile took. */
function samplesLine(profile: Profile): string {
  return `${profile.samples.toLocaleString()} samples, one every ${duration(profile.interval_us)}`;
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
function ProfileHead({ whole, shown, trace, scope }: { whole: Profile; shown: Profile; trace: Trace; scope: Scope }) {
  const time = (samples: number) => duration(samples * whole.interval_us);
  return (
    <div className="grid gap-0.5">
      <span className="text-xs text-muted-foreground">{scope.title}</span>
      <span className="text-2xl font-semibold tracking-tight tabular-nums">
        {time(shown.samples)}
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          {scope.timed ? "profiled" : "sampled"} of the trace's {duration(trace.duration)}
        </span>
      </span>
      <span className="text-xs text-muted-foreground">{scope.note ?? samplesLine(whole)}</span>
      <Dropped whole={whole} timed={scope.timed} />
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
  head,
  measure,
  noun,
  kinds,
  list,
}: {
  profile: Profile;
  head: ReactNode;
  measure: Measure;
  noun: string;
  kinds: ReactNode;
  list: (shown: Shown) => ReactNode;
}) {
  const [own, setOwn] = useState(() => mostlyYours(profile));
  const [lit, setLit] = useState<ReadonlySet<string>>(new Set());
  const packages = useMemo(() => packageTimes(profile), [profile]);
  const palette = useMemo(() => colors(packages.map((item) => item.name)), [packages]);
  const view = useMemo(() => (own ? ownCode(profile) : allFrames(profile)), [profile, own]);
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
            onChange={(id) => setOwn(id === "own")}
          />
        </div>
      </header>
      <Packages
        noun={noun}
        shares={summed(packages, palette)}
        palette={palette}
        total={profile.samples}
        time={measure}
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

/** Waiting after every package, and the rest folded together before it. */
function rankOf(share: Share): number {
  if (share.name === WAITING) return 2;
  return share.name === "other" ? 1 : 0;
}

/** Where the time went by package: one bar of shares, then the legend of them; a click lights its frames. */
function Packages({
  noun,
  shares,
  palette,
  total,
  time,
  lit,
  onLight,
  onClear,
}: {
  noun: string;
  shares: readonly Share[];
  palette: Palette;
  total: number;
  time: Measure;
  lit: ReadonlySet<string>;
  onLight: (name: string) => void;
  onClear: () => void;
}) {
  const ordered = largestFirst(shares, (share) => share.samples, rankOf);
  const parts = ordered.map(({ name, samples }) => ({
    key: name,
    size: samples,
    className: toneOf(palette, name).dot,
    title: `${name}: ${time(samples)}`,
    faded: faded(lit, name),
  }));
  return (
    <section className="grid gap-3" aria-label={`${noun} by package`}>
      <ShareBar parts={parts} total={total} />
      <ul className="dt-breakdown-legend">
        {ordered.map(({ name, samples }) => (
          <li key={name}>
            <button type="button" className="dt-share" aria-pressed={lit.has(name)} onClick={() => onLight(name)}>
              <ShareFace
                swatch={<span className={cn("dt-dot", toneOf(palette, name).dot)} />}
                name={name}
                value={time(samples)}
                share={percent(samples, total)}
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
  const card = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hovered | null>(null);
  const track = (event: MouseEvent, node: Node) => {
    const at = card.current;
    if (!at) return;
    // In the card's scrolled content, where the tip is placed.
    const area = at.getBoundingClientRect();
    setHover({ node, x: event.clientX - area.left, y: event.clientY - area.top + at.scrollTop });
  };
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
      <div ref={card} className="relative max-h-[30rem] overflow-y-auto rounded-lg border bg-card p-1.5">
        <div className="relative w-full" style={{ height: depth * (ROW + 2) }} role="img" aria-label="Flame graph">
          {boxes.map((box) => (
            <FlameBox
              key={box.node.key}
              box={box}
              tone={toneOf(palette, box.node.frame ? packageOf(box.node.frame) : "")}
              faded={box.node.frame !== null && faded(lit, colored(palette, packageOf(box.node.frame)))}
              onZoom={() => setFocus(box.node)}
              onHover={(event) => track(event, box.node)}
              onLeave={() => setHover(null)}
            />
          ))}
        </div>
        {hover ? <Tip hovered={hover} total={root.total} time={time} /> : null}
      </div>
    </section>
  );
}

/** What the box under the pointer is: its function, where it is, whole, and its time. */
function Tip({ hovered: { node, x, y }, total, time }: { hovered: Hovered; total: number; time: Measure }) {
  const frame = node.frame;
  if (!frame) return null;
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 grid w-max max-w-md gap-1 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg"
      style={{ left: Math.max(8, x - 120), top: y + 18 }}
    >
      <span className="font-mono font-medium [overflow-wrap:anywhere]">{frame.function}</span>
      <span className="font-mono text-muted-foreground [overflow-wrap:anywhere]">{where(frame)}</span>
      <span className="tabular-nums">
        {time(node.total)} · {percent(node.total, total)} · {time(node.self)} in itself
      </span>
    </div>
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

/** The functions by the time they ran themselves: each with where it is, whole, and a bar of its share. */
function Functions({ rows, palette, time }: { rows: readonly FunctionRow[]; palette: Palette; time: Measure }) {
  const most = Math.max(1, ...rows.map((row) => row.self));
  return (
    // One box with its header in it, as every table's: the head's band and hairline, its names' case and colour.
    <section className="overflow-hidden rounded-lg border bg-card" aria-label="Functions">
      <div className={LIST_HEAD}>
        <span>Function</span>
        <span className="text-right">Itself</span>
        <span className="text-right">In all</span>
      </div>
      <ol className="m-0 list-none p-0">
        {rows.map((row) => (
          <FunctionLine
            key={`${row.frame.file}:${row.frame.line}:${row.frame.function}`}
            row={row}
            tone={toneOf(palette, packageOf(row.frame))}
            most={most}
            time={time}
          />
        ))}
      </ol>
    </section>
  );
}

function FunctionLine({
  row: { frame, self, total },
  tone,
  most,
  time,
}: {
  row: FunctionRow;
  tone: Tone;
  most: number;
  time: Measure;
}) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_5rem_4.5rem] items-center gap-3 border-t px-3 py-1.5 first:border-t-0 hover:bg-muted/40">
      <div className="flex min-w-0 items-start gap-2">
        <span className={cn("mt-1 size-2 shrink-0 rounded-sm", tone.dot)} />
        <div className="grid min-w-0 gap-0.5">
          <span className="font-mono text-xs [overflow-wrap:anywhere]">{frame.function}</span>
          <span className="font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{where(frame)}</span>
        </div>
      </div>
      <div className="grid gap-1">
        <span className="text-right text-xs tabular-nums">{self ? time(self) : "—"}</span>
        <span className="h-1 overflow-hidden rounded-full bg-muted">
          <span className={cn("block h-full rounded-full", tone.dot)} style={{ width: `${(self / most) * 100}%` }} />
        </span>
      </div>
      <span className="text-right text-xs text-muted-foreground tabular-nums">{time(total)}</span>
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
      <div className={LIST_HEAD}>
        <span>Allocated in</span>
        <span className="text-right">Bytes</span>
        <span className="text-right">Share</span>
      </div>
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
  const tone = toneOf(palette, packageOf(allocated));
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_5rem_4.5rem] items-center gap-3 border-t px-3 py-1.5 first:border-t-0 hover:bg-muted/40">
      <div className="flex min-w-0 items-start gap-2">
        <span className={cn("mt-1 size-2 shrink-0 rounded-sm", tone.dot)} />
        <div className="grid min-w-0 gap-0.5">
          <span className="font-mono text-xs [overflow-wrap:anywhere]">{allocated.function}</span>
          <span className="font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{where(own)}</span>
        </div>
      </div>
      <div className="grid gap-1">
        <span className="text-right text-xs tabular-nums" title={`${site.count.toLocaleString()} blocks`}>
          {bytes(site.bytes)}
        </span>
        <span className="h-1 overflow-hidden rounded-full bg-muted">
          <span
            className={cn("block h-full rounded-full", tone.dot)}
            style={{ width: `${(site.bytes / most) * 100}%` }}
          />
        </span>
      </div>
      <span className="text-right text-xs text-muted-foreground tabular-nums">{percent(site.bytes, total)}</span>
    </li>
  );
}
