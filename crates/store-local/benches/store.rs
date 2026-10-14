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

/// A fresh store's directory, one per process and call: removed when dropped, after the measurement (a store per
/// iteration would otherwise pile up in the temporary directory).
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "tracepanel-bench-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        Self(dir)
    }

    fn store(&self) -> PathBuf {
        tracepanel_store_local::path_in(&self.0)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
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
        .with_inputs(|| {
            let scratch = Scratch::new();
            (Store::open(&scratch.store()).unwrap(), scratch)
        })
        .bench_local_values(|(mut store, scratch)| {
            store.write(&batch).unwrap();
            (store, scratch)
        });
}

/// 200 traces into a store at its size (2,000 traces, the default limit), as an agent that has been running writes:
/// in batches of 50, the last of which rotates the store (every 200 traces past the limit, the oldest go).
#[divan::bench(sample_count = 10)]
fn write_200_traces_into_a_full_store(bencher: Bencher) {
    let traces = received(2200);
    let (full, more) = traces.split_at(2000);
    let filled = Scratch::new();
    let mut store = Store::open(&filled.store()).unwrap();
    for chunk in full.chunks(100) {
        store.write(chunk).unwrap();
    }
    drop(store);
    let path = filled.store();
    bencher
        .with_inputs(|| {
            let scratch = Scratch::new();
            std::fs::create_dir_all(&scratch.0).unwrap();
            std::fs::copy(&path, scratch.store()).unwrap();
            (Store::open(&scratch.store()).unwrap(), scratch)
        })
        .bench_local_values(|(mut store, scratch)| {
            for batch in more.chunks(50) {
                store.write(batch).unwrap();
            }
            (store, scratch)
        });
}

/// A store of 500 traces, read the ways the console does; it goes with its directory.
fn filled() -> (Reader, Scratch) {
    let scratch = Scratch::new();
    let mut store = Store::open(&scratch.store()).unwrap();
    for batch in received(500).chunks(50) {
        store.write(batch).unwrap();
    }
    (Reader::new(&scratch.store()), scratch)
}

/// A search as the console sends it; "all" is no search.
fn query(name: &str) -> &str {
    if name == "all" { "" } else { name }
}

#[divan::bench(args = ["all", "has:n+1", "status:200 duration>10ms"])]
fn search_traces(bencher: Bencher, query_name: &str) {
    let ((reader, _scratch), query) = (filled(), query(query_name));
    bencher.bench_local(|| reader.search_traces(query, 50, None).unwrap());
}

#[divan::bench(args = ["all", "system:sql"])]
fn list_calls(bencher: Bencher, query_name: &str) {
    let ((reader, _scratch), query) = (filled(), query(query_name));
    let found = reader.list_calls(query, 50).unwrap();
    assert!(!found.is_empty(), "{query_name}: no calls");
    bencher.bench_local(|| reader.list_calls(query, 50).unwrap());
}

#[divan::bench]
fn list_services(bencher: Bencher) {
    let (reader, _scratch) = filled();
    bencher.bench_local(|| reader.list_services("").unwrap());
}

/// The Endpoints page: its list and its charts.
#[divan::bench]
fn list_endpoints(bencher: Bencher) {
    let (reader, _scratch) = filled();
    bencher.bench_local(|| {
        (
            reader.list_endpoints("", 50).unwrap(),
            reader.summary("", 60).unwrap(),
        )
    });
}

/// Searches as the console writes them: filters with each operator, quoted values (escaped quotes too), free text.
const SEARCHES: [&str; 8] = [
    r#"route:/api/* status>=500 duration>250ms has:n+1 user:"ann lee" -db:replica"#,
    r#"kind:page name:"/books › click \"Save\"" since:15m"#,
    "has:error since:1h service:shop",
    "method:POST route:/api/orders/* status:422",
    r#""connection reset" level:error logger:payments"#,
    "queries>20 duration>1s has:duplicates until:5m",
    "system:redis op:get key:session:* since:24h",
    "trace:01M4WQ420S1RX820WR9NMWZ8YJ",
];

/// SEARCHES parsed ROUNDS times in a pass. The benchmarks' simulation runs a pass once, and a runner's environment
/// moves a pass by some 40 µs whatever it does: a pass of a few µs read that as a change of half its time. Over a
/// millisecond of parsing it is noise, and a change to the parser shows.
const ROUNDS: usize = 600;

#[divan::bench]
fn parse_search_rounds(bencher: Bencher) {
    // Warmed up first: the allocator's and the parser's first use, which the measured pass would otherwise carry.
    std::hint::black_box(search::parse(SEARCHES[0]));
    bencher.bench_local(|| {
        (0..ROUNDS)
            .flat_map(|_| SEARCHES.iter())
            .map(|query| search::parse(std::hint::black_box(query)).len())
            .sum::<usize>()
    });
}
