//! LLM calls: what an app asks a model through a provider's API (OpenAI, Anthropic…), an `llm` span each, `chat
//! gpt-5`, with OpenTelemetry's GenAI attributes: the provider (`gen_ai.provider.name`), the operation
//! (`gen_ai.operation.name`: chat, text_completion, generate_content, embeddings), the model asked for and the one that
//! answered, why it stopped, the tokens it used (`gen_ai.usage.*`, the input's count with what the prompt cache served
//! or stored), its time to first chunk, the tools it called and, when the app captures them, the messages.
//!
//! SDKs that predate the kind send each call as a `function` span with `gen_ai.operation.name`: it becomes an `llm`
//! span here, as an OpenTelemetry instrumentation's model call does in `otel`. Each call gets its cost, an estimate
//! from its tokens and a table of list prices (`llm-prices.json`, overridable), in `tracepanel.cost_usd`: the console
//! shows it, the store sums it.

use super::text;
use serde_json::Value;
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::sync::{LazyLock, OnceLock};
use tracepanel_protocol::{Attrs, Received, Span};

/// The span kind of an LLM call.
pub const KIND: &str = "llm";

/// What names an LLM call's operation: an older SDK's `function` span with it is one.
pub const OPERATION: &str = "gen_ai.operation.name";

/// The operations that are a call to a model. The conventions' others (`invoke_agent`, `execute_tool`,
/// `create_agent`) are the app's own work around them: they stay what they are.
const MODEL_CALLS: &[&str] = &["chat", "text_completion", "generate_content", "embeddings"];

/// The attribute the agent writes each call's estimated cost into, in dollars (USD).
pub const COST: &str = "tracepanel.cost_usd";

/// The prices the agent ships with: data, dated, with their sources.
const BUILT_IN: &str = include_str!("../llm-prices.json");

/// Whether a span's attributes are a call to a model.
pub fn model_call(attrs: &Attrs) -> bool {
    text(attrs, OPERATION).is_some_and(|operation| MODEL_CALLS.contains(&operation.as_str()))
}

fn legacy(kind: &str, attrs: &Attrs) -> bool {
    kind == "function" && model_call(attrs)
}

/// Make an older SDK's LLM calls `llm` spans, and give every LLM call its cost, in the trace's rows and in its
/// document (what the console shows). A trace without any is left as it is.
pub fn normalize(received: &mut Received) {
    if !received
        .trace
        .spans
        .iter()
        .any(|span| span.kind == KIND || legacy(&span.kind, &span.attrs))
    {
        return;
    }
    let Ok(mut doc) = serde_json::from_str::<Value>(&received.doc) else {
        return;
    };
    for span in doc
        .get_mut("spans")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        let kind = span["kind"].as_str().unwrap_or_default().to_owned();
        let Some(attrs) = span.get_mut("attrs").and_then(Value::as_object_mut) else {
            continue;
        };
        if kind != KIND && !legacy(&kind, attrs) {
            continue;
        }
        priced(attrs);
        span["kind"] = Value::from(KIND);
    }
    for span in &mut received.trace.spans {
        if span.kind == KIND || legacy(&span.kind, &span.attrs) {
            span.kind = KIND.into();
            priced(&mut span.attrs);
        }
    }
    received.doc = doc.to_string();
}

/// A call's cost in its attributes, when its model has a price.
fn priced(attrs: &mut Attrs) {
    if let Some(cost) = cost(attrs) {
        attrs.insert(COST.into(), Value::from(cost));
    }
}

// ---------- what a call was ----------

/// The provider a call went to: `openai`, `anthropic`, as the conventions name it (older ones: `gen_ai.system`).
pub fn provider(span: &Span) -> String {
    text(&span.attrs, "gen_ai.provider.name")
        .or_else(|| text(&span.attrs, "gen_ai.system"))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "llm".into())
}

pub fn operation(span: &Span) -> String {
    text(&span.attrs, OPERATION).unwrap_or_default()
}

/// The model the app asked for; the one that answered when the request didn't say.
pub fn model(span: &Span) -> String {
    text(&span.attrs, "gen_ai.request.model")
        .or_else(|| text(&span.attrs, "gen_ai.response.model"))
        .unwrap_or_default()
}

