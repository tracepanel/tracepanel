//! What every frame from an SDK costs before anything else: its traces decoded.

use divan::Bencher;
use tracepanel_protocol::{Batch, Thresholds};

fn main() {
    divan::main();
}

const N_PLUS_ONE: &str = include_str!("../../../schema/examples/python-django-n-plus-one.json");
const ERROR: &str = include_str!("../../../schema/examples/python-fastapi-error.json");

/// A frame of 50 traces, as the SDK's writer sends a batch.
fn frame(example: &str) -> Vec<u8> {
    let docs: Vec<&str> = std::iter::repeat_n(example, 50).collect();
    format!("[{}]", docs.join(",")).into_bytes()
}

#[divan::bench(args = ["n-plus-one", "error"])]
fn decode_a_frame_of_50_traces(bencher: Bencher, name: &str) {
    let example = if name == "error" { ERROR } else { N_PLUS_ONE };
    let batch = Batch {
        frame: frame(example),
        max_traces: None,
        thresholds: Thresholds::default(),
    };
    bencher.bench_local(|| batch.decode().unwrap());
}
