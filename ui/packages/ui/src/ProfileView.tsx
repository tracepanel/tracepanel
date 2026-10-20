import { useMemo, useState } from "react";
import { duration } from "./format";
import { cn } from "./lib/utils";
import type { Trace } from "./types";

type Profile = NonNullable<Trace["profile"]>;
type Frame = Profile["frames"][number];

/** A function as the stacks reached it: its samples (here and below), its own, and the functions it called. */
interface Node {
  frame: Frame | null;
  key: string;
  total: number;
  self: number;
  children: Map<number, Node>;
}

function node(frame: Frame | null, key: string): Node {
  return { frame, key, total: 0, self: 0, children: new Map() };
}

const OUTSIDE: Frame = {
  function: "(outside your code)",
  module: null,
  file: "",
  line: 0,
  // biome-ignore lint/style/useNamingConvention: wire format.
  in_app: false,
};

/** The same stacks, merged where they are now alike. */
function merged(profile: Profile, frames: Frame[], stacks: { frames: number[]; count: number }[]): Profile {
  const counts = new Map<string, { frames: number[]; count: number }>();
  for (const stack of stacks) {
    const key = stack.frames.join(",");
    const found = counts.get(key);
    if (found) found.count += stack.count;
    else counts.set(key, { ...stack });
  }
  return { ...profile, frames, stacks: [...counts.values()] };
}

/** The project's own frames alone: library time counts toward the call of yours it ran under. */
function ownCode(profile: Profile): Profile {
  const outside = profile.frames.length;
  const stacks = profile.stacks.map((stack) => {
    const own = stack.frames.filter((index) => profile.frames[index]?.in_app);
    return { frames: own.length ? own : [outside], count: stack.count };
  });
  return merged(profile, [...profile.frames, OUTSIDE], stacks);
}

/** Frames kept above the first of the project's own, out of what every stack starts with: the middleware around it. */
const CONTEXT = 3;

/** Every frame, less the library frames every stack starts with (the server, the thread) but the last few. */
function allFrames(profile: Profile): Profile {
  const [first, ...rest] = profile.stacks;
  if (!first) return profile;
  const shared = rest.reduce(
    (length, stack) => Math.min(length, commonLength(first.frames, stack.frames)),
    first.frames.length,
  );
  const library = first.frames.slice(0, shared).findIndex((index) => profile.frames[index]?.in_app);
  const cut = Math.max(0, (library === -1 ? shared : library) - CONTEXT);
  const stacks = profile.stacks.map((stack) => ({ frames: stack.frames.slice(cut), count: stack.count }));
  return merged(profile, profile.frames, stacks);
}

function commonLength(a: readonly number[], b: readonly number[]): number {
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at += 1;
  return at;
}

/** A node's child for a frame, made the first time the path reaches it. */
function child(at: Node, index: number, profile: Profile): Node {
  const found = at.children.get(index);
  if (found) return found;
  const made = node(profile.frames[index] ?? null, `${at.key}/${index}`);
  at.children.set(index, made);
  return made;
}

/** The stacks merged into one tree from the outermost frame in: a call path is one node however often it was seen. */
function tree(profile: Profile): Node {
  const root = node(null, "root");
  for (const stack of profile.stacks) {
    root.total += stack.count;
    const leaf = stack.frames.reduce((at, index) => {
      const next = child(at, index, profile);
      next.total += stack.count;
      return next;
    }, root);
    leaf.self += stack.count;
  }
  return root;
}

/** Each function's samples: its own (it was running) and in all (it or what it called was), each stack counted once. */
function functions(profile: Profile): { frame: Frame; self: number; total: number }[] {
  const self = new Map<number, number>();
  const total = new Map<number, number>();
  const add = (counts: Map<number, number>, index: number, samples: number) =>
    counts.set(index, (counts.get(index) ?? 0) + samples);
  for (const stack of profile.stacks) {
    // The innermost frame was running; every frame of the stack, counted once, was on it.
    add(self, stack.frames[stack.frames.length - 1] ?? -1, stack.count);
    for (const index of new Set(stack.frames)) add(total, index, stack.count);
  }
  return [...total.entries()]
    .flatMap(([index, samples]) => {
      const frame = profile.frames[index];
      return frame ? [{ frame, self: self.get(index) ?? 0, total: samples }] : [];
    })
    .sort((a, b) => b.self - a.self || b.total - a.total);
}

/** A row of boxes per depth, each as wide as its share of the focused node's samples. */
interface Box {
  node: Node;
  depth: number;
  left: number;
  width: number;
}