/// The model that answered (a dated snapshot of the one asked for), when the answer said.
pub fn response_model(span: &Span) -> Option<String> {
    text(&span.attrs, "gen_ai.response.model")
}

fn count(attrs: &Attrs, key: &str) -> Option<i64> {
    attrs.get(key).and_then(Value::as_i64)
}

/// The tokens a call used, as the conventions count them: the input's total includes the cached and the written.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Usage {
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
}

/// A call's tokens; None when it reported none (an error, a stream closed early).
pub fn usage(attrs: &Attrs) -> Option<Usage> {
    let input = count(attrs, "gen_ai.usage.input_tokens");
    let output = count(attrs, "gen_ai.usage.output_tokens");
    if input.is_none() && output.is_none() {
        return None;
    }
    Some(Usage {
        input: input.unwrap_or(0),
        output: output.unwrap_or(0),
        cache_read: count(attrs, "gen_ai.usage.cache_read.input_tokens").unwrap_or(0),
        cache_write: count(attrs, "gen_ai.usage.cache_write.input_tokens").unwrap_or(0),
    })
}

/// What the app sent, when it captures the messages: the model, its instructions and the messages. The same prompt
/// twice is the same text.
pub fn prompt(span: &Span) -> Option<String> {
    let messages = text(&span.attrs, "gen_ai.input.messages")?;
    let system = text(&span.attrs, "gen_ai.system_instructions").unwrap_or_default();
    let digest = Sha1::digest(format!("{}\n{system}\n{messages}", model(span)).as_bytes());
    Some(
        digest[..8]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}

/// The finish reasons that mean the model asked for a tool: the app answers it in the next call.
const TOOL_FINISHES: &[&str] = &["tool_calls", "tool_use", "function_call"];

/// Whether the model asked the app to run a tool: its next call carries the tool's answer, and can't be made sooner.
fn asked_for_tools(span: &Span) -> bool {
    count(&span.attrs, "gen_ai.response.tool_call_count").is_some_and(|count| count > 0)
        || span
            .attrs
            .get("gen_ai.response.finish_reasons")
            .and_then(Value::as_array)
            .is_some_and(|reasons| {
                reasons
                    .iter()
                    .filter_map(Value::as_str)
                    .any(|reason| TOOL_FINISHES.contains(&reason))
            })
}

/// A loop's calls, one after the other, none waiting on the one before: an N+1. Calls made at the same time are
/// batched already, and an agent's loop (a call, the tools the model asked for, the next call with their answers)
/// can't be.
pub fn one_by_one(spans: &[&Span]) -> bool {
    let mut ordered = spans.to_vec();
    ordered.sort_by_key(|span| span.start);
    !ordered.iter().any(|span| asked_for_tools(span))
        && ordered
            .windows(2)
            .all(|pair| pair[1].start >= pair[0].start + pair[0].duration)
}

pub const DUPLICATES: &str = "The same prompt went to the model again: keep the first answer for the request, or \
                              cache the answers by their prompt.";

/// What to do about calls made one by one, by the operation.
pub fn repeated_hint(span: &Span) -> &'static str {
    if operation(span) == "embeddings" {
        "Embed the texts in one request: the embeddings API takes a list of inputs, and one call for all of them \
         costs one round trip instead of one per text."
    } else {
        "Each call waits for the model before the next one starts: send the independent ones concurrently \
         (asyncio.gather, a thread pool), ask for several items in one prompt, or, when nobody waits for the answers, \
         use the provider's Batch API (half the price)."
    }
}

// ---------- prices ----------

/// One model's prices, in USD per million tokens, and the dearer ones of a long input.
#[derive(Debug, Clone, PartialEq)]
struct Price {
    input: f64,
    output: f64,
    cache_read: Option<f64>,
    cache_write: Option<f64>,
    long: Option<(i64, Box<Price>)>,
}

fn price_of(value: &Value) -> Option<Price> {
    let number = |key: &str| value.get(key).and_then(Value::as_f64);
    let long = value
        .get("long")
        .and_then(|long| Some((long.get("above")?.as_i64()?, Box::new(price_of(long)?))));
    Some(Price {
        input: number("input")?,
        output: number("output")?,
        cache_read: number("cache_read"),
        cache_write: number("cache_write"),
        long,
    })
}

/// The prices of a table: its models, each that has an input and an output price.
fn models_of(table: &Value) -> HashMap<String, Price> {
    table["models"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(name, value)| Some((name.clone(), price_of(value)?)))
        .collect()
}

