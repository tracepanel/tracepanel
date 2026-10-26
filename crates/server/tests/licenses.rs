//! The licenses the binary carries, served to the console's Licenses link: the agent's own and every third party's.

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use tower::ServiceExt;
use tracepanel_protocol::Activity;
use tracepanel_store_local::{Reader, Store};

#[tokio::test]
async fn the_licenses_are_served_as_text() {
    let dir = std::env::temp_dir().join(format!("tracepanel-licenses-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = tracepanel_store_local::path_in(&dir);
    Store::open(&path).unwrap();
    let router = tracepanel_server::router(Reader::new(&path), Activity::default());

    let request = Request::get("/api/licenses").body(Body::empty()).unwrap();
    let response = router.oneshot(request).await.unwrap();
    let status = response.status();
    let kind = response.headers()[header::CONTENT_TYPE].clone();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let text = String::from_utf8(body.to_vec()).unwrap();

    assert_eq!(status, StatusCode::OK);
    assert_eq!(kind, "text/plain; charset=utf-8");

    assert_eq!(text, tracepanel_server::LICENSES);
    assert!(
        text.starts_with("# Functional Source License"),
        "{}",
        &text[..80]
    );
    for part in [
        "Copyright 2026 DevRealm OÜ",
        "Rust crates",
        "The Rust standard library",
        "musl",
        "Console (JavaScript, fonts)",
        "tailwindcss",
        "shadcn/ui components",
    ] {
        assert!(text.contains(part), "no {part}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}
