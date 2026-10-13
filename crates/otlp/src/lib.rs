//! OTLP/HTTP in: the agent as an OpenTelemetry exporter's endpoint (`http://127.0.0.1:4318`, the exporters' default).
//!
//! `POST /v1/traces` takes an `ExportTraceServiceRequest`, protobuf or JSON, gzipped or not. Its spans wait in
//! `assemble` for the rest of their traces, which then go where the SDKs' do (the store writer's queue) as trace
//! documents with `otel` spans: the agent maps those by the semantic conventions, finds the issues and keeps them, as
//! it does an SDK's. Any language whose OpenTelemetry SDK exports OTLP shows in the console with no Tracepanel SDK.

pub mod assemble;
pub mod json;
pub mod proto;

use assemble::Assembler;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use prost::Message;
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracepanel_protocol::{Activity, Batch, Sink, Thresholds};

/// The largest export taken: exporters send a few MB at most.
const MAX_BODY: usize = 64 << 20;
/// How often waiting traces are looked at.
const TICK: Duration = Duration::from_millis(500);

#[derive(Clone)]
struct Shared {
    assembler: Arc<Mutex<Assembler>>,
    activity: Activity,
}

/// The request's body, gunzipped when it says so.
fn body(headers: &HeaderMap, bytes: &[u8]) -> Result<Vec<u8>, String> {
    let gzip = headers
        .get(header::CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("gzip"));
    if !gzip {
        return Ok(bytes.to_vec());
    }
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(bytes)
        .take(MAX_BODY as u64)
        .read_to_end(&mut out)
        .map_err(|error| format!("gzip: {error}"))?;
    Ok(out)
}

fn is_json(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"))
}

/// An export's request, by its content type.
pub fn decode(
    headers: &HeaderMap,
    bytes: &[u8],
) -> Result<proto::ExportTraceServiceRequest, String> {
    let bytes = body(headers, bytes)?;
    if is_json(headers) {
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|error| format!("JSON: {error}"))?;
        Ok(json::request(&value))
    } else {
        proto::ExportTraceServiceRequest::decode(bytes.as_slice())
            .map_err(|error| format!("protobuf: {error}"))
    }
}

/// An empty `ExportTraceServiceResponse`: every span taken. In the request's encoding.
fn accepted(json: bool) -> Response {
    if json {
        ([(header::CONTENT_TYPE, "application/json")], "{}").into_response()
    } else {
        (
            [(header::CONTENT_TYPE, "application/x-protobuf")],
            Vec::<u8>::new(),
        )
            .into_response()
    }
}

async fn traces(State(shared): State<Shared>, headers: HeaderMap, bytes: Bytes) -> Response {
    shared.activity.touch();
    match decode(&headers, &bytes) {
        Ok(request) => {
            if let Ok(mut assembler) = shared.assembler.lock() {
                assembler.add(request, now());
            }
            accepted(is_json(&headers))
        }
        Err(error) => (StatusCode::BAD_REQUEST, error).into_response(),
    }
}

/// Tokio's clock: the same as the system's, and paused and moved on by tests.
fn now() -> std::time::Instant {
    tokio::time::Instant::now().into_std()
}

/// The traces as one frame, as an SDK would send them, with the default limits for finding issues.
fn batch(docs: &[serde_json::Value]) -> Option<Batch> {
    Some(Batch {
        frame: serde_json::to_vec(docs).ok()?,
        max_traces: None,
        thresholds: Thresholds::default(),
    })
}

/// Waiting traces, sent on as they are ready.
async fn forward(assembler: Arc<Mutex<Assembler>>, sink: Sink) {
    let mut tick = tokio::time::interval(TICK);
    loop {
        tick.tick().await;
        let docs = match assembler.lock() {
            Ok(mut assembler) => assembler.ready(now()),
            Err(_) => return,
        };
        if let Some(batch) = (!docs.is_empty()).then(|| batch(&docs)).flatten() {
            sink(batch);
        }
    }
}

pub fn router(sink: Sink, activity: Activity) -> Router {
    let assembler = Arc::new(Mutex::new(Assembler::default()));
    tokio::spawn(forward(assembler.clone(), sink));
    Router::new()
        .route("/v1/traces", post(traces))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .with_state(Shared {
            assembler,
            activity,
        })
}

/// Serves OTLP/HTTP on the listener until the task is dropped.
pub async fn serve(
    listener: tokio::net::TcpListener,
    sink: Sink,
    activity: Activity,
) -> std::io::Result<()> {
    axum::serve(listener, router(sink, activity)).await
}
