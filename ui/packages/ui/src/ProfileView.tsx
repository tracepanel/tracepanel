import { useMemo, useState } from "react";
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
import type { Trace } from "./types";

/** A package's color, in the order packages first take time; your code always the brand's. */
const PALETTE = [
  "bg-sky-500/25 hover:bg-sky-500/40",
  "bg-teal-500/25 hover:bg-teal-500/40",
  "bg-amber-500/25 hover:bg-amber-500/40",
  "bg-rose-500/25 hover:bg-rose-500/40",
  "bg-lime-500/25 hover:bg-lime-500/40",
  "bg-cyan-500/25 hover:bg-cyan-500/40",
  "bg-orange-500/25 hover:bg-orange-500/40",
] as const;
const YOURS = "bg-brand/35 hover:bg-brand/50";
const REST = "bg-muted hover:bg-muted/70";

function colors(names: readonly string[]): Map<string, string> {
  const others = names.filter((name) => name !== YOUR_CODE);
  return new Map([[YOUR_CODE, YOURS], ...others.map((name, at): [string, string] => [name, PALETTE[at] ?? REST])]);
}

function where(frame: Frame): string {
  return frame.file ? `${frame.file}:${frame.line}` : "";
}

const ROW = 18;
/** A box narrower than this keeps its color but drops its name. */
const LABELLED = 0.04;

type Time = (samples: number) => string;

/** The Profile tab's content, when it is the tab open and the trace has a profile. */
export function ProfilePane({ trace, open }: { trace: Trace; open: boolean }) {
  return open && trace.profile ? <ProfileView profile={trace.profile} /> : null;
}

/** Where the trace's time went in code: by package, then as a flame graph of your code or of every frame. */
function ProfileView({ profile }: { profile: Profile }) {
  const [own, setOwn] = useState(() => mostlyYours(profile));
  const [lit, setLit] = useState<string | null>(null);
  const packages = useMemo(() => packageTimes(profile), [profile]);
  const palette = useMemo(() => colors(packages.map((item) => item.name)), [packages]);
  const view = useMemo(() => (own ? ownCode(profile) : allFrames(profile)), [profile, own]);
  const time: Time = (samples) => duration(samples * profile.interval_us);
  return (
    <div className="grid gap-4 p-4">
      <Packages packages={packages} palette={palette} total={profile.samples} time={time} lit={lit} onLight={setLit} />
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
          <Choice on={own} onClick={() => setOwn(true)}>
            Your code
          </Choice>
          <Choice on={!own} onClick={() => setOwn(false)}>
            All frames
          </Choice>
        </div>
        <span className="text-xs text-muted-foreground">
          {profile.samples.toLocaleString()} samples · one every {duration(profile.interval_us)}
        </span>
      </div>
      {/* Keyed: a zoom belongs to the frames it was made in. */}
      <Flame key={String(own)} profile={view} palette={palette} lit={lit} time={time} />
    </div>
  );
}

