//! A GraphQL request's trace, named after its operation: `GraphQL query Books`. One URL serves every operation, so
//! the SDKs and the OpenTelemetry mapping name the request so. A server that answered before the operation ran (a
//! 503, a gateway's refusal) leaves its trace named by its request line (`POST /graphql`), though the request said
//! which operation it was: in the attributes its SDK set, or in its body when the SDK captured it. Named after it
//! here, the trace keeps the name the widget showed while the request ran (one name from running to done). The body's
//! rule is the widget's (`ui/packages/ui/src/lib/graphql.ts`), its cases in `schema/graphql-names.json`.

use serde_json::Value;
use tracepanel_protocol::{Attrs, Received};

/// The largest body read for its operation, as the widget reads one.
const MAX_BODY: usize = 100_000;

/// The operation types a GraphQL document starts with.
const TYPES: [&str; 3] = ["query", "mutation", "subscription"];

/// `GraphQL query Books`: a named operation's request, from the JSON body GraphQL sends (`{"query": …,
/// "operationName": …}`), by its type and the name the client sent (else its own). None for any other body, and
/// for an anonymous operation.
pub fn name_from_body(body: &str) -> Option<String> {
    if body.len() > MAX_BODY || !body.contains("\"query\"") {
        return None;
    }
    let parsed: Value = serde_json::from_str(body).ok()?;
    let (kind, own) = operation(parsed.get("query")?.as_str()?)?;
    let name = parsed
        .get("operationName")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .unwrap_or(own);
    Some(format!("GraphQL {kind} {name}"))
}

/// A document's first operation, when it opens with one that is named: its type and name.
fn operation(query: &str) -> Option<(&str, &str)> {
    let rest = query.trim_start();
    let kind = TYPES.into_iter().find(|kind| rest.starts_with(kind))?;
    let after = &rest[kind.len()..];
    let name = after.trim_start();
    if name.len() == after.len() {
        return None;
    }
    let end = name
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(name.len());
    let name = &name[..end];
    let first = name.chars().next()?;
    (first.is_ascii_alphabetic() || first == '_').then_some((kind, name))
}

fn text<'a>(attrs: &'a Attrs, key: &str) -> Option<&'a str> {
    attrs
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

/// The operation a request's trace, or a call to a GraphQL server, carries: its SDK's attributes, else its captured
/// body. One URL serves every operation: a call is named by it (`GraphQL query Authors`) wherever calls are listed.
pub fn carried(attrs: &Attrs) -> Option<String> {
    if let (Some(kind), Some(name)) = (
        text(attrs, "graphql.operation.type"),
        text(attrs, "graphql.operation.name"),
    ) {
        return Some(format!("GraphQL {kind} {name}"));
    }
    if let Some(label) = text(attrs, "graphql.operation") {
        return Some(format!("GraphQL {label}"));
    }
    name_from_body(text(attrs, "http.request.body")?)
}

/// `POST /graphql`: a name that is the request's line, its method and its path, as an SDK names a request.
fn request_line(name: &str) -> bool {
    name.split_once(' ').is_some_and(|(method, path)| {
        !method.is_empty()
            && method.bytes().all(|b| b.is_ascii_uppercase())
            && path.starts_with('/')
    })
}

/// A request's trace named by its request line, though it carried a GraphQL operation: named after the operation,
/// in its row and its document (its root span too, which bore the same name). Any other trace is left as it came,
/// unparsed.
pub fn normalize(received: &mut Received) {
    let trace = &received.trace;
    if trace.kind != "http" || !request_line(&trace.name) {
        return;
    }
    let Some(name) = carried(&trace.attrs) else {
        return;
    };
    let was = std::mem::replace(&mut received.trace.name, name.clone());
    let root = received
        .trace
        .spans
        .iter_mut()
        .find(|span| span.parent_id.is_none() && span.name == was);
    if let Some(root) = root {
        root.name.clone_from(&name);
    }
    let Ok(mut doc) = serde_json::from_str::<Value>(&received.doc) else {
        return;
    };
    doc["name"] = Value::from(name.as_str());
    for span in doc
        .get_mut("spans")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        if span.get("parent_id").is_none_or(Value::is_null)
            && span.get("name") == Some(&Value::from(was.as_str()))
        {
            span["name"] = Value::from(name.as_str());
        }
    }
    received.doc = doc.to_string();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tracepanel_protocol::Trace;

    #[test]
    fn the_shared_cases() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../../schema/graphql-names.json")).unwrap();

        for case in &cases {
            let body = case["body"].as_str().unwrap();

            assert_eq!(
                name_from_body(body),
                case["name"].as_str().map(str::to_owned),
                "{body}"
            );
        }
    }

    fn received(doc: Value) -> Received {
        let trace: Trace = serde_json::from_value(doc.clone()).unwrap();
        Received {
            trace,
            doc: doc.to_string(),
        }
    }

    fn request(name: &str, attrs: Value) -> Value {
        json!({
            "id": "01M4GQ1000000000000000000A", "kind": "http", "name": name, "start": 1, "duration": 5,
            "status": "error", "attrs": attrs,
            "spans": [
                {"id": "r", "parent_id": null, "kind": "http", "name": name, "start": 1, "duration": 5, "attrs": {}},
                {"id": "c", "parent_id": "r", "kind": "http.client", "name": "GET /authors", "start": 2, "duration": 1, "attrs": {}},
            ],
        })
    }

    fn names(received: &Received) -> (String, Value, Value) {
        let doc: Value = serde_json::from_str(&received.doc).unwrap();
        (
            received.trace.name.clone(),
            doc["name"].clone(),
            json!(
                doc["spans"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|span| span["name"].clone())
                    .collect::<Vec<_>>()
            ),
        )
    }

    #[test]
    fn a_request_that_failed_before_its_operation_ran_is_named_after_the_operation_its_body_carried()
     {
        let body = r#"{"operationName":"Authors","query":"query Authors { authors { id name } }","variables":{}}"#;
        let mut trace = received(request(
            "POST /graphql",
            json!({"http.status_code": 503, "http.request.body": body}),
        ));

        normalize(&mut trace);

        assert_eq!(
            names(&trace),
            (
                "GraphQL query Authors".to_owned(),
                json!("GraphQL query Authors"),
                json!(["GraphQL query Authors", "GET /authors"])
            )
        );
        assert_eq!(trace.trace.spans[0].name, "GraphQL query Authors");
    }

    #[test]
    fn the_sdks_attributes_name_it_too() {
        let mut typed = received(request(
            "POST /graphql",
            json!({"graphql.operation.type": "mutation", "graphql.operation.name": "AddReview"}),
        ));
        let mut labelled = received(request(
            "POST /graphql",
            json!({"graphql.operation": "query Books"}),
        ));

        normalize(&mut typed);
        normalize(&mut labelled);

        assert_eq!(typed.trace.name, "GraphQL mutation AddReview");

        assert_eq!(labelled.trace.name, "GraphQL query Books");
    }

    #[test]
    fn a_name_of_its_own_and_a_request_without_an_operation_stay() {
        let body = r#"{"query":"query Authors { authors { id } }"}"#;
        let mut named = received(request(
            "GraphQL query Books",
            json!({"http.request.body": body}),
        ));
        let mut other = received(request("POST /graphql", json!({"http.request.body": "{}"})));
        let doc = other.doc.clone();

        normalize(&mut named);
        normalize(&mut other);

        assert_eq!(named.trace.name, "GraphQL query Books");

        assert_eq!(
            (other.trace.name.as_str(), other.doc),
            ("POST /graphql", doc)
        );
    }
}
