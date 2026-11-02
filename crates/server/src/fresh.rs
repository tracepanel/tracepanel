//! The API's reads, cheap to ask again. The panel asks a trace's chain every few seconds while its calls' traces may
//! still arrive, the widget asks it for the pill, and a chain can be hundreds of KB: each answer carries an ETag
//! (its body's hash) with `Cache-Control: no-cache`, so the browser asks again with `If-None-Match` and an unchanged
//! answer is a 304 with no body; and a large one goes gzipped when the browser takes it, as JSON shrinks tenfold.

use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use flate2::Compression;
use flate2::write::GzEncoder;
use std::io::Write;

/// Smaller answers go as they are: gzip's own bytes and the time to make them aren't worth it.
const GZIP_FROM: usize = 1024;

/// The ETag, the 304 and gzip, for the API's GET answers of 200.
pub async fn fresh(request: Request, next: Next) -> Response {
    let read = request.method() == Method::GET && request.uri().path().starts_with("/api/");
    if !read {
        return next.run(request).await;
    }
    let asked = request.headers().get(header::IF_NONE_MATCH).cloned();
    let gzip = takes_gzip(request.headers());
    let response = next.run(request).await;
    if response.status() != StatusCode::OK {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, usize::MAX).await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let tag = etag(&bytes);
    let headers = &mut parts.headers;
    headers.insert(header::ETAG, tag.clone());
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    headers.append(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    if asked.is_some_and(|asked| matches(&asked, &tag)) {
        headers.remove(header::CONTENT_LENGTH);
        headers.remove(header::CONTENT_TYPE);
        parts.status = StatusCode::NOT_MODIFIED;
        return Response::from_parts(parts, Body::empty());
    }
    if gzip && bytes.len() >= GZIP_FROM {
        if let Some(packed) = gzipped(&bytes) {
            headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
            headers.remove(header::CONTENT_LENGTH);
            return Response::from_parts(parts, Body::from(packed));
        }
    }
    Response::from_parts(parts, Body::from(bytes))
}

/// Whether the browser takes a gzipped answer (`Accept-Encoding: gzip`, not `gzip;q=0`).
fn takes_gzip(headers: &HeaderMap) -> bool {
    headers
        .get_all(header::ACCEPT_ENCODING)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|coding| {
            let mut parts = coding.split(';').map(str::trim);
            let name = parts.next().unwrap_or("");
            let refused = parts.any(|param| {
                param
                    .strip_prefix("q=")
                    .and_then(|q| q.parse::<f32>().ok())
                    .is_some_and(|q| q == 0.0)
            });
            (name.eq_ignore_ascii_case("gzip") || name == "*") && !refused
        })
}

/// The body's tag: its FNV-1a hash and length, quoted. Stable for one body, different for another.
fn etag(bytes: &Bytes) -> HeaderValue {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes.iter() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    HeaderValue::from_str(&format!("\"{hash:016x}-{:x}\"", bytes.len()))
        .unwrap_or_else(|_| HeaderValue::from_static("\"\""))
}

/// Whether `If-None-Match` names the tag: one of its tags, weak or not, or `*`.
fn matches(asked: &HeaderValue, tag: &HeaderValue) -> bool {
    let (Ok(asked), Ok(tag)) = (asked.to_str(), tag.to_str()) else {
        return false;
    };
    asked
        .split(',')
        .map(|each| each.trim().trim_start_matches("W/"))
        .any(|each| each == tag || each == "*")
}

fn gzipped(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::with_capacity(bytes.len() / 4), Compression::fast());
    encoder.write_all(bytes).ok()?;
    encoder.finish().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gzip_is_taken_unless_refused() {
        let with = |value: &'static str| {
            let mut headers = HeaderMap::new();
            headers.insert(header::ACCEPT_ENCODING, HeaderValue::from_static(value));
            takes_gzip(&headers)
        };

        assert!(with("gzip, deflate, br, zstd"));
        assert!(with("br;q=1.0, gzip;q=0.8"));
        assert!(with("*"));

        assert!(!with("br"));
        assert!(!with("gzip;q=0"));
        assert!(!takes_gzip(&HeaderMap::new()));
    }

    #[test]
    fn a_tag_matches_itself_weak_or_in_a_list() {
        let tag = etag(&Bytes::from_static(b"{\"traces\":[]}"));
        let other = etag(&Bytes::from_static(b"{\"traces\":[1]}"));
        let weak = HeaderValue::from_str(&format!("W/{}", tag.to_str().unwrap())).unwrap();
        let list = HeaderValue::from_str(&format!("\"x\", {}", tag.to_str().unwrap())).unwrap();

        assert_ne!(tag, other);
        assert!(matches(&tag, &tag));
        assert!(matches(&weak, &tag));
        assert!(matches(&list, &tag));
        assert!(matches(&HeaderValue::from_static("*"), &tag));
        assert!(!matches(&other, &tag));
    }
}
