//! File storage calls: what an app asks a storage's backend (Django's `Storage`, django-storages' S3, GCS, Azure…),
//! a `storage` span each, `storage save avatars/1.png`, with its attributes under `storage.`: the storage's `alias`
//! (its name in STORAGES), `backend` (its class), `system` (`filesystem`, `memory`, `s3`, `gcs`, `azure`…), the `op`
//! (save, open, delete, exists, listdir, size, url, the times), the `path` and what the call answered (`bytes`,
//! `exists`, `dirs` and `files` of a listing, `saved_as`).
//!
//! A call to S3's API (botocore's, `rpc.system` aws-api) is a `storage` span too, `storage.system` s3, its `op` the
//! API's operation (GetObject, HeadObject, ListObjectsV2) and its path the bucket and key: its hints say S3's way, not
//! a Django storage's.
//!
//! SDKs that predate the kind send each call as a `function` span with `storage.op`: it becomes a `storage` span here,
//! before the issues are found and the trace is stored, so nothing downstream tells them apart.

use super::{aws, or_default, rekind, template, text};
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
    // S3's API.
    "GetObject",
    "HeadObject",
    "ListObjects",
    "ListObjectsV2",
    "ListObjectVersions",
    "GetObjectAcl",
    "GetObjectTagging",
    "GetObjectAttributes",
    "HeadBucket",
    "GetBucketLocation",
];

/// The operations that list a directory (a prefix): what a loop's listings share is the directory itself.
const LISTINGS: &[&str] = &[
    "listdir",
    "ListObjects",
    "ListObjectsV2",
    "ListObjectVersions",
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
    if LISTINGS.contains(&op) {
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
const S3_DUPLICATES: &str = "Make the request once and keep its answer for the request (HeadObject's metadata, \
                             GetObject's body, a listing): each call is a request to S3 again.";
pub const SLOW: &str = "The request waits for the storage's backend: serve large files from their URL (a signed one \
                        on a private bucket, or a CDN), save uploads in a background task, or keep what the request \
                        needs (sizes, thumbnails) on the model.";
pub const S3_SLOW: &str = "The request waits for S3, and a large object takes as long as its bytes: hand the browser a \
                           presigned URL (`generate_presigned_url`) to download or upload it directly, stream it, or \
                           move the transfer to a background task.";

/// What to do about the same call made twice: S3's API, or a storage's.
pub fn duplicates_hint(span: &Span) -> &'static str {
    if aws::is_call(span) {
        S3_DUPLICATES
    } else {
        DUPLICATES
    }
}

/// What to do about one of S3's operations repeated in a loop, by the operation.
fn s3_repeated_hint(op: &str) -> &'static str {
    match op {
        "HeadObject" | "GetObjectAttributes" | "GetObjectTagging" | "GetObjectAcl" => {
            "Each call is a request to S3 about one object: list the prefix once with ListObjectsV2 (its answer has \
             each key's size, ETag and time) and look the keys up in it, or keep what the loop needs on the model."
        }
        "GetObject" => {
            "Each GetObject is a request to S3 that downloads an object: keep what the loop needs from the objects \
             (their metadata, a thumbnail) in the database or a cache, hand the browser presigned URLs instead of the \
             bytes, or do the work in a background task."
        }
        "ListObjects" | "ListObjectsV2" | "ListObjectVersions" => {
            "List the prefix once with ListObjectsV2 (its paginator past 1,000 keys) and reuse the listing, instead of \
             a listing per item."
        }
        "DeleteObject" => {
            "Delete up to 1,000 keys in one DeleteObjects request instead of a DeleteObject per key."
        }
        "PutObject" | "CopyObject" | "UploadPart" => {
            "Each call is a request to S3 that waits for the upload: send the objects concurrently (a thread pool, or \
             s3transfer's upload_file), or move the uploads to a background task."
        }
        _ => {
            "Each call is a request to S3: make fewer of them (one ListObjectsV2 instead of a call per key, \
             DeleteObjects for many keys), or move the work to a background task."
        }
    }
}

/// What to do about one operation repeated in a loop, by the operation: S3's API, or a storage's.
pub fn repeated_hint(span: &Span) -> &'static str {
    if aws::is_call(span) {
        return s3_repeated_hint(&op(span));
    }
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
            ("HeadObject", Some("media/users/42/a.png")),
            ("ListObjectsV2", Some("media/users/42/")),
        ]
        .map(|(op, path)| path_template(op, path));

        assert_eq!(
            templates,
            [
                "avatars/*",
                "users/{id}/*",
                "*",
                "avatars",
                "",
                "",
                "media/users/{id}/*",
                "media/users/{id}"
            ]
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
