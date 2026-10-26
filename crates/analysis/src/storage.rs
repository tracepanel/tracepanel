//! File storage calls: what an app asks a storage's backend (Django's `Storage`, django-storages' S3, GCS, Azure…),
//! a `storage` span each, `storage save avatars/1.png`, with its attributes under `storage.`: the storage's `alias`
//! (its name in STORAGES), `backend` (its class), `system` (`filesystem`, `memory`, `s3`, `gcs`, `azure`…), the `op`
//! (save, open, delete, exists, listdir, size, url, the times), the `path` and what the call answered (`bytes`,
//! `exists`, `dirs` and `files` of a listing, `saved_as`).
//!
//! SDKs that predate the kind send each call as a `function` span with `storage.op`: it becomes a `storage` span here,
//! before the issues are found and the trace is stored, so nothing downstream tells them apart.

use super::{or_default, rekind, template, text};
use tracepanel_protocol::{Received, Span};

/// The span kind of a storage call.
pub const KIND: &str = "storage";

/// What marks an older SDK's `function` span as a storage call.
const OP: &str = "storage.op";

/// Storages on this machine: a call costs a system call or less, so only many of them together are an issue.
const LOCAL: &[&str] = &["filesystem", "memory"];

/// The operations that only read: asking twice for the same file is wasted.
const READS: &[&str] = &[
    "exists",
    "open",
    "size",
    "url",
    "listdir",
    "get_accessed_time",
    "get_created_time",
    "get_modified_time",
];

/// Make an older SDK's storage calls `storage` spans, in the trace's rows and in its document (what the console
/// shows). A trace without any is left as it is.
pub fn normalize(received: &mut Received) {
    rekind(received, |attrs| attrs.contains_key(OP).then_some(KIND));
}

/// The storage a call went to: its alias in STORAGES, else its class (a FileField's own storage has no alias).
pub fn target(span: &Span) -> String {
    text(&span.attrs, "storage.alias")
        .filter(|alias| !alias.is_empty())
        .or_else(|| {
            text(&span.attrs, "storage.backend")
                .map(|backend| backend.rsplit('.').next().unwrap_or_default().to_owned())
        })
        .unwrap_or_else(|| "default".into())
}

pub fn op(span: &Span) -> String {
    or_default(&span.attrs, "storage.op", "")
}

/// What a loop's calls share: the directory they look in, its ids as `{id}`, `avatars/*`; a listing's own directory.
/// A loop over files names each differently (`avatars/alice.png`), and its calls are still one N+1.
pub fn path_template(op: &str, path: Option<&str>) -> String {
    let Some(path) = path
        .map(|path| path.trim_end_matches('/'))
        .filter(|path| !path.is_empty())
    else {
        return String::new();
    };
    if op == "listdir" {
        return template(path);
    }
    path.rsplit_once('/')
        .map_or_else(|| "*".to_owned(), |(dir, _)| format!("{}/*", template(dir)))
}

pub fn path(span: &Span) -> Option<String> {
    text(&span.attrs, "storage.path")
}

/// Whether asking again for the same file only repeats the answer.
pub fn read(op: &str) -> bool {
    READS.contains(&op)
}

/// A call to a storage on this machine (the disk, memory): repeats cost something only many together.
pub fn local(span: &Span) -> bool {
    span.kind == KIND
        && text(&span.attrs, "storage.system")
            .is_some_and(|system| LOCAL.contains(&system.as_str()))
}

pub const REPEATED: &str = "Each call is a round trip to the storage's backend (a request on S3): make fewer of them, \
                            one listdir() instead of a call per file, the sizes and URLs kept on the model when the \
                            file is saved, or move the work to a background task.";
pub const DUPLICATES: &str = "Ask the storage once and keep the answer for the request: each call goes to its backend again.";

/// What to do about one operation repeated in a loop, by the operation.
pub fn repeated_hint(span: &Span) -> &'static str {
    match op(span).as_str() {
        "exists" => {
            "Each exists() asks the storage's backend (a request on S3): list the directory once with listdir() and \
             look the names up in it, or keep on the model whether the file is there."
        }
        "url" => {
            "Each url() signs the URL on S3 and other private buckets: serve the files from a public bucket or a CDN \
             domain (`querystring_auth = False`, `custom_domain` in django-storages), where url() only joins \
             strings, or build the URLs once for the request."
        }
        "size" | "get_accessed_time" | "get_created_time" | "get_modified_time" => {
            "Each call asks the storage's backend about one file: keep its size and times on the model when it is \
             saved, or list the directory once."
        }
        "open" => {
            "Each open() reads a file from the storage's backend: keep what the loop needs from the files (a \
             thumbnail, its metadata) on the model or in the cache, or do the work in a background task."
        }
        _ => REPEATED,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn a_loop_s_calls_share_their_directory_and_a_listing_its_own() {
        let templates = [
            ("exists", Some("avatars/alice.png")),
            ("open", Some("users/42/avatar.png")),
            ("exists", Some("robots.txt")),
            ("listdir", Some("avatars/")),
            ("listdir", Some("")),
            ("url", None),
        ]
        .map(|(op, path)| path_template(op, path));

        assert_eq!(
            templates,
            ["avatars/*", "users/{id}/*", "*", "avatars", "", ""]
        );
    }

    #[test]
    fn an_older_sdk_s_storage_calls_become_storage_spans_in_the_rows_and_the_document() {
        let doc = serde_json::json!({
            "id": "01M5STRGTRACE0000000000000", "kind": "command", "name": "collectstatic", "start": 0,
            "duration": 10, "status": "ok", "attrs": {},
            "spans": [
                {"id": "01M5STRGR00T00000000000000", "parent_id": null, "kind": "command", "name": "collectstatic",
                 "start": 0, "duration": 10, "status": "ok", "attrs": {}},
                {"id": "01M5STRGPHASE0000000000000", "parent_id": "01M5STRGR00T00000000000000", "kind": "function",
                 "name": "collectstatic copy", "start": 1, "duration": 8, "status": "ok",
                 "attrs": {"collectstatic.phase": "copy"}},
                {"id": "01M5STRGSPAN00000000000000", "parent_id": "01M5STRGPHASE0000000000000", "kind": "function",
                 "name": "storage exists css/app.css", "start": 2, "duration": 1, "status": "ok",
                 "attrs": {"storage.op": "exists", "storage.path": "css/app.css"}},
            ],
            "logs": [], "errors": [], "links": [], "issues": [],
        });
        let mut received = Received {
            trace: serde_json::from_value(doc.clone()).unwrap(),
            doc: doc.to_string(),
        };

        normalize(&mut received);

        let rows: Vec<&str> = received
            .trace
            .spans
            .iter()
            .map(|span| span.kind.as_str())
            .collect();
        let stored: Value = serde_json::from_str(&received.doc).unwrap();
        let documented: Vec<&str> = stored["spans"]
            .as_array()
            .unwrap()
            .iter()
            .map(|span| span["kind"].as_str().unwrap())
            .collect();

        assert_eq!(rows, ["command", "function", "storage"]);
        assert_eq!(documented, rows);
    }
}
