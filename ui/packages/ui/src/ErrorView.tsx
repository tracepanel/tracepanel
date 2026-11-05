import type { ReactNode } from "react";
import { CopyButton } from "./CopyButton";
import { languageOf, tokenizeLines } from "./highlight";
import { ChevronRightIcon } from "./icons";
import { keyed } from "./keys";
import { packagesLine } from "./lib/packages";
import { linkProps, type TraceLinks } from "./links";
import { NameValues } from "./NameValues";
import { DetailsFooter } from "./primitives";
import { TokenLine } from "./Tokens";
import type { ParsedException } from "./traceback";
import type { ChainedError, Frame, Issue, TraceError } from "./types";

type Group = { app: true; frame: Frame } | { app: false; frames: Frame[] };

const frameKey = (frame: Frame): string => `${frame.filename}:${frame.lineno}:${frame.function}`;
const groupKey = (group: Group): string =>
  group.app ? frameKey(group.frame) : `lib:${group.frames.map(frameKey).join("|")}`;

/** Consecutive library frames collapse into one group; project frames stay visible. */
function groups(frames: readonly Frame[]): Group[] {
  const result: Group[] = [];
  for (const frame of frames) {
    const last = result.at(-1);
    if (frame.in_app) result.push({ app: true, frame });
    else if (last && !last.app) last.frames.push(frame);
    else result.push({ app: false, frames: [frame] });
  }
  return result;
}

function Source({ frame }: { frame: Frame }) {
  if (frame.context_start === null || frame.context.length === 0) {
    return <p className="tp-frame-nosource">Source not available.</p>;
  }
  const start = frame.context_start;
  const language = languageOf(frame.filename);
  if (language === null) return <PlainSource frame={frame} start={start} />;
  const lines = tokenizeLines(frame.context, language);
  return (
    <ol className="tp-source" start={start}>
      {lines.map((line, index) => {
        const number = start + index;
        return (
          <li key={number} data-current={number === frame.lineno ? "" : undefined}>
            <span className="tp-source-no">{number}</span>
            <code>
              <TokenLine tokens={line} />
            </code>
          </li>
        );
      })}
    </ol>
  );
}

function PlainSource({ frame, start }: { frame: Frame; start: number }) {
  return (
    <ol className="tp-source" start={start}>
      {keyed(frame.context, (line) => line).map(({ key, item: line }, index) => (
        <li key={key} data-current={start + index === frame.lineno ? "" : undefined}>
          <span className="tp-source-no">{start + index}</span>
          <code>{line || " "}</code>
        </li>
      ))}
    </ol>
  );
}

/** A frame's locals as every list of names and values shows them: a repr laid out and coloured, each one copies. */
function Locals({ locals }: { locals: Record<string, string> }) {
  const rows = Object.entries(locals).map(([name, value]) => ({ name, value }));
  if (rows.length === 0) return null;
  return (
    <section aria-label="Locals" className="border-t bg-background">
      <NameValues rows={rows} />
    </section>
  );
}

/** Whether a frame has anything to open: its source or its locals. */
function hasBody(frame: Frame): boolean {
  return (frame.context_start !== null && frame.context.length > 0) || Boolean(frame.locals);
}

/** A frame with no source or locals: one line, nothing to open. A library's by its module too (Thread.run). */
function BareFrame({ frame }: { frame: Frame }) {
  const name = frame.in_app || !frame.module ? frame.function : `${frame.module}.${frame.function}`;
  return (
    <div className="tp-frame tp-frame-bare" data-app={frame.in_app ? "" : undefined}>
      <span className="tp-frame-fn">{name}</span>
      <code className="tp-frame-loc">
        {frame.filename}:{frame.lineno}
      </code>
    </div>
  );
}

function FrameView({ frame, open }: { frame: Frame; open: boolean }) {
  if (!hasBody(frame)) return <BareFrame frame={frame} />;
  return (
    <details className="tp-frame" data-app={frame.in_app ? "" : undefined} open={open}>
      <summary>
        <ChevronRightIcon />
        <span className="tp-frame-fn">{frame.function}</span>
        <code className="tp-frame-loc">
          {frame.filename}:{frame.lineno}
        </code>
      </summary>
      <Source frame={frame} />
      {frame.locals ? <Locals locals={frame.locals} /> : null}
    </details>
  );
}

/** What a group of library frames is: its packages on one line, every module on hover. */
function GroupNames({ frames }: { frames: readonly Frame[] }) {
  const modules = frames.map((frame) => frame.module);
  return (
    <span className="tp-frame-group-names" title={modules.join("\n")}>
      {packagesLine(modules)}
    </span>
  );
}

