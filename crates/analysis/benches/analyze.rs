//! Finding the issues in a trace: what the agent does for every trace it receives.

use divan::{Bencher, black_box};
use tracepanel_analysis::{analyze, apply, template};
use tracepanel_protocol::{Received, Thresholds, Trace};

fn main() {
    divan::main();
}

const EXAMPLES: [&str; 4] = [
    "django-n-plus-one",
    "django-async-n-plus-one",
    "fastapi-http-n-plus-one",
    "fastapi-error",
];

/// An example the Python SDK recorded (`schema/examples`), by its name.
fn example(name: &str) -> &'static str {
    match name {
        "django-n-plus-one" => {
            include_str!("../../../schema/examples/python-django-n-plus-one.json")
        }
        "django-async-n-plus-one" => {
            include_str!("../../../schema/examples/python-django-async-n-plus-one.json")
        }
        "fastapi-http-n-plus-one" => {
            include_str!("../../../schema/examples/python-fastapi-http-n-plus-one.json")
        }
        "fastapi-error" => include_str!("../../../schema/examples/python-fastapi-error.json"),
        _ => unreachable!("{name}"),
    }
}

fn trace(doc: &str) -> Trace {
    serde_json::from_str(doc).unwrap()
}

#[divan::bench(args = EXAMPLES)]
fn analyze_a_trace(bencher: Bencher, name: &str) {
    let trace = trace(example(name));
    let thresholds = Thresholds::default();
    bencher.bench_local(|| analyze(&trace, &thresholds));
}

/// A trace made ready for the store: its issues found and written into its document.
#[divan::bench(args = ["django-n-plus-one", "fastapi-http-n-plus-one"])]
fn apply_to_a_received_trace(bencher: Bencher, name: &str) {
    let doc = example(name);
    let thresholds = Thresholds::default();
    bencher
        .with_inputs(|| Received {
            trace: trace(doc),
            doc: doc.to_owned(),
        })
        .bench_local_values(|mut received| {
            apply(&mut received, &thresholds);
            received
        });
}

#[divan::bench]
fn template_keys_and_paths(bencher: Bencher) {
    let texts = [
        "user:42:profile",
        "session:5f2b9c1e-8d3a-4c7e-9b1a-2e6f4d8c0a17",
        "/api/v1/orders/1234/items/56",
        "/static/app.3f9c2a1b.js",
        "cache:views.decorators.cache.cache_page..GET.a1b2c3d4e5f6",
    ];
    bencher.bench_local(|| {
        texts
            .iter()
            .map(|text| template(black_box(text)))
            .collect::<Vec<_>>()
    });
}