function layout(focus: Node): Box[] {
  const boxes: Box[] = [];
  const place = (at: Node, depth: number, left: number) => {
    let x = left;
    for (const child of [...at.children.values()].sort((a, b) => b.total - a.total)) {
      const width = child.total / focus.total;
      // Narrower than a pixel or so is noise at any width.
      if (width >= 0.002) {
        boxes.push({ node: child, depth, left: x, width });
        place(child, depth + 1, x);
      }
      x += width;
    }
  };
  place(focus, 0, 0);
  return boxes;
}

function where(frame: Frame): string {
  return `${frame.file}:${frame.line}`;
}

const ROW = 22;

/** The Profile tab's content, when it is the tab open and the trace has a profile. */
export function ProfilePane({ trace, open }: { trace: Trace; open: boolean }) {
  return open && trace.profile ? <ProfileView profile={trace.profile} /> : null;
}

/** Where the trace's time went in code: your own code by default, every frame when asked. */
function ProfileView({ profile }: { profile: Profile }) {
  const [own, setOwn] = useState(true);
  const view = useMemo(() => (own ? ownCode(profile) : allFrames(profile)), [profile, own]);
  const choice = (mine: boolean, label: string) => (
    <button
      type="button"
      aria-pressed={own === mine}
      onClick={() => setOwn(mine)}
      className={cn(
        "rounded-md px-2.5 py-1 text-sm",
        own === mine ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="grid gap-3 p-4">
      <div className="flex items-center gap-1">
        {choice(true, "Your code")}
        {choice(false, "All frames")}
      </div>
      {/* Keyed: a zoom belongs to the frames it was made in. */}
      <Flame key={String(own)} profile={view} />
    </div>
  );
}

/** A flame graph from the outermost call down, and the functions by their time. */
function Flame({ profile }: { profile: Profile }) {
  const root = useMemo(() => tree(profile), [profile]);
  const rows = useMemo(() => functions(profile).slice(0, 30), [profile]);
  const [focus, setFocus] = useState<Node>(root);
  const boxes = useMemo(() => layout(focus), [focus]);
  const depth = Math.max(0, ...boxes.map((box) => box.depth)) + 1;
  const time = (samples: number) => duration(samples * profile.interval_us);
  return (
    <div className="grid gap-5 p-4">
      <p className="text-sm text-muted-foreground">
        {profile.samples.toLocaleString()} samples, one every {duration(profile.interval_us)}: about{" "}
        {time(profile.samples)} of code seen running. Your code is in color, the rest gray.
        {focus !== root ? (
          <>
            {" "}
            <button
              type="button"
              className="text-brand underline-offset-2 hover:underline"
              onClick={() => setFocus(root)}
            >
              Show all
            </button>
          </>
        ) : null}
      </p>
      <div
        className="relative w-full overflow-hidden rounded-md border bg-card"
        style={{ height: depth * ROW }}
        role="img"
        aria-label="Flame graph of the trace's samples"
      >
        {boxes.map(({ node: at, depth: row, left, width }) => {
          const frame = at.frame;
          if (!frame) return null;
          return (
            <button
              type="button"
              key={at.key}
              title={`${frame.function} · ${where(frame)}\n${time(at.total)} (${Math.round((at.total / root.total) * 100)}%), ${time(at.self)} in itself`}
              onClick={() => setFocus(at)}
              className={cn(
                "absolute truncate border-r border-b border-card px-1.5 text-left font-mono text-xs leading-[22px]",
                frame.in_app
                  ? "bg-brand/25 text-foreground hover:bg-brand/40"
                  : "bg-muted text-muted-foreground hover:bg-muted/70",
              )}
              style={{ top: row * ROW, left: `${left * 100}%`, width: `${width * 100}%`, height: ROW }}
            >
              {frame.function}
            </button>
          );
        })}
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="py-1.5 font-medium">Function</th>
            <th className="py-1.5 text-right font-medium">Itself</th>
            <th className="py-1.5 text-right font-medium">In all</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ frame, self, total }) => (
            <tr key={`${frame.file}:${frame.line}:${frame.function}`} className="border-t">
              <td className="max-w-0 py-1.5 pr-4">
                <div className={cn("truncate font-mono", frame.in_app ? "text-foreground" : "text-muted-foreground")}>
                  {frame.function}
                </div>
                <div className="truncate font-mono text-xs text-muted-foreground">{where(frame)}</div>
              </td>
              <td className="py-1.5 text-right tabular-nums">{self ? time(self) : "—"}</td>
              <td className="py-1.5 text-right tabular-nums">{time(total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
