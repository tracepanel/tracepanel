//! The console: its HTTP API, the UI and widget.min.js.
//!
//! The console's API (`schema/openapi.yaml`), read from the store. EXPLAIN and switching users need the app's
//! framework: the app serves them itself and forwards the rest here (Django's `/__tracepanel__/`).

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use rust_embed::Embed;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use tracepanel_protocol::Activity;
use tracepanel_store_local::{ReadError, Reader};

/// The console's UI, built from `ui/` into `ui-dist/` (`scripts/ui.sh`): what the browser loads, not the notices.
#[derive(Embed)]
#[folder = "../../ui-dist/"]
#[exclude = "*.map"]
#[exclude = "NOTICES"]
struct Assets;

const MAX_LIMIT: i64 = 500;

type Shared = Arc<Reader>;
type Params = Query<HashMap<String, String>>;

pub fn router(reader: Reader, activity: Activity) -> Router {
    Router::new()
        .route("/api/traces", get(traces))
        .route("/api/traces/{id}", get(trace))
        .route("/api/traces/{id}/related", get(related))
        .route("/api/counts", get(counts))
        .route("/api/search", get(search_spec))
        .route("/api/logs", get(logs))
        .route("/api/queries", get(queries))
        .route("/api/calls", get(calls))
        .route("/api/redis", get(redis))
        .route("/api/cache", get(cache))
        .route("/api/mails", get(mails))
        .route("/api/values", get(values))
        .route("/api/issues", get(issues))
        .route("/api/issues/detail", get(issue_detail))
        .route("/api/services", get(services))
        .route("/api/store", axum::routing::delete(clear))
        .route("/api/endpoints", get(endpoints))
        .route("/api/endpoints/detail", get(endpoint_detail))
        .route("/api/tasks", get(tasks))
        .route("/api/websockets", get(websockets))
        .route("/api/graphql", get(graphql))
        .route("/api/graphql/detail", get(graphql_detail))
        .route("/api/jobs", get(jobs))
        .route("/api/traces/summary", get(summary))
        .route("/api/traces/overview", get(overview))
        .route("/api/{*rest}", any(unknown))
        .fallback(static_handler)
        .with_state(Arc::new(reader))
        // A console in use keeps an agent started on demand running.
        .layer(axum::middleware::from_fn_with_state(activity, touch))
        .layer(axum::middleware::from_fn(local_pages))
}

/// Pages of apps on this machine (another port: a Go app's) may read the API: the widget asks for its requests'
/// issues. Other sites may not, and nothing but GET is allowed across origins.
async fn local_pages(request: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let origin = request.headers().get(header::ORIGIN).cloned();
    let read = request.method() == Method::GET;
    let mut response = next.run(request).await;
    if let Some(origin) = origin.filter(|origin| read && is_local(origin.to_str().unwrap_or(""))) {
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        response
            .headers_mut()
            .insert(header::VARY, HeaderValue::from_static("Origin"));
    }
    response
}

fn is_local(origin: &str) -> bool {
    let Some(rest) = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
    else {
        return false;
    };
    let host = rest.rsplit_once(':').map_or(rest, |(host, port)| {
        if port.chars().all(|c| c.is_ascii_digit()) {
            host
        } else {
            rest
        }
    });
    matches!(host, "localhost" | "127.0.0.1" | "[::1]") || host.ends_with(".localhost")
}

async fn touch(
    State(activity): State<Activity>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    activity.touch();
    next.run(request).await
}

pub async fn serve_on(
    listener: tokio::net::TcpListener,
    reader: Reader,
    activity: Activity,
) -> std::io::Result<()> {
    axum::serve(listener, router(reader, activity)).await
}

fn json_response(status: StatusCode, body: String) -> Response {
    (status, [(header::CONTENT_TYPE, "application/json")], body).into_response()
}

fn not_found() -> Response {
    json_response(
        StatusCode::NOT_FOUND,
        json!({"error": "not found"}).to_string(),
    )
}

/// A read that failed: a search the user can fix (400, its message shown as it is) or the store (500).
struct Failure(StatusCode, String);

impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        json_response(self.0, json!({"error": self.1}).to_string())
    }
}

/// SQLite reads block: off the async runtime.
async fn read<T: Send + 'static>(
    reader: &Shared,
    work: impl FnOnce(&Reader) -> Result<T, ReadError> + Send + 'static,
) -> Result<T, Failure> {
    let reader = reader.clone();
    match tokio::task::spawn_blocking(move || work(&reader)).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(ReadError::Search(message))) => Err(Failure(StatusCode::BAD_REQUEST, message)),
        Ok(Err(ReadError::Store(error))) => Err(Failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            error.to_string(),
        )),
        Err(error) => Err(Failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            error.to_string(),
        )),
    }
}

/// The JSON of a read, or its failure.
fn answer(result: Result<Value, Failure>) -> Response {
    match result {
        Ok(value) => json_response(StatusCode::OK, value.to_string()),
        Err(failure) => failure.into_response(),
    }
}

fn limit(query: &HashMap<String, String>) -> i64 {
    query
        .get("limit")
        .and_then(|value| value.parse::<i64>().ok())
        .map_or(100, |value| value.clamp(1, MAX_LIMIT))
}