static PRICES: OnceLock<HashMap<String, Price>> = OnceLock::new();

fn built_in() -> HashMap<String, Price> {
    models_of(&serde_json::from_str(BUILT_IN).expect("llm-prices.json is JSON"))
}

/// The prices to use from now on: the built-in ones, with a table of the same shape over them (its models replace
/// or add to them). Once, before the first trace: an error says what's wrong with the table.
pub fn set_prices(overrides: &str) -> Result<(), String> {
    let table: Value =
        serde_json::from_str(overrides).map_err(|error| format!("not JSON: {error}"))?;
    if !table["models"].is_object() {
        return Err("no \"models\" in it".into());
    }
    let mut prices = built_in();
    prices.extend(models_of(&table));
    PRICES
        .set(prices)
        .map_err(|_| "the prices are set already".into())
}

fn prices() -> &'static HashMap<String, Price> {
    PRICES.get_or_init(built_in)
}

/// The date the built-in prices are from.
pub fn prices_date() -> String {
    serde_json::from_str::<Value>(BUILT_IN).expect("llm-prices.json is JSON")["date"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

/// A snapshot's date at a model's end: `-2024-07-18`, `-20250929`.
static DATED: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"-(?:\d{4}-\d{2}-\d{2}|\d{8}|latest)$").unwrap());

/// A model's prices: by its name, or by its name without its snapshot's date. None for one the table doesn't have.
fn price(model: &str) -> Option<&'static Price> {
    let prices = prices();
    prices
        .get(model)
        .or_else(|| prices.get(DATED.replace(model, "").as_ref()))
}