function Choice({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "rounded-md px-2.5 py-1 text-sm transition-colors",
        on ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** Where the time went by package: a bar of shares, and each package with its time; a click lights its frames. */
function Packages({
  packages,
  palette,
  total,
  time,
  lit,
  onLight,
}: {
  packages: readonly { name: string; samples: number }[];
  palette: Map<string, string>;
  total: number;
  time: Time;
  lit: string | null;
  onLight: (name: string | null) => void;
}) {
  const shown = packages.slice(0, 8);
  return (
    <div className="grid gap-2">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
        {shown.map(({ name, samples }) => (
          <span key={name} className={palette.get(name) ?? REST} style={{ width: `${(samples / total) * 100}%` }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {shown.map(({ name, samples }) => (
          <button
            type="button"
            key={name}
            aria-pressed={lit === name}
            onClick={() => onLight(lit === name ? null : name)}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors",
              lit === name ? "border-foreground/30 bg-accent" : "hover:bg-accent",
            )}
          >
            <span className={cn("size-2 rounded-full", palette.get(name) ?? REST)} />
            <span className="font-mono">{name}</span>
            <span className="text-muted-foreground tabular-nums">
              {Math.round((samples / total) * 100)}% · {time(samples)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** A flame graph from the outermost call down (a click zooms in), and the functions by their time. */
function Flame({
  profile,
  palette,
  lit,
  time,
}: {
  profile: Profile;
  palette: Map<string, string>;
  lit: string | null;
  time: Time;
}) {
  const root = useMemo(() => tree(profile), [profile]);
  const rows = useMemo(() => functions(profile).slice(0, 25), [profile]);
  const [focus, setFocus] = useState<Node>(root);
  const boxes = useMemo(() => layout(focus), [focus]);
  const depth = Math.max(0, ...boxes.map((box) => box.depth)) + 1;
  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        {focus !== root ? (
          <button
            type="button"
            className="justify-self-start text-xs text-brand underline-offset-2 hover:underline"
            onClick={() => setFocus(root)}
          >
            ← Show all
          </button>
        ) : null}
        <div className="relative w-full" style={{ height: depth * (ROW + 1) }} role="img" aria-label="Flame graph">
          {boxes.map((box) => (
            <FlameBox
              key={box.node.key}
              box={box}
              palette={palette}
              lit={lit}
              title={tip(box.node, root.total, time)}
              onZoom={() => setFocus(box.node)}
            />
          ))}
        </div>
      </div>
      <Functions rows={rows} palette={palette} time={time} />
    </div>
  );
}

function tip(at: Node, total: number, time: Time): string {
  const frame = at.frame;
  if (!frame) return "";
  const share = Math.round((at.total / total) * 100);
  return `${frame.function}\n${where(frame)}\n${time(at.total)} (${share}%) · ${time(at.self)} in itself`;
}

/** A box's colors: its package's, faded while another package is lit. */
function boxColors(palette: Map<string, string>, name: string, lit: string | null): string {
  const faded = lit !== null && lit !== name;
  return cn(palette.get(name) ?? REST, faded && "opacity-30");
}

function FlameBox({
  box: { node: at, depth, left, width },
  palette,
  lit,
  title,
  onZoom,
}: {
  box: Box;
  palette: Map<string, string>;
  lit: string | null;
  title: string;
  onZoom: () => void;
}) {
  const frame = at.frame;
  if (!frame) return null;
  return (
    <button
      type="button"
      title={title}
      onClick={onZoom}
      className={cn(
        "absolute truncate rounded-[3px] px-1.5 text-left font-mono text-[11px] leading-[18px] text-foreground transition-opacity",
        boxColors(palette, packageOf(frame), lit),
      )}
      style={{
        top: depth * (ROW + 1),
        left: `calc(${left * 100}% + 1px)`,
        width: `calc(${width * 100}% - 1px)`,
        height: ROW,
      }}
    >
      {width >= LABELLED && frame.function}
    </button>
  );
}

function Functions({
  rows,
  palette,
  time,
}: {
  rows: readonly { frame: Frame; self: number; total: number }[];
  palette: Map<string, string>;
  time: Time;
}) {
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-muted-foreground">
        <tr>
          <th className="py-1 font-medium">Function</th>
          <th className="py-1 text-right font-medium">Itself</th>
          <th className="py-1 text-right font-medium">In all</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ frame, self, total }) => (
          <tr key={`${frame.file}:${frame.line}:${frame.function}`} className="border-t border-border/60">
            <td className="max-w-0 py-1 pr-4">
              <div className="flex min-w-0 items-center gap-2">
                <span className={cn("size-2 shrink-0 rounded-full", palette.get(packageOf(frame)) ?? REST)} />
                <span className="truncate font-mono text-xs">{frame.function}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">{where(frame)}</span>
              </div>
            </td>
            <td className="py-1 text-right text-xs tabular-nums">{self ? time(self) : "—"}</td>
            <td className="py-1 text-right text-xs tabular-nums">{time(total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
