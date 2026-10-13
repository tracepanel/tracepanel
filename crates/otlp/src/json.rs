//! OTLP/JSON, read into the same messages as the protobuf: field names in lowerCamelCase (or as the proto spells them),
//! trace and span ids in hex, 64-bit integers as strings or numbers, enums as numbers or their names.

use crate::proto::{
    AnyValue, ArrayValue, Event, ExportTraceServiceRequest, InstrumentationScope, KeyValue,
    KeyValueList, Resource, ResourceSpans, ScopeSpans, Span, Status, Value as Any,
};
use serde_json::Value;

/// The field, by its JSON name or its proto name.
fn field<'a>(object: &'a Value, camel: &str, snake: &str) -> Option<&'a Value> {
    object.get(camel).or_else(|| object.get(snake))
}

fn list<'a>(object: &'a Value, camel: &str, snake: &str) -> &'a [Value] {
    field(object, camel, snake)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn text(object: &Value, camel: &str, snake: &str) -> String {
    field(object, camel, snake)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// A 64-bit integer: a string in proto3's JSON, a number from some exporters.
fn integer(value: Option<&Value>) -> Option<i128> {
    match value? {
        Value::String(text) => text.parse().ok(),
        Value::Number(number) => number
            .as_i64()
            .map(i128::from)
            .or_else(|| number.as_u64().map(i128::from)),
        _ => None,
    }
}

fn unsigned(object: &Value, camel: &str, snake: &str) -> u64 {
    integer(field(object, camel, snake))
        .and_then(|value| u64::try_from(value).ok())
        .unwrap_or(0)
}

/// An enum: its number, or its name (`SPAN_KIND_SERVER`), by its place in `names`.
fn enumerated(value: Option<&Value>, names: &[&str]) -> i32 {
    match value {
        Some(Value::Number(number)) => number
            .as_i64()
            .and_then(|n| i32::try_from(n).ok())
            .unwrap_or(0),
        Some(Value::String(name)) => names
            .iter()
            .position(|each| each == name)
            .map_or(0, |at| at as i32),
        _ => 0,
    }
}

fn hex(object: &Value, camel: &str, snake: &str) -> Vec<u8> {
    let text = text(object, camel, snake);
    (0..text.len() / 2)
        .filter_map(|at| u8::from_str_radix(text.get(at * 2..at * 2 + 2)?, 16).ok())
        .collect()
}

fn any_value(value: &Value) -> AnyValue {
    let any = if let Some(text) =
        field(value, "stringValue", "string_value").and_then(Value::as_str)
    {
        Some(Any::String(text.to_owned()))
    } else if let Some(flag) = field(value, "boolValue", "bool_value").and_then(Value::as_bool) {
        Some(Any::Bool(flag))
    } else if let Some(number) = integer(field(value, "intValue", "int_value")) {
        Some(Any::Int(i64::try_from(number).unwrap_or(i64::MAX)))
    } else if let Some(number) = field(value, "doubleValue", "double_value").and_then(Value::as_f64)
    {
        Some(Any::Double(number))
    } else if let Some(array) = field(value, "arrayValue", "array_value") {
        Some(Any::Array(ArrayValue {
            values: list(array, "values", "values")
                .iter()
                .map(any_value)
                .collect(),
        }))
    } else if let Some(map) = field(value, "kvlistValue", "kvlist_value") {
        Some(Any::KvList(KeyValueList {
            values: attributes(list(map, "values", "values")),
        }))
    } else {
        // Bytes come base64-encoded: kept as that text, which is how the console would show them anyway.
        field(value, "bytesValue", "bytes_value")
            .and_then(Value::as_str)
            .map(|text| Any::String(text.to_owned()))
    };
    AnyValue { value: any }
}

fn attributes(values: &[Value]) -> Vec<KeyValue> {
    values
        .iter()
        .map(|pair| KeyValue {
            key: text(pair, "key", "key"),
            value: pair.get("value").map(any_value),
        })
        .collect()
}

const KINDS: &[&str] = &[
    "SPAN_KIND_UNSPECIFIED",
    "SPAN_KIND_INTERNAL",
    "SPAN_KIND_SERVER",
    "SPAN_KIND_CLIENT",
    "SPAN_KIND_PRODUCER",
    "SPAN_KIND_CONSUMER",
];
const CODES: &[&str] = &["STATUS_CODE_UNSET", "STATUS_CODE_OK", "STATUS_CODE_ERROR"];

fn span(value: &Value) -> Span {
    Span {
        trace_id: hex(value, "traceId", "trace_id"),
        span_id: hex(value, "spanId", "span_id"),
        parent_span_id: hex(value, "parentSpanId", "parent_span_id"),
        flags: u32::try_from(unsigned(value, "flags", "flags")).unwrap_or(0),
        name: text(value, "name", "name"),
        kind: enumerated(value.get("kind"), KINDS),
        start_time_unix_nano: unsigned(value, "startTimeUnixNano", "start_time_unix_nano"),
        end_time_unix_nano: unsigned(value, "endTimeUnixNano", "end_time_unix_nano"),
        attributes: attributes(list(value, "attributes", "attributes")),
        events: list(value, "events", "events")
            .iter()
            .map(|event| Event {
                time_unix_nano: unsigned(event, "timeUnixNano", "time_unix_nano"),
                name: text(event, "name", "name"),
                attributes: attributes(list(event, "attributes", "attributes")),
            })
            .collect(),
        status: value.get("status").map(|status| Status {
            message: text(status, "message", "message"),
            code: enumerated(status.get("code"), CODES),
        }),
    }
}

/// An `ExportTraceServiceRequest` in OTLP/JSON. Unknown fields are ignored, as the spec asks.
pub fn request(value: &Value) -> ExportTraceServiceRequest {
    ExportTraceServiceRequest {
        resource_spans: list(value, "resourceSpans", "resource_spans")
            .iter()
            .map(|resource_spans| ResourceSpans {
                resource: resource_spans.get("resource").map(|resource| Resource {
                    attributes: attributes(list(resource, "attributes", "attributes")),
                }),
                scope_spans: list(resource_spans, "scopeSpans", "scope_spans")
                    .iter()
                    .map(|scope_spans| ScopeSpans {
                        scope: scope_spans.get("scope").map(|scope| InstrumentationScope {
                            name: text(scope, "name", "name"),
                            version: text(scope, "version", "version"),
                        }),
                        spans: list(scope_spans, "spans", "spans")
                            .iter()
                            .map(span)
                            .collect(),
                    })
                    .collect(),
            })
            .collect(),
    }
}
