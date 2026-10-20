import { type MouseEvent, useMemo, useRef, useState } from "react";
import { duration } from "./format";
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
  YOUR_CODE,
} from "./lib/profile";
import { cn } from "./lib/utils";
import { Segmented } from "./Segmented";
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
const REST: Tone = { fill: "bg-muted-foreground/20 hover:bg-muted-foreground/30", dot: "bg-muted-foreground/50" };

type Palette = Map<string, Tone>;
type Share = { name: string; samples: number };

/** Your code, then the packages that took most, one color each; the rest share one gray as "other". */
function colors(names: readonly string[]): Palette {
  const others = names.filter((name) => name !== YOUR_CODE).slice(0, PALETTE.length);
  return new Map([[YOUR_CODE, YOURS], ...others.map((name, at): [string, Tone] => [name, PALETTE[at] ?? REST])]);
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
/** A box narrower than this keeps its color but drops its name. */
const LABELLED = 0.035;

type Time = (samples: number) => string;

const FRAMES = [
  { id: "own", label: "Your code" },
  { id: "all", label: "All frames" },
] as const;

/** The Profile tab's content, when it is the tab open and the trace has a profile. */
export function ProfilePane({ trace, open }: { trace: Trace; open: boolean }) {
  return open && trace.profile ? <ProfileView profile={trace.profile} /> : null;
}

/** Where the trace's time went in code: by package, as a flame graph of your code or of every frame, by function. */
function ProfileView({ profile }: { profile: Profile }) {
  const [own, setOwn] = useState(() => mostlyYours(profile));
  const [lit, setLit] = useState<ReadonlySet<string>>(new Set());
  const packages = useMemo(() => packageTimes(profile), [profile]);
  const palette = useMemo(() => colors(packages.map((item) => item.name)), [packages]);
  const view = useMemo(() => (own ? ownCode(profile) : allFrames(profile)), [profile, own]);
  const time: Time = (samples) => duration(samples * profile.interval_us);
  return (
    <div className="@container grid gap-6 p-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-0.5">
          <span className="text-xs text-muted-foreground">Time in code</span>
          <span className="text-2xl font-semibold tracking-tight tabular-nums">{time(profile.samples)}</span>
          <span className="text-xs text-muted-foreground">
            {profile.samples.toLocaleString()} samples, one every {duration(profile.interval_us)}
          </span>
        </div>
        <Segmented
          label="Frames shown"
          segments={FRAMES}
          value={own ? "own" : "all"}
          onChange={(id) => setOwn(id === "own")}
        />
      </header>
      <Packages
        shares={summed(packages, palette)}
        palette={palette}
        total={profile.samples}
        time={time}
        lit={lit}
        onLight={(name) => setLit(toggled(lit, name))}
        onClear={() => setLit(new Set())}
      />
      {/* Keyed: a zoom belongs to the frames it was made in. */}
      <Flame key={String(own)} profile={view} palette={palette} lit={lit} time={time} />
    </div>
  );
}

/** The colored packages, then everything else as one "other". */
function summed(packages: readonly Share[], palette: Palette): Share[] {
  const named = packages.filter((item) => palette.has(item.name));
  const other = packages.filter((item) => !palette.has(item.name)).reduce((sum, item) => sum + item.samples, 0);
  return other ? [...named, { name: "other", samples: other }] : named;
}

/** Where the time went by package: one bar of shares, then each package on its line; a click lights its frames. */
function Packages({
  shares,
  palette,
  total,
  time,
  lit,
  onLight,
  onClear,
}: {
  shares: readonly Share[];
  palette: Palette;
  total: number;
  time: Time;
  lit: ReadonlySet<string>;
  onLight: (name: string) => void;
  onClear: () => void;
}) {
  return (
    <section className="grid gap-3" aria-label="Time by package">
      <div className="flex h-3 gap-0.5 overflow-hidden rounded-full">
        {shares.map(({ name, samples }) => (
          <span
            key={name}
            title={`${name}: ${time(samples)}`}
            className={cn("h-full transition-opacity", toneOf(palette, name).dot, faded(lit, name) && "opacity-30")}
            style={{ width: `${(samples / total) * 100}%` }}
          />
        ))}
      </div>
      <ul className="m-0 grid max-w-4xl list-none gap-x-8 gap-y-0.5 p-0 @xl:grid-cols-2">
        {shares.map((share) => (
          <PackageLine
            key={share.name}
            share={share}
            tone={toneOf(palette, share.name)}
            total={total}
            time={time}
            lit={lit.has(share.name)}
            onLight={() => onLight(share.name)}
          />
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

function PackageLine({
  share: { name, samples },
  tone,
  total,
  time,
  lit,
  onLight,
}: {
  share: Share;
  tone: Tone;
  total: number;
  time: Time;
  lit: boolean;
  onLight: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={lit}
        onClick={onLight}
        className={cn(
          "grid w-full grid-cols-[auto_minmax(0,1fr)_2.5rem_4rem] items-center gap-2.5 rounded-md px-2 py-1 text-left text-xs transition-colors",
          lit ? "bg-accent" : "hover:bg-accent/60",
        )}
      >
        <span className={cn("size-2.5 rounded-sm", tone.dot)} />
        <span className="truncate font-mono" title={name}>
          {name}
        </span>
        <span className="text-right text-muted-foreground tabular-nums">{Math.round((samples / total) * 100)}%</span>
        <span className="text-right tabular-nums">{time(samples)}</span>
      </button>
    </li>
  );
}

interface Hovered {
  node: Node;
  x: number;
  y: number;
}

/** A flame graph from the outermost call down (a click zooms in, a hover tells), and the functions by their time. */
function Flame({
  profile,
  palette,
  lit,
  time,
}: {
  profile: Profile;
  palette: Palette;
  lit: ReadonlySet<string>;
  time: Time;
}) {
  const root = useMemo(() => tree(profile), [profile]);
  const rows = useMemo(() => functions(profile).slice(0, 30), [profile]);
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
    <div className="grid gap-6">
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
      <Functions rows={rows} palette={palette} time={time} />
    </div>
  );
}

/** What the box under the pointer is: its function, where it is, whole, and its time. */
function Tip({ hovered: { node, x, y }, total, time }: { hovered: Hovered; total: number; time: Time }) {
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
        {time(node.total)} · {Math.round((node.total / total) * 100)}% · {time(node.self)} in itself
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
function Functions({ rows, palette, time }: { rows: readonly FunctionRow[]; palette: Palette; time: Time }) {
  const most = Math.max(1, ...rows.map((row) => row.self));
  return (
    <section className="grid gap-2" aria-label="Functions">
      <div className="grid grid-cols-[minmax(0,1fr)_5rem_4.5rem] gap-3 px-3 text-xs text-muted-foreground">
        <span>Function</span>
        <span className="text-right">Itself</span>
        <span className="text-right">In all</span>
      </div>
      <ol className="m-0 list-none overflow-hidden rounded-lg border bg-card p-0">
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
  time: Time;
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
