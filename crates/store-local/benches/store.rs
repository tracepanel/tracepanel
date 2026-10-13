//! The local store: writing what the SDKs send, and the console's reads.

use divan::Bencher;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use tracepanel_protocol::{Received, Thresholds};
use tracepanel_store_local::{Reader, Store, search};

fn main() {
    divan::main();
}

const EXAMPLES: [&str; 5] = [
    include_str!("../../../schema/examples/python-django-n-plus-one.json"),
    include_str!("../../../schema/examples/python-django-duplicates.json"),
    include_str!("../../../schema/examples/python-fastapi-http-n-plus-one.json"),
    include_str!("../../../schema/examples/python-fastapi-error.json"),
    include_str!("../../../schema/examples/python-django-in-transaction.json"),
];

/// A fresh store's path: one per process and call, removed first.
fn fresh() -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "tracepanel-bench-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    tracepanel_store_local::path_in(&dir)
}

/// `count` traces as the agent stores them, each with an id of its own, their issues found.
fn received(count: usize) -> Vec<Received> {
    (0..count)
        .map(|index| {
            let mut doc: serde_json::Value =
                serde_json::from_str(EXAMPLES[index % EXAMPLES.len()]).unwrap();
            doc["id"] = format!("01M4GPC1BHG83SW8X46{index:07}").into();
            doc["start"] = (1_791_000_000_000_000_i64 + index as i64 * 1_000_000).into();
            let mut received = Received {
                trace: serde_json::from_value(doc.clone()).unwrap(),
                doc: doc.to_string(),
            };
            tracepanel_analysis::apply(&mut received, &Thresholds::default());
            received
        })
        .collect()
}

#[divan::bench]
fn write_a_batch_of_50_traces(bencher: Bencher) {
    let batch = received(50);
    bencher
        .with_inputs(|| Store::open(&fresh()).unwrap())
        .bench_local_values(|mut store| {
            store.write(&batch).unwrap();
            store
        });
}

/// A store of 500 traces, read the ways the console does.
fn filled() -> Reader {
    let path = fresh();
    let mut store = Store::open(&path).unwrap();
    for batch in received(500).chunks(50) {
        store.write(batch).unwrap();
    }
    Reader::new(&path)
}

/// A search as the console sends it; "all" is no search.
fn query(name: &str) -> &str {
    if name == "all" { "" } else { name }
}

#[divan::bench(args = ["all", "has:n+1", "status:200 duration>10ms"])]
fn search_traces(bencher: Bencher, query_name: &str) {
    let (reader, query) = (filled(), query(query_name));
    bencher.bench_local(|| reader.search_traces(query, 50, None).unwrap());
}

#[divan::bench(args = ["all", "system:sql"])]
fn list_calls(bencher: Bencher, query_name: &str) {
    let (reader, query) = (filled(), query(query_name));
    let found = reader.list_calls(query, 50).unwrap();
    assert!(!found.is_empty(), "{query_name}: no calls");
    bencher.bench_local(|| reader.list_calls(query, 50).unwrap());
}

#[divan::bench]
fn list_services(bencher: Bencher) {
    let reader = filled();
    bencher.bench_local(|| reader.list_services("").unwrap());
}

#[divan::bench]
fn parse_a_search(bencher: Bencher) {
    bencher.bench_local(|| {
        search::parse(
            r#"route:/api/* status>=500 duration>250ms has:n+1 user:"ann lee" -db:replica"#,
        )
    });
}
