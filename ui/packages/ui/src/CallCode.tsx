import { FlameIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import type { CodeOwner, RowContext } from "./CallRowParts";
import { partOfCategory } from "./callTree";
import { Hint } from "./Hint";
import type { Category } from "./lib/breakdown";
import { widthOf } from "./lib/percent";
import { hottestOwn, type Profile, WAITING } from "./lib/profile";
import type { Quiet } from "./lib/quiet";
import { overlaps, type Windows } from "./lib/slice";
import { splitOf, wholeWindows } from "./lib/split";
import { spanSegments, splitByProfile } from "./lib/timeShares";
import {
  bucketOwners,
  ownedWindows,
  type Piece,
  type Timed,
  timed,
  waitName,
  waitPlace,
  windowsOf,
} from "./lib/waiting";
import { windowProfile } from "./lib/windowProfile";
import { RowFlame } from "./ProfileHint";
import { KindBadge, TaskName } from "./primitives";
import type { Span, Trace } from "./types";
import { useAxis } from "./Waterfall";
import { preferCategory, spanWord } from "./WaterfallDetails";

/** A code row shows unless other shares are picked, or a range it doesn't overlap. */
function codeShown(quiet: Quiet, category: Category, ctx: RowContext): boolean {
  const { parts, range } = ctx.slice;
  if (parts.length > 0 && !parts.includes(partOfCategory(category))) return false;
  return range === null || quiet.gaps.some(([from, to]) => overlaps(range, from - ctx.trace.start, to - from));
}

/**
 * A code row's pieces of time: where it waited, or where its code ran (µs since the trace started; the trace's
 * segments, lib/timeShares), and their time: the time of the profile they open.
 */
interface CodePart {
  waiting: boolean;
  pieces: Piece[];
  total: number;
  /** Its time written, as its stretch's profile writes it (lib/split). */
  time: string;
}

/** The stretches a code row opens the profile at: its pieces in whole µs, as the link carries them. */
function stretchesOf(pieces: readonly Piece[]): Windows {
  return wholeWindows(windowsOf(pieces));
}

/** A span's own time in pieces: its segments, those that meet with the same part (waited or ran) as one. */
function ownPieces(trace: Trace, span: string): Piece[] {
  const pieces: Piece[] = [];
  for (const segment of spanSegments(trace, span)) {
    const waiting = segment.share === WAITING;
    const last = pieces.at(-1);
    if (last && last.waiting === waiting && Math.abs(last.to - segment.from) < 0.5) last.to = segment.to;
    else pieces.push({ from: segment.from, to: segment.to, waiting });
  }
  return pieces;
}

/** A span's own code in its parts: what it waited in and what it computed in, each when there is any. */
function codeParts(span: string, quiet: Quiet, trace: Trace): CodePart[] {
  const pieces = ownPieces(trace, span);
  const parts = [true, false].flatMap((waiting): CodePart[] => {
    const own = pieces.filter((piece) => piece.waiting === waiting);
    const { total, time } = piecesTime(trace, own);
    return total > 0 ? [{ waiting, pieces: own, total, time }] : [];
  });
  return parts.every((part) => partShows(part, quiet, trace)) ? parts : [oneOf(trace, parts, pieces)];
}

/**
 * The time of a code row's pieces: its stretches' split's (lib/split), what the profile it opens says of them, its
 * head and its bar.
 */
function piecesTime(trace: Trace, pieces: readonly Piece[]): { total: number; time: string } {
  const stretches = stretchesOf(pieces);
  if (!stretches.length) return { total: 0, time: "" };
  const split = splitOf(trace, stretches);
  return { total: split.total, time: split.time };
}

/** A wait or a stretch of code on a row of its own: as long as the code's own time is said at all, of the time. */
const PART_MIN_US = 5_000;

const PART_MIN_SHARE = 0.2;

const PART_MIN_TRACE_SHARE = 0.05;

/**
 * Whether a part of a span's own time stands on its own: at least 5 ms, and a fifth of that time or a twentieth of
 * the trace's. A few ms of framework glue beside a long wait is part of the wait, not a row of its own.
 */
function partShows(part: CodePart, quiet: Quiet, trace: Trace): boolean {
  if (part.total < PART_MIN_US) return false;
  return part.total >= quiet.total * PART_MIN_SHARE || part.total >= trace.duration * PART_MIN_TRACE_SHARE;
}

/** The parts as one row: what most of it was (waited or computed), all of its time, every piece on its bar. */
function oneOf(trace: Trace, parts: readonly CodePart[], pieces: Piece[]): CodePart {
  const most = [...parts].sort((a, b) => b.total - a.total)[0];
  return { waiting: most?.waiting ?? false, pieces, ...piecesTime(trace, pieces) };
}

/** Where its code ran with nothing recorded inside, hatched in its share's colour; pieces too thin to see left out. */
function CodeBars({
  part,
  category,
  trace,
  owner,
}: {
  part: CodePart;
  category: Category;
  trace: Trace;
  owner: Trace;
}) {
  // On the axis the rows are drawn on (the waterfall's), else the trace's own time.
  const axis = useAxis(trace);
  const total = Math.max(axis.duration, 1);
  // A call's trace's pieces are of its own time: on this trace's from where it starts on this one's clock.
  const offset = owner.start - axis.start;
  return (
    <span className="dt-map-track" aria-hidden="true">
      {part.pieces
        // A piece too short to see is left out (a hundredth of a percent of the axis, as the old tree's 0.4% of its
        // own trace hid the short pieces of a call's trace on a page's longer axis).
        .filter((piece) => piece.to - piece.from >= total * 0.0001)
        .map((piece) => {
          // A piece begun before the axis does: the part on it.
          const from = Math.max(piece.from + offset, 0);
          const to = piece.to + offset;
          if (to <= from) return null;
          return (
            <span
              key={piece.from}
              className="dt-map-bar"
              data-quiet=""
              data-waiting={piece.waiting ? "" : undefined}
              data-category={category}
              style={{ left: widthOf(from, total), width: widthOf(to - from, total) }}
            />
          );
        })}
    </span>
  );
}

/**
 * What a code row is: with a profile, the functions of yours that ran most in that stretch (or what it waited on);
 * without one, untraced code, waiting where the profile can't say.
 */
function partName(part: CodePart, code: CodeOwner, span: string): { name: string; yours: boolean } {
  const profile = partProfile(part, code, span);
  if (part.waiting) return waited(profile);
  const name = profile ? ranMost(profile) : UNTRACED;
  return { name, yours: name !== UNTRACED };
}

const UNTRACED = "untraced code";

const OWNERS = new WeakMap<CodeOwner, Map<number, string>>();

/** Whose code row each bucket of the owner's profile is (see bucketOwners); one map per owner. */
function ownersOf(code: CodeOwner, profile: Timed): Map<number, string> {
  let owners = OWNERS.get(code);
  if (!owners) {
    const gaps = new Map([...code.quiet].map(([id, quiet]) => [id, quiet.gaps] as const));
    owners = bucketOwners(profile, gaps, code.trace.start);
    OWNERS.set(code, owners);
  }
  return owners;
}

/**
 * The profile a code row is named by: of its own pieces' time only, not of the rows between them (a handler's code
 * before its transaction and after the commit, not the transaction's), and of the buckets that are its code's more
 * than another row's. The whole trace's where the profile doesn't say when.
 */
function partProfile(part: CodePart, code: CodeOwner, span: string): Profile | undefined {
  const trace = code.trace;
  if (!splitByProfile(trace)) return trace.profile;
  const { profile } = trace;
  const windows = timed(profile) ? ownedWindows(profile, part.pieces, ownersOf(code, profile), span) : null;
  return windowProfile(trace, windows ? wholeWindows(windows) : stretchesOf(part.pieces));
}

/** Where a wait row waited, said quietly after its name: "handlers.py:108", where the profile says. */
function WaitPlace({ part, code, span }: { part: CodePart; code: CodeOwner; span: string }) {
  const profile = partProfile(part, code, span);
  const place = part.waiting && profile ? waitPlace(profile) : null;
  return place ? <span className="dt-map-sub">{place}</span> : null;
}

/**
 * "asyncio.sleep in send_digest": what the code waited on, or just waiting where the profile can't say; yours when
 * a function of yours waited.
 */
function waited(profile: Profile | undefined): { name: string; yours: boolean } {
  const wait = profile ? waitName(profile) : null;
  return wait ?? { name: "waiting", yours: false };
}

/**
 * "editDistance in (*App).similar": the function of yours that ran most, and the function of yours that called it
 * there (its parent in the samples, as the flame graph draws it); untraced code where none of yours ran.
 */
function ranMost(profile: Profile): string {
  const hottest = hottestOwn(profile);
  if (!hottest) return UNTRACED;
  return hottest.caller ? `${hottest.name} in ${hottest.caller}` : hottest.name;
}

/** A code row's own: a grey box ("code", or "wait"), its name, the way on to the profile, its bars and its time. */
function CodeRowParts({ span, ctx, depth, part }: { span: Span; ctx: RowContext; depth: number; part: CodePart }) {
  const category = ctx.categories.get(span.id) ?? "code";
  const owner = ctx.code.trace;
  const { name, yours } = partName(part, ctx.code, span.id);
  return (
    <>
      <span className="dt-map-name" style={indentOf(depth)}>
        <span className="dt-map-caret" />
        <KindBadge
          kind={part.waiting ? "wait" : "code"}
          muted={true}
          className={part.waiting ? "dt-map-kind dt-map-wait" : "dt-map-kind"}
        />
        <UntracedHint name={name} code={ctx.code}>
          <TaskName name={name} className={yours ? "dt-map-text" : "dt-map-text dt-map-lib"} />
        </UntracedHint>
        <WaitPlace part={part} code={ctx.code} span={span.id} />
        <RowFlame trace={owner} />
      </span>
      <CodeBars part={part} category={category} trace={ctx.trace} owner={owner} />
      <span className="dt-map-time">{part.time}</span>
    </>
  );
}

/** On untraced code of a trace without a profile, where the app can profile, on hover: how to see what ran there. */
function UntracedHint({ name, code, children }: { name: string; code: CodeOwner; children: ReactNode }) {
  if (name !== UNTRACED || !code.profiles || code.trace.profile) return children;
  return (
    <Hint
      title="Untraced code"
      detail={
        <>
          Your code between the spans here. To see which of your functions ran, profile the request with the{" "}
          <FlameIcon className="inline size-3.5 align-[-2px]" aria-label="flame" /> in the panel.
        </>
      }
      side="top"
    >
      <span className="flex min-w-0">{children}</span>
    </Hint>
  );
}

/**
 * Under a span whose children leave much of its time uncovered (the strip's hatched stretches, the same time): its
 * own code, a row of its own, and where the profile says it waited, a "waiting" row before it. With a profile, a
 * click opens it at that time and what ran shows on hover; where the app profiles on request, how to get one. Not a
 * span: no details, no filter counts it.
 */
export function CodeRow({ span, ctx, depth }: { span: Span; ctx: RowContext; depth: number }) {
  if (!hasCodeRow(span, ctx)) return null;
  const parts = codeParts(span.id, ctx.code.quiet.get(span.id) as Quiet, ctx.code.trace);
  return (
    <>
      {parts.map((part) => (
        <CodePartRow key={String(part.waiting)} span={span} ctx={ctx} depth={depth} part={part} />
      ))}
    </>
  );
}

function CodePartRow({ span, ctx, depth, part }: { span: Span; ctx: RowContext; depth: number; part: CodePart }) {
  const inside = <CodeRowParts span={span} ctx={ctx} depth={depth} part={part} />;
  const open = ctx.code.onProfile;
  // With a profile, a click opens it at that stretch; without, a plain row.
  return open ? (
    <button
      type="button"
      className="dt-map-row"
      data-kind="code"
      data-category={codeCategory(span, ctx)}
      // Says where it leads: a code row of a call's trace opens that trace, not a tab of this one.
      title={
        ctx.code.trace.id === ctx.trace.id
          ? "Open the profile at this stretch"
          : "Open the profile of the trace that served this call, at this stretch"
      }
      onClick={() => {
        preferCategory(spanWord(span, ctx.trace), "profile");
        open(stretchesOf(part.pieces));
      }}
    >
      {inside}
    </button>
  ) : (
    // Without a profile, its span's: a click selects the span whose own time it is.
    <button
      type="button"
      className="dt-map-row"
      data-kind="code"
      data-category={codeCategory(span, ctx)}
      title="Your code between this span's children: the span's details"
      onClick={() => ctx.onSelect(span.id)}
    >
      {inside}
    </button>
  );
}

/** A code row's share: its span's, or your code's. */
function codeCategory(span: Span, ctx: RowContext): Category {
  return ctx.categories.get(span.id) ?? "code";
}

/** Whether a span has a code row: its code ran long with nothing recorded inside, and what is picked keeps it. */
function hasCodeRow(span: Span, ctx: RowContext): boolean {
  const quiet = ctx.code.quiet.get(span.id);
  return quiet !== undefined && codeShown(quiet, ctx.categories.get(span.id) ?? "code", ctx);
}

/** How far in a row's name starts, and how many guides of the rows it hangs under it draws (styles.css). */
export function indentOf(depth: number): CSSProperties {
  return { paddingLeft: `${12 + depth * 16}px`, "--dt-depth": depth } as CSSProperties;
}
