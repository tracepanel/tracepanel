// An LLM call's numbers as the console says them: its tokens, its estimated cost, its provider's name. The agent
// writes each call's cost (`tracepanel.cost_usd`) from its tokens and a table of list prices: an estimate, said so.
import type { Span } from "../types";

type Attrs = Readonly<Record<string, unknown>>;

/** The attribute the agent writes a call's estimated cost into, in US dollars. */
export const COST = "tracepanel.cost_usd";

/** A call's tokens, as the GenAI conventions count them: the input's include the cached and the written. */
export interface Usage {
  input: number;
  output: number;
  cached: number;
  written: number;
  reasoning: number;
}

function count(attrs: Attrs, key: string): number {
  const value = attrs[key];
  return typeof value === "number" ? value : 0;
}

/** A call's tokens; none when it reported none (it failed, its stream was closed early). */
export function usageOf(attrs: Attrs): Usage | null {
  if (attrs["gen_ai.usage.input_tokens"] === undefined && attrs["gen_ai.usage.output_tokens"] === undefined) {
    return null;
  }
  return {
    input: count(attrs, "gen_ai.usage.input_tokens"),
    output: count(attrs, "gen_ai.usage.output_tokens"),
    cached: count(attrs, "gen_ai.usage.cache_read.input_tokens"),
    written: count(attrs, "gen_ai.usage.cache_write.input_tokens"),
    reasoning: count(attrs, "gen_ai.usage.reasoning.output_tokens"),
  };
}

/** "1,234": a count of tokens, grouped. */
export function tokens(value: number): string {
  return value.toLocaleString("en-US");
}

/** "12 in · 5 out · 4 cached · 3 reasoning": what a call's tokens were; the detailed ones only when there are some. */
export function usageText(usage: Usage): string {
  return [
    `${tokens(usage.input)} in`,
    `${tokens(usage.output)} out`,
    usage.cached ? `${tokens(usage.cached)} cached` : "",
    usage.written ? `${tokens(usage.written)} written to cache` : "",
    usage.reasoning ? `${tokens(usage.reasoning)} reasoning` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A call's estimated cost, when its model has a price. */
export function costOf(attrs: Attrs): number | null {
  const cost = attrs[COST];
  return typeof cost === "number" ? cost : null;
}

/**
 * An estimated cost as the console says it, marked as one: "~$0.0123", "~$1.25"; under a hundredth of a cent,
 * "<$0.0001".
 */
export function money(cost: number): string {
  if (cost === 0) return "$0";
  if (cost < 0.0001) return "<$0.0001";
  if (cost < 1) return `~$${Number(cost.toPrecision(3))}`;
  return `~$${cost.toFixed(2)}`;
}

/** What an estimate is made from, for its tooltip. */
export const ESTIMATE = "An estimate: the tokens at the model's list price, as the agent's price table has it";

/** Providers by their names in the GenAI conventions, as the console says them. */
const PROVIDERS = new Map([
  ["openai", "OpenAI"],
  ["anthropic", "Anthropic"],
  ["azure.ai.openai", "Azure OpenAI"],
  ["aws.bedrock", "Amazon Bedrock"],
  ["gcp.gemini", "Gemini"],
  ["gcp.vertex_ai", "Vertex AI"],
  ["mistral_ai", "Mistral AI"],
  ["cohere", "Cohere"],
  ["groq", "Groq"],
  ["deepseek", "DeepSeek"],
  ["x_ai", "xAI"],
  ["perplexity", "Perplexity"],
  ["ollama", "Ollama"],
]);

/** A provider by its name, `openai` as OpenAI; one the console doesn't know as sent. */
export function providerName(provider: string): string {
  return PROVIDERS.get(provider) ?? provider;
}

/** "1,234 tokens · ~$0.0123": a trace's LLM calls' tokens and estimated cost, after their count and time. */
export function llmFacts(spans: readonly Span[]): string | null {
  const used = spans.map((span) => usageOf(span.attrs)).filter((usage): usage is Usage => usage !== null);
  if (!used.length) return null;
  const total = used.reduce((sum, usage) => sum + usage.input + usage.output, 0);
  const costs = spans.map((span) => costOf(span.attrs)).filter((cost): cost is number => cost !== null);
  const cost = costs.length ? money(costs.reduce((sum, each) => sum + each, 0)) : null;
  return [`${tokens(total)} tokens`, cost].filter(Boolean).join(" · ");
}
