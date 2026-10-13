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
