import { ChevronRightIcon } from "./icons";
import { keyed } from "./keys";
import type { ChainedError, Frame, TraceError } from "./types";

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

function FrameView({ frame, open }: { frame: Frame; open: boolean }) {
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

export function ErrorView({ errors }: { errors: readonly TraceError[] }) {
  if (errors.length === 0) return <p className="dt-note">No errors.</p>;
  return (
    <>
      {keyed(errors, (error) => `${error.time}:${error.type}`).map(({ key, item: error }) => (
        <section key={key} className="dt-error">
          <header className="dt-error-head">
            <p className="dt-error-type">{shortType(error.type)}</p>
            <p className="dt-error-message">{error.message}</p>
            <p className="dt-error-meta">
              {error.handled ? "Handled" : "Unhandled"} · {error.frames.length} frames · most recent call last
            </p>
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