/// What a call cost, estimated from its tokens and its model's list price (the model that answered, else the one
/// asked for): None for a model without a price, or a call that reported no tokens.
pub fn cost(attrs: &Attrs) -> Option<f64> {
    let usage = usage(attrs)?;
    let price = text(attrs, "gen_ai.response.model")
        .and_then(|model| price(&model))
        .or_else(|| text(attrs, "gen_ai.request.model").and_then(|model| price(&model)))?;
    let price = match &price.long {
        Some((above, long)) if usage.input > *above => long,
        _ => price,
    };
    let fresh = (usage.input - usage.cache_read - usage.cache_write).max(0);
    let dollars = fresh as f64 * price.input
        + usage.cache_read as f64 * price.cache_read.unwrap_or(price.input)
        + usage.cache_write as f64 * price.cache_write.unwrap_or(price.input)
        + usage.output as f64 * price.output;
    // Per million tokens; ten decimals keep a token's share of a cent and leave out the float's noise.
    Some((dollars / 1e6 * 1e10).round() / 1e10)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn attrs(value: Value) -> Attrs {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn a_call_costs_its_tokens_at_its_model_s_price() {
        let costs = [
            // A dated snapshot by its model's price: 12 input tokens (4 cached) and 5 output of gpt-4o-mini.
            json!({"gen_ai.response.model": "gpt-4o-mini-2024-07-18", "gen_ai.usage.input_tokens": 12,
                   "gen_ai.usage.output_tokens": 5, "gen_ai.usage.cache_read.input_tokens": 4}),
            // Anthropic's cache: 100 read and 20 written of the input's 130.
            json!({"gen_ai.request.model": "claude-sonnet-4-5", "gen_ai.response.model": "claude-sonnet-4-5-20250929",
                   "gen_ai.usage.input_tokens": 130, "gen_ai.usage.output_tokens": 6,
                   "gen_ai.usage.cache_read.input_tokens": 100, "gen_ai.usage.cache_write.input_tokens": 20}),
            // A long input at the long price.
            json!({"gen_ai.request.model": "claude-haiku-5-5", "gen_ai.usage.input_tokens": 200_000,
                   "gen_ai.usage.output_tokens": 1000}),
            // The model asked for, when the answer named one the table doesn't have.
            json!({"gen_ai.request.model": "gpt-5", "gen_ai.response.model": "gpt-5-preview",
                   "gen_ai.usage.input_tokens": 1_000_000, "gen_ai.usage.output_tokens": 0}),
            json!({"gen_ai.request.model": "my-own-model", "gen_ai.usage.input_tokens": 10,
                   "gen_ai.usage.output_tokens": 10}),
            json!({"gen_ai.request.model": "gpt-4o-mini"}),
        ]
        .map(|value| cost(&attrs(value)));

        assert_eq!(
            costs,
            [
                Some(0.0000045),
                Some(0.000225),
                Some(0.1025),
                Some(1.25),
                None,
                None
            ]
        );
    }

    #[test]
    fn a_table_of_prices_is_checked() {
        assert_eq!(set_prices("[]"), Err("no \"models\" in it".to_owned()));
        assert!(set_prices("{").unwrap_err().starts_with("not JSON"));
    }

    #[test]
    fn the_built_in_prices_are_dated_and_every_model_has_its_two() {
        let table: Value = serde_json::from_str(BUILT_IN).unwrap();

        assert_eq!(prices_date(), "2026-10-26");
        assert_eq!(built_in().len(), table["models"].as_object().unwrap().len());
    }

    fn span(start: i64, duration: i64, attrs: Value) -> Span {
        serde_json::from_value(json!({
            "id": format!("s{start}"), "kind": KIND, "name": "chat gpt-5", "start": start, "duration": duration,
            "attrs": attrs,
        }))
        .unwrap()
    }

    #[test]
    fn calls_one_by_one_are_a_loop_and_at_once_or_with_tools_are_not() {
        let plain = || json!({"gen_ai.response.finish_reasons": ["stop"]});
        let one_by_one_calls = [
            span(0, 10, plain()),
            span(10, 10, plain()),
            span(25, 5, plain()),
        ];
        let at_once = [
            span(0, 10, plain()),
            span(2, 10, plain()),
            span(4, 10, plain()),
        ];
        let agent = [
            span(
                0,
                10,
                json!({"gen_ai.response.finish_reasons": ["tool_calls"]}),
            ),
            span(12, 10, json!({"gen_ai.response.tool_call_count": 1})),
            span(24, 10, plain()),
        ];

        let found = [&one_by_one_calls, &at_once, &agent]
            .map(|spans| one_by_one(&spans.iter().collect::<Vec<_>>()));

        assert_eq!(found, [true, false, false]);
    }

    #[test]
    fn an_older_sdk_s_llm_calls_become_llm_spans_with_their_cost() {
        let doc = json!({
            "id": "01M5LLMTRACE00000000000000", "kind": "http", "name": "POST /ask", "start": 0,
            "duration": 10, "status": "ok", "attrs": {},
            "spans": [
                {"id": "01M5LLMR00T000000000000000", "parent_id": null, "kind": "http", "name": "POST /ask",
                 "start": 0, "duration": 10, "status": "ok", "attrs": {}},
                {"id": "01M5LLMCALL000000000000000", "parent_id": "01M5LLMR00T000000000000000", "kind": "function",
                 "name": "chat gpt-5", "start": 1, "duration": 8, "status": "ok",
                 "attrs": {"gen_ai.operation.name": "chat", "gen_ai.request.model": "gpt-5",
                           "gen_ai.usage.input_tokens": 1000, "gen_ai.usage.output_tokens": 100}},
                {"id": "01M5LLMAGENT00000000000000", "parent_id": "01M5LLMR00T000000000000000", "kind": "function",
                 "name": "invoke_agent", "start": 1, "duration": 8, "status": "ok",
                 "attrs": {"gen_ai.operation.name": "invoke_agent"}},
            ],
            "logs": [], "errors": [], "links": [], "issues": [],
        });
        let mut received = Received {
            trace: serde_json::from_value(doc.clone()).unwrap(),
            doc: doc.to_string(),
        };

        normalize(&mut received);

        let rows: Vec<(&str, Option<&Value>)> = received
            .trace
            .spans
            .iter()
            .map(|span| (span.kind.as_str(), span.attrs.get(COST)))
            .collect();
        let stored: Value = serde_json::from_str(&received.doc).unwrap();
        let documented: Vec<(&str, Option<&Value>)> = stored["spans"]
            .as_array()
            .unwrap()
            .iter()
            .map(|span| (span["kind"].as_str().unwrap(), span["attrs"].get(COST)))
            .collect();

        assert_eq!(
            rows,
            [
                ("http", None),
                ("llm", Some(&json!(0.00225))),
                ("function", None)
            ]
        );
        assert_eq!(documented, rows);
    }
}
