//! OpenTelemetry's exports, as an OTLP/HTTP exporter sends them: decoded, then assembled into the agent's traces.

use axum::http::HeaderMap;
use divan::Bencher;
use std::time::Instant;
use tracepanel_otlp::assemble::{Assembler, QUIET};

fn main() {
    divan::main();
}

/// Recorded from the Python SDK's exporter (protobuf): three exports of one request's spans.
const EXPORTS: [&[u8]; 3] = [
    include_bytes!("../tests/fixtures/python-0.pb"),
    include_bytes!("../tests/fixtures/python-1.pb"),
    include_bytes!("../tests/fixtures/python-2.pb"),
];

#[divan::bench]
fn decode_exports(bencher: Bencher) {
    let headers = HeaderMap::new();
    bencher.bench_local(|| {
        EXPORTS
            .map(|export| tracepanel_otlp::decode(&headers, export).unwrap())
            .len()
    });
}

#[divan::bench]
fn assemble_traces(bencher: Bencher) {
    let headers = HeaderMap::new();
    let start = Instant::now();
    bencher
        .with_inputs(|| EXPORTS.map(|export| tracepanel_otlp::decode(&headers, export).unwrap()))
        .bench_local_values(|requests| {
            let mut assembler = Assembler::default();
            for request in requests {
                assembler.add(request, start);
            }
            assembler.ready(start + QUIET)
        });
}

/// An axum app's export through tracing-opentelemetry (OTLP/JSON): a request whose queries sqlx logged as events.
const RUST_EXPORT: &[u8] = include_bytes!("../tests/fixtures/rust-tracing.json");

#[divan::bench]
fn assemble_rust_traces(bencher: Bencher) {
    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("application/json"),
    );
    let start = Instant::now();
    bencher
        .with_inputs(|| tracepanel_otlp::decode(&headers, RUST_EXPORT).unwrap())
        .bench_local_values(|request| {
            let mut assembler = Assembler::default();
            assembler.add(request, start);
            assembler.ready(start + QUIET)
        });
}
