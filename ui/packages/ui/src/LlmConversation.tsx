import type { ReactNode } from "react";
import { attrsWhere } from "./lib/values";
import { SectionHeading } from "./primitives";
import type { Attrs } from "./types";

// An LLM call's messages, when the app captures them (the Python SDK's capture_llm_content): the system instructions,
// the messages sent and the model's answer, in the GenAI conventions' shape ([{role, parts: [{type, ...}]}]), masked
// as the SDK sent them. A turn at a time, each folded open or shut; a list cut at the SDK's limit is shown as text.
const INPUT = "gen_ai.input.messages";
const OUTPUT = "gen_ai.output.messages";
const SYSTEM = "gen_ai.system_instructions";
const MESSAGE_ATTRS = [INPUT, OUTPUT, SYSTEM];

/** A span's attributes without its messages: shown as a conversation, not again among them. */
export function withoutMessages(attrs: Attrs): Attrs {
  return attrsWhere(attrs, (key) => !MESSAGE_ATTRS.some((name) => key === name || key === `${name}.truncated`));
}

/** A part of a message, as the conventions shape it: its type and what that type has. */
interface Part {
  type?: unknown;
  content?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
  response?: unknown;
  result?: unknown;
}

/** A message: who said it, and its parts. */
interface Message {
  role?: unknown;
  parts?: unknown;
}

/** One turn: its place, who said it, what, and the text when its list was cut and can't be read as one. */
interface Turn {
  id: string;
  role: string;
  parts: Keyed[];
  cut?: string;
}

/** A part and its place in its turn. */
interface Keyed {
  key: string;
  part: Part;
}

function keyed(parts: unknown[]): Keyed[] {
  return parts.map((part, place) => ({ key: String(place), part: part as Part }));
}

function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** The turns of a list of messages; a list cut short, one turn of its text. */
function turnsOf(value: unknown, fallbackRole: string): Turn[] {
  if (value === undefined || value === null) return [];
  const list = parsed(value);
  if (!Array.isArray(list)) return [{ id: `${fallbackRole}-cut`, role: fallbackRole, parts: [], cut: String(value) }];
  return list.map((message: Message, place) => ({
    id: `${fallbackRole}-${place}`,
    role: String(message.role ?? fallbackRole),
    parts: Array.isArray(message.parts) ? keyed(message.parts) : [],
  }));
}

/** The system instructions: a list of parts, one turn. */
function systemTurn(value: unknown): Turn[] {
  if (value === undefined || value === null) return [];
  const parts = parsed(value);
  return Array.isArray(parts)
    ? [{ id: "system", role: "system", parts: keyed(parts) }]
    : [{ id: "system", role: "system", parts: [], cut: String(value) }];
}

const ROLES: Record<string, string> = { system: "System", user: "User", assistant: "Assistant", tool: "Tool" };

function json(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** Text as written; a model's reasoning dimmed. */
function TextPart({ part }: { part: Part }) {
  return (
    <p className="dt-llm-text" data-part={String(part.type)}>
      {String(part.content ?? "")}
    </p>
  );
}

/** A tool the model called, with its arguments: `→ get_weather({"city": "Oslo"})`. */
function ToolCallPart({ part }: { part: Part }) {
  return (
    <pre className="dt-llm-code">
      <b>→ {String(part.name ?? "tool")}</b>({json(part.arguments ?? {})})
    </pre>
  );
}

/** A tool's answer, sent back to the model. */
function ToolResponsePart({ part }: { part: Part }) {
  return (
    <pre className="dt-llm-code">
      <b>← {String(part.id ?? "tool")}</b> {json(part.response ?? part.result ?? "")}
    </pre>
  );
}

/** Any other part (an image, a file, a provider's own), as its JSON. */
function OtherPart({ part }: { part: Part }) {
  return <pre className="dt-llm-code">{json(part)}</pre>;
}

/** How each type of part reads, by the type as the conventions write it. */
const PARTS = new Map<string, (props: { part: Part }) => ReactNode>([
  ["text", TextPart],
  ["reasoning", TextPart],
  ["tool_call", ToolCallPart],
  ["tool_call_response", ToolResponsePart],
]);

/** A part as it reads: text as written, a tool call with its arguments, a tool's answer, anything else as JSON. */
function PartView({ part }: { part: Part }) {
  const Shown = PARTS.get(String(part.type)) ?? OtherPart;
  return <Shown part={part} />;
}

/** What a folded turn says: its first text, or what it called. */
function preview(turn: Turn): string {
  if (turn.cut !== undefined) return turn.cut;
  const text = turn.parts.find(({ part }) => typeof part.content === "string")?.part.content;
  if (typeof text === "string") return text;
  const calls = turn.parts.filter(({ part }) => part.type === "tool_call").map(({ part }) => String(part.name));
  return calls.length ? `→ ${calls.join(", ")}` : "";
}

function TurnView({ turn, open }: { turn: Turn; open: boolean }) {
  return (
    <details className="dt-llm-turn" data-role={turn.role} open={open}>
      <summary>
        <span className="dt-llm-role">{ROLES[turn.role] ?? turn.role}</span>
        <span className="dt-llm-preview">{preview(turn)}</span>
      </summary>
      <div className="dt-llm-parts">
        {turn.cut !== undefined ? (
          <>
            <pre className="dt-llm-code">{turn.cut}</pre>
            <p className="text-xs text-muted-foreground">Cut at the SDK's limit (max_body_kb): not whole JSON.</p>
          </>
        ) : (
          turn.parts.map(({ key, part }) => <PartView key={key} part={part} />)
        )}
      </div>
    </details>
  );
}

/**
 * The conversation of an LLM call: the system instructions, the messages sent, the answer, a turn each. The last
 * messages sent and the answer are open; the earlier ones (a long history) folded. Nothing when it wasn't captured.
 */
export function LlmConversation({ attrs }: { attrs: Attrs }): ReactNode {
  const sent = [...systemTurn(attrs[SYSTEM]), ...turnsOf(attrs[INPUT], "user")];
  const answer = turnsOf(attrs[OUTPUT], "assistant");
  if (!sent.length && !answer.length) return null;
  return (
    <section className="grid gap-2" aria-label="Conversation">
      <SectionHeading>
        Conversation{" "}
        <span className="text-xs font-normal text-muted-foreground tabular-nums">{sent.length + answer.length}</span>
      </SectionHeading>
      <div className="dt-llm-turns">
        {sent.map((turn) => (
          <TurnView key={turn.id} turn={turn} open={turn === sent.at(-1)} />
        ))}
        {answer.map((turn) => (
          <TurnView key={turn.id} turn={turn} open={true} />
        ))}
      </div>
    </section>
  );
}
