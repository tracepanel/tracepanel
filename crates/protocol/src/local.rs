//! What stays on this machine when a trace leaves it: for Tracepanel Cloud, or in a snapshot shared without its
//! values. Query parameters, mail bodies, who a user is beyond their id, what a request carried (its query string,
//! headers, body, cookies and session) and its response's headers, a log record's own fields (`extra=`), the
//! local variables of an error's frames and the context a template was rendered with.

use serde_json::{Map, Value};

/// Attributes that stay on this machine: parameters, mail bodies, who a user is beyond their id, a request's query
/// string and body.
const LOCAL_ONLY: [&str; 8] = [
    "db.params",
    "mail.body",
    "mail.html",
    "user.username",
    "user.email",
    "url.query",
    "http.request.body",
    "http.request.body.truncated",
];
/// Attributes under these stay on this machine too: a log record's own fields (as `extra=` passed them), a request's
/// headers, cookies and session, its response's headers, and a template's context (its names and their values).
const LOCAL_ONLY_PREFIXES: [&str; 6] = [
    "extra.",
    "http.request.header.",
    "http.request.cookie.",
    "session.",
    "http.response.header.",
    "template.context.",
];

/// The trace document without what stays local: its attributes, its spans' and its logs' stripped, its errors' frames
/// without their local variables (the field kept, as null, as the schema wants it).
pub fn strip(trace: &mut Value) {
    let Some(object) = trace.as_object_mut() else {
        return;
    };
    if let Some(attrs) = object.get_mut("attrs").and_then(Value::as_object_mut) {
        strip_attrs(attrs);
    }
    for key in ["spans", "logs"] {
        for item in items(object, key) {
            if let Some(attrs) = item.get_mut("attrs").and_then(Value::as_object_mut) {
                strip_attrs(attrs);
            }
        }
    }
    for error in items(object, "errors") {
        forget_locals(error);
        if let Some(chain) = error.get_mut("chain").and_then(Value::as_array_mut) {
            chain.iter_mut().for_each(forget_locals);
        }
    }
}

fn items<'a>(object: &'a mut Map<String, Value>, key: &str) -> impl Iterator<Item = &'a mut Value> {
    object
        .get_mut(key)
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
}

fn strip_attrs(attrs: &mut Map<String, Value>) {
    attrs.retain(|key, _| {
        !LOCAL_ONLY.contains(&key.as_str())
            && !LOCAL_ONLY_PREFIXES
                .iter()
                .any(|prefix| key.starts_with(prefix))
    });
}

fn forget_locals(error: &mut Value) {
    let Some(frames) = error.get_mut("frames").and_then(Value::as_array_mut) else {
        return;
    };
    for frame in frames {
        if let Some(locals) = frame.get_mut("locals") {
            *locals = Value::Null;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_a_request_carried_stays_local() {
        let mut trace = serde_json::json!({
            "attrs": {
                "http.route": "/orders/",
                "url.query": "page=2",
                "http.request.header.user-agent": "curl/8",
                "http.request.body": "{\"items\":3}",
                "http.request.body.truncated": true,
                "http.request.cookie.theme": "dark",
                "session.cart": "[3]",
                "http.response.header.content-type": "application/json",
            },
        });

        strip(&mut trace);

        assert_eq!(
            trace,
            serde_json::json!({"attrs": {"http.route": "/orders/"}})
        );
    }

    #[test]
    fn what_stays_local_goes_and_the_rest_stays() {
        let mut trace = serde_json::json!({
            "attrs": {"user.id": 7, "user.email": "ann@example.com", "http.route": "/"},
            "spans": [
                {"attrs": {"db.statement": "SELECT 1 WHERE id = %s", "db.params": [7]}},
                {"attrs": {"template.name": "books.html", "template.context.names": ["books"],
                           "template.context.values": ["<QuerySet of Book, not evaluated>"]}},
            ],
            "logs": [{"attrs": {"extra.order_id": 42, "code.origin": "app.py:3"}}],
            "errors": [{"frames": [{"locals": {"token": "x"}}], "chain": [{"frames": [{"locals": {"a": 1}}]}]}],
        });

        strip(&mut trace);

        assert_eq!(
            trace,
            serde_json::json!({
                "attrs": {"user.id": 7, "http.route": "/"},
                "spans": [
                    {"attrs": {"db.statement": "SELECT 1 WHERE id = %s"}},
                    {"attrs": {"template.name": "books.html"}},
                ],
                "logs": [{"attrs": {"code.origin": "app.py:3"}}],
                "errors": [{"frames": [{"locals": null}], "chain": [{"frames": [{"locals": null}]}]}],
            })
        );
    }
}
