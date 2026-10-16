import { languageOf, tokenizeLines } from "./highlight";
import { ChevronRightIcon } from "./icons";
import { keyed } from "./keys";
import { linkProps, type TraceLinks } from "./links";
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
    return <p className="dt-frame-nosource">Source not available.</p>;
  }
  const start = frame.context_start;
  const language = languageOf(frame.filename);
  if (language === null) return <PlainSource frame={frame} start={start} />;
  const lines = tokenizeLines(frame.context, language);
  return (
    <ol className="dt-source" start={start}>
      {lines.map((line, index) => {
        const number = start + index;
        return (
          <li key={number} data-current={number === frame.lineno ? "" : undefined}>
            <span className="dt-source-no">{number}</span>
            <code>
              {line.length === 0
                ? " "
                : keyed(line, (token) => token.text).map(({ key, item: token }) =>
                    token.type === "plain" ? (
                      <span key={key}>{token.text}</span>
                    ) : (
                      <span key={key} className={`token ${token.type}`}>
                        {token.text}
                      </span>
                    ),
                  )}
            </code>
          </li>
        );
      })}
    </ol>
  );
}

function PlainSource({ frame, start }: { frame: Frame; start: number }) {
  return (
    <ol className="dt-source" start={start}>
      {keyed(frame.context, (line) => line).map(({ key, item: line }, index) => (
        <li key={key} data-current={start + index === frame.lineno ? "" : undefined}>
          <span className="dt-source-no">{start + index}</span>
          <code>{line || " "}</code>
        </li>
      ))}
    </ol>
  );
}

function Locals({ locals }: { locals: Record<string, string> }) {
  const entries = Object.entries(locals);
  if (entries.length === 0) return null;
  return (
    <dl className="dt-locals">
      {entries.map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>
            <code>{value}</code>
          </dd>
        </div>
      ))}
    </dl>
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
    <div className="dt-frame dt-frame-bare" data-app={frame.in_app ? "" : undefined}>
      <span className="dt-frame-fn">{name}</span>
      <code className="dt-frame-loc">
        {frame.filename}:{frame.lineno}
      </code>
    </div>
  );
}

function FrameView({ frame, open }: { frame: Frame; open: boolean }) {
  if (!hasBody(frame)) return <BareFrame frame={frame} />;
  return (
    <details className="dt-frame" data-app={frame.in_app ? "" : undefined} open={open}>
      <summary>
        <ChevronRightIcon />
        <span className="dt-frame-fn">{frame.function}</span>
        <code className="dt-frame-loc">
          {frame.filename}:{frame.lineno}
        </code>
      </summary>
      <Source frame={frame} />
      {frame.locals ? <Locals locals={frame.locals} /> : null}
    </details>
  );
}

function Frames({ frames }: { frames: readonly Frame[] }) {
  // The deepest project frame is where it went wrong: open it.
  const crash = [...frames].reverse().find((frame) => frame.in_app) ?? frames.at(-1);
  return (
    <div className="dt-frames">
      {keyed(groups(frames), groupKey).map(({ key, item: group }) =>
        group.app ? (
          <FrameView key={key} frame={group.frame} open={group.frame === crash} />
        ) : (
          <details key={key} className="dt-frame-group">
            <summary>
              <ChevronRightIcon />
              {group.frames.length} library frame{group.frames.length === 1 ? "" : "s"}
              <span className="dt-frame-group-names">{group.frames.map((frame) => frame.module).join(" · ")}</span>
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
    <section className="dt-chained">
      <p className="dt-chain-relation">{error.relation === "cause" ? "Caused by" : "Raised while handling"}</p>
      <p className="dt-error-type">{shortType(error.type)}</p>
      <p className="dt-error-message">{error.message}</p>
      <Frames frames={error.frames} />
    </section>
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
  if (errors.length === 0) return <p className="dt-note">No errors.</p>;
  return (
    <>
      {keyed(errors, (error) => `${error.time}:${error.type}`).map(({ key, item: error }, index) => (
        <section key={key} className="dt-error">
          <header className="dt-error-head">
            <p className="dt-error-type">{shortType(error.type)}</p>
            <p className="dt-error-message">{error.message}</p>
            <p className="dt-error-meta">
              {error.handled ? "Handled" : "Unhandled"} · {error.frames.length} frames · most recent call last
            </p>
            {links?.issue && issues[index] ? (
              <a className="dt-issue-link" {...linkProps(links, links.issue(issues[index].fingerprint, "error"))}>
                Every time it happened →
              </a>
            ) : null}
          </header>
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