/// `before`: the cursor of a page, digits only.
fn before(query: &HashMap<String, String>) -> Option<i64> {
    query
        .get("before")
        .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|value| value.parse().ok())
}

fn q(query: &HashMap<String, String>) -> String {
    query.get("q").cloned().unwrap_or_default()
}

fn is_id(id: &str) -> bool {
    id.len() == 26
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte.is_ascii_uppercase())
}

async fn traces(State(reader): State<Shared>, Query(query): Params) -> Response {
    let ids: Vec<String> = query
        .get("ids")
        .map(|ids| {
            ids.split(',')
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let limit = limit(&query);
    if !ids.is_empty() {
        return answer(
            read(&reader, move |reader| {
                Ok(json!({"traces": reader.list_traces(&ids, limit)?, "next": null}))
            })
            .await,
        );
    }
    let (q, before) = (q(&query), before(&query));
    answer(
        read(&reader, move |reader| {
            let page = reader.search_traces(&q, limit, before)?;
            Ok(json!({"traces": page.items, "next": page.next}))
        })
        .await,
    )
}

async fn trace(State(reader): State<Shared>, Path(id): Path<String>) -> Response {
    if !is_id(&id) {
        return not_found();
    }
    match read(&reader, move |reader| Ok(reader.get_trace(&id)?)).await {
        Ok(Some(doc)) => json_response(StatusCode::OK, doc),
        Ok(None) => not_found(),
        Err(failure) => failure.into_response(),
    }
}

async fn related(State(reader): State<Shared>, Path(id): Path<String>) -> Response {
    if !is_id(&id) {
        return not_found();
    }
    answer(read(&reader, move |reader| Ok(reader.related(&id)?)).await)
}

async fn counts(State(reader): State<Shared>, Query(query): Params) -> Response {
    let service = query.get("service").cloned();
    answer(
        read(
            &reader,
            move |reader| Ok(reader.counts(service.as_deref())?),
        )
        .await,
    )
}

async fn logs(State(reader): State<Shared>, Query(query): Params) -> Response {
    let (q, limit, before) = (q(&query), limit(&query), before(&query));
    answer(
        read(&reader, move |reader| {
            let page = reader.search_logs(&q, limit, before)?;
            Ok(json!({"logs": page.items, "next": page.next}))
        })
        .await,
    )
}

async fn queries(State(reader): State<Shared>, Query(query): Params) -> Response {
    let (q, limit) = (q(&query), limit(&query));
    answer(
        read(&reader, move |reader| {
            Ok(json!({"queries": reader.list_queries(&q, limit)?}))
        })
        .await,
    )
}

async fn calls(State(reader): State<Shared>, Query(query): Params) -> Response {
    let (q, limit) = (q(&query), limit(&query));
    answer(
        read(&reader, move |reader| {
            Ok(json!({"calls": reader.list_calls(&q, limit)?}))
        })
        .await,
    )
}

async fn redis(State(reader): State<Shared>, Query(query): Params) -> Response {
    let (q, limit) = (q(&query), limit(&query));
    answer(
        read(&reader, move |reader| {
            Ok(json!({"redis": reader.list_redis(&q, limit)?}))
        })
        .await,
    )
}

async fn cache(State(reader): State<Shared>, Query(query): Params) -> Response {
    let (q, limit) = (q(&query), limit(&query));
    answer(
        read(&reader, move |reader| {
            Ok(json!({"cache": reader.list_cache(&q, limit)?}))
        })
        .await,
    )
}

async fn mails(State(reader): State<Shared>, Query(query): Params) -> Response {
    let (q, limit, before) = (q(&query), limit(&query), before(&query));
    answer(
        read(&reader, move |reader| {
            let page = reader.list_mails(&q, limit, before)?;
            Ok(json!({"mails": page.items, "next": page.next}))
        })
        .await,
    )
}

async fn values(State(reader): State<Shared>, Query(query): Params) -> Response {
    let service = service(&query);
    answer(read(&reader, move |reader| reader.known_values(&service)).await)
}

/// `service=`: one app's data, as the console's app switcher picks it; "" or absent is every app.
fn service(query: &HashMap<String, String>) -> String {
    query.get("service").cloned().unwrap_or_default()
}

async fn issues(State(reader): State<Shared>, Query(query): Params) -> Response {
    let (q, limit) = (q(&query), limit(&query));
    answer(
        read(&reader, move |reader| {
            Ok(json!({"issues": reader.list_issues(&q, limit)?}))
        })
        .await,
    )
}

async fn issue_detail(State(reader): State<Shared>, Query(query): Params) -> Response {
    let fingerprint = query.get("fingerprint").cloned().unwrap_or_default();
    let q = q(&query);
    match read(&reader, move |reader| {
        reader.issue_detail(&fingerprint, &q, 40, 50)
    })
    .await
    {
        Ok(Some(detail)) => json_response(StatusCode::OK, detail.to_string()),
        Ok(None) => not_found(),
        Err(failure) => failure.into_response(),
    }
}

async fn services(State(reader): State<Shared>, Query(query): Params) -> Response {
    let q = q(&query);
    answer(read(&reader, move |reader| reader.list_services(&q)).await)
}

/// DELETE, not POST: another site can't send one without a CORS preflight, and the console never allows one.
async fn clear(State(reader): State<Shared>) -> Response {
    answer(read(&reader, |reader| Ok(json!({"deleted": reader.clear()?}))).await)
}

/// A list resource: `{"<key>": rows}` from a search with a limit.
async fn listing(
    reader: Shared,
    query: HashMap<String, String>,
    key: &'static str,
    list: fn(&Reader, &str, i64) -> Result<Vec<Value>, ReadError>,
) -> Response {
    let (q, limit) = (q(&query), limit(&query));
    answer(
        read(&reader, move |reader| {
            Ok(json!({ key: list(reader, &q, limit)? }))
        })
        .await,
    )
}

/// A detail resource: its JSON, or 404 when nothing matches.
fn found(result: Result<Option<Value>, Failure>) -> Response {
    match result {
        Ok(Some(value)) => json_response(StatusCode::OK, value.to_string()),
        Ok(None) => not_found(),
        Err(failure) => failure.into_response(),
    }
}

async fn endpoints(State(reader): State<Shared>, Query(query): Params) -> Response {
    listing(reader, query, "endpoints", Reader::list_endpoints).await
}

async fn tasks(State(reader): State<Shared>, Query(query): Params) -> Response {
    listing(reader, query, "tasks", Reader::list_tasks).await
}

async fn websockets(State(reader): State<Shared>, Query(query): Params) -> Response {
    listing(reader, query, "websockets", Reader::list_websockets).await
}

async fn graphql(State(reader): State<Shared>, Query(query): Params) -> Response {
    listing(reader, query, "graphql", Reader::list_graphql).await
}

async fn jobs(State(reader): State<Shared>, Query(query): Params) -> Response {
    listing(reader, query, "jobs", Reader::list_jobs).await
}

async fn endpoint_detail(State(reader): State<Shared>, Query(query): Params) -> Response {
    let method = query.get("method").cloned().unwrap_or_else(|| "GET".into());
    let route = query.get("route").cloned().unwrap_or_default();
    let service = service(&query);
    found(
        read(&reader, move |reader| {
            reader.endpoint_detail(&method, &route, &service, 40)
        })
        .await,
    )
}

async fn graphql_detail(State(reader): State<Shared>, Query(query): Params) -> Response {
    let operation = query.get("operation").cloned().unwrap_or_default();
    let service = service(&query);
    found(
        read(&reader, move |reader| {
            reader.graphql_detail(&operation, &service, 40)
        })
        .await,
    )
}

async fn summary(State(reader): State<Shared>, Query(query): Params) -> Response {
    let q = q(&query);
    found(read(&reader, move |reader| reader.summary(&q, 40)).await)
}

async fn overview(State(reader): State<Shared>, Query(query): Params) -> Response {
    let group = query
        .get("group")
        .cloned()
        .unwrap_or_else(|| "operation".into());
    if group != "operation" && group != "endpoint" {
        return Failure(
            StatusCode::BAD_REQUEST,
            "group must be operation or endpoint".into(),
        )
        .into_response();
    }
    let q = q(&query);
    answer(
        read(&reader, move |reader| {
            reader.traces_overview(&q, 60, &group)
        })
        .await,
    )
}

async fn search_spec() -> Response {
    json_response(
        StatusCode::OK,
        tracepanel_store_local::search::SPEC.to_owned(),
    )
}

async fn unknown(method: Method) -> Response {
    if method == Method::GET {
        not_found()
    } else {
        json_response(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({"error": "method not allowed"}).to_string(),
        )
    }
}

async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    // Unknown paths fall back to index.html: the SPA handles routing.
    let (path, file) = match Assets::get(path) {
        Some(file) if !path.is_empty() => (path, file),
        _ => match Assets::get("index.html") {
            Some(file) => ("index.html", file),
            None => {
                return (
                    StatusCode::NOT_FOUND,
                    "UI is not installed: run scripts/ui.sh and rebuild",
                )
                    .into_response();
            }
        },
    };
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    // The page asks for its files with their version (`tracepanel.min.js?v=…`), and fonts carry a hash in their name:
    // those never change, cached for good. The page itself and widget.min.js (an SDK's <script>) never cached.
    let versioned = uri.query().is_some_and(|query| query.starts_with("v="));
    let cache = if versioned || path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let mut response = ([(header::CONTENT_TYPE, mime.as_ref())], file.data).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    response
}

#[cfg(test)]
mod tests {
    use super::is_local;

    #[test]
    fn only_pages_on_this_machine_are_local() {
        for origin in [
            "http://127.0.0.1:18021",
            "http://localhost:3000",
            "http://[::1]:8000",
            "http://app.localhost",
        ] {
            assert!(is_local(origin), "{origin}");
        }
        for origin in [
            "https://example.com",
            "http://127.0.0.1.example.com",
            "null",
            "http://localhost.evil:80",
        ] {
            assert!(!is_local(origin), "{origin}");
        }
    }
}
