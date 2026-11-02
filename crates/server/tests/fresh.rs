//! The API's reads are cheap to ask again: an ETag on each, a 304 when nothing changed, gzip when the browser takes it.

use axum::body::Body;
use axum::http::{HeaderValue, Request, StatusCode, header};
use flate2::read::GzDecoder;
use std::io::Read;
use tower::ServiceExt;
use tracepanel_protocol::Activity;
use tracepanel_store_local::{Reader, Store};

#[tokio::test]
async fn an_unchanged_answer_is_a_304_and_a_large_one_goes_gzipped() {
    let dir = std::env::temp_dir().join(format!("tracepanel-fresh-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = tracepanel_store_local::path_in(&dir);
    Store::open(&path).unwrap();
    let router = tracepanel_server::router(Reader::new(&path), Activity::default());

    let asked = Request::get("/api/licenses")
        .header(header::ACCEPT_ENCODING, "gzip, deflate, br")
        .body(Body::empty())
        .unwrap();
    let first = router.clone().oneshot(asked).await.unwrap();
    let status = first.status();
    let headers = first.headers().clone();
    let packed = axum::body::to_bytes(first.into_body(), usize::MAX)
        .await
        .unwrap();
    let mut text = String::new();
    GzDecoder::new(&packed[..])
        .read_to_string(&mut text)
        .unwrap();

    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_ENCODING], "gzip");
    assert_eq!(headers[header::CACHE_CONTROL], "no-cache");
    assert_eq!(headers[header::VARY], "Accept-Encoding");
    assert_eq!(text, tracepanel_server::LICENSES);
    assert!(
        packed.len() < text.len() / 2,
        "{} of {}",
        packed.len(),
        text.len()
    );

    let tag = headers[header::ETAG].clone();
    let again = Request::get("/api/licenses")
        .header(header::IF_NONE_MATCH, tag.clone())
        .body(Body::empty())
        .unwrap();
    let second = router.clone().oneshot(again).await.unwrap();
    let status = second.status();
    let etag = second.headers()[header::ETAG].clone();
    let body = axum::body::to_bytes(second.into_body(), usize::MAX)
        .await
        .unwrap();

    assert_eq!(status, StatusCode::NOT_MODIFIED);
    assert_eq!(etag, tag);
    assert!(body.is_empty());

    let plain = Request::get("/api/licenses")
        .header(header::IF_NONE_MATCH, HeaderValue::from_static("\"other\""))
        .body(Body::empty())
        .unwrap();
    let third = router.oneshot(plain).await.unwrap();
    let status = third.status();
    let encoding = third.headers().get(header::CONTENT_ENCODING).cloned();
    let body = axum::body::to_bytes(third.into_body(), usize::MAX)
        .await
        .unwrap();

    assert_eq!(status, StatusCode::OK);
    assert_eq!(encoding, None);
    assert_eq!(body, tracepanel_server::LICENSES.as_bytes());
    let _ = std::fs::remove_dir_all(&dir);
}