function Frames({ frames }: { frames: readonly Frame[] }) {
  // The deepest project frame is where it went wrong: open it.
  const crash = [...frames].reverse().find((frame) => frame.in_app) ?? frames.at(-1);
  return (
    <div className="tp-frames">
      {keyed(groups(frames), groupKey).map(({ key, item: group }) =>
        group.app ? (
          <FrameView key={key} frame={group.frame} open={group.frame === crash} />
        ) : (
          <details key={key} className="tp-frame-group">
            <summary>
              <ChevronRightIcon />
              {group.frames.length} library frame{group.frames.length === 1 ? "" : "s"}
              <GroupNames frames={group.frames} />
            </summary>
            {keyed(group.frames, frameKey).map(({ key: frameId, item: frame }) => (
              <FrameView key={frameId} frame={frame} open={frame === crash} />
            ))}
          </details>
        ),
      )}
    </div>
  );
}

function shortType(type: string): string {
  return type.replace(/^builtins\./, "");
}

function Chained({ error }: { error: ChainedError }) {
  return (
    <section className="tp-chained">
      <p className="tp-chain-relation">{error.relation === "cause" ? "Caused by" : "Raised while handling"}</p>
      <p className="tp-error-type">{shortType(error.type)}</p>
      <p className="tp-error-message">{error.message}</p>
      <Frames frames={error.frames} />
    </section>
  );
}

/** An error's head: its type and message, then what the place adds (handled or not, a link to its issue). */
function ErrorHead({
  type,
  message,
  copy,
  children,
}: {
  type: string;
  message: string;
  /** The error as text, as a traceback prints it: its copy button in the head's corner. */
  copy?: string | undefined;
  children?: ReactNode;
}) {
  return (
    <header className="tp-error-head group/copy relative">
      {copy ? (
        <CopyButton
          text={copy}
          label="Copy the error"
          className="absolute top-2 right-2 opacity-0 transition-opacity group-hover/copy:opacity-100 focus-visible:opacity-100"
        />
      ) : null}
      <p className="tp-error-type">{shortType(type)}</p>
      {message ? <p className="tp-error-message">{message}</p> : null}
      {children}
    </header>
  );
}

/**
 * A log record's exception, read from its traceback: the same head, frames and chain as a trace's error, the app's
 * frames in view and the libraries' folded, without the source and locals a stored error has.
 */
export function ExceptionView({ exception }: { exception: ParsedException }) {
  return (
    <div>
      <ErrorHead type={exception.type} message={exception.message} copy={errorText(exception)}>
        <p className="tp-error-meta">{exception.frames.length} frames · most recent call last</p>
      </ErrorHead>
      <Frames frames={exception.frames} />
      {exception.chain.map((inner, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the chain order is fixed for a record's text.
        <Chained key={index} error={inner} />
      ))}
    </div>
  );
}

/** An error as text: its type and message, its frames most recent call last, then what it was raised from or while. */
function errorText(error: {
  type: string;
  message: string;
  frames: readonly Pick<Frame, "filename" | "lineno" | "function">[];
  chain: readonly ChainedError[];
}): string {
  const lines = (each: { type: string; message: string; frames: typeof error.frames }) => [
    each.message ? `${shortType(each.type)}: ${each.message}` : shortType(each.type),
    ...each.frames.map((frame) => `    at ${frame.function} (${frame.filename}:${frame.lineno})`),
  ];
  const chained = error.chain.flatMap((inner) => [
    "",
    inner.relation === "cause" ? "Caused by:" : "Raised while handling:",
    ...lines(inner),
  ]);
  return [...lines(error), ...chained].join("\n");
}

/** The way from an error to its issue: every time it happened. */
function IssueLink({ links, issue }: { links: TraceLinks | undefined; issue: Issue | undefined }) {
  if (!(links?.issue && issue)) return null;
  return (
    // The way on as every finding's footer has it: an outlined button with its arrow.
    <DetailsFooter
      rule={false}
      open={{ label: "Every time it happened", link: linkProps(links, links.issue(issue.fingerprint, "error")) }}
    />
  );
}

export function ErrorView({
  errors,
  issues = [],
  links,
}: {
  errors: readonly TraceError[];
  /** The trace's error issues, in the same order as its errors: each error links to its own. */
  issues?: readonly Issue[];
  links?: TraceLinks | undefined;
}) {
  if (errors.length === 0) return <p className="tp-note">No errors.</p>;
  return (
    <>
      {keyed(errors, (error) => `${error.time}:${error.type}`).map(({ key, item: error }, index) => (
        <section key={key} className="tp-error">
          <ErrorHead type={error.type} message={error.message} copy={errorText(error)}>
            <p className="tp-error-meta">
              {error.handled ? "Handled" : "Unhandled"} · {error.frames.length} frames · most recent call last
            </p>
            <IssueLink links={links} issue={issues[index]} />
          </ErrorHead>
          <Frames frames={error.frames} />
          {error.chain.map((inner, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the chain order is fixed for a stored error.
            <Chained key={index} error={inner} />
          ))}
        </section>
      ))}
    </>
  );
}
