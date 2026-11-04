//! A profile's frames as the console and the MCP server read them: which are tracing's own code, never the app's;
//! which of a JVM's are classes made at runtime, never the app's either, and which wait rather than compute. And a
//! profile that doesn't say when it saw its stacks (Go's CPU profile) placed on the trace's clock (`spread`), so every
//! profile is read by one rule: when each stack was seen, bucket by bucket.

use crate::stretches::{OWN_CODE, spans_of, stretches};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use tracepanel_protocol::Received;

/// Tracing's own code by its module's or its file's start, as each SDK names them: OpenTelemetry's and Tracepanel's
/// SDKs in every language, and the hooks they patch a Node app's modules with. The console's `TRACING` is the same.
const TRACING: [&str; 12] = [
    "@opentelemetry/",
    "@tracepanel/",
    "require-in-the-middle/",
    "import-in-the-middle/",
    "opentelemetry.",
    "opentelemetry/",
    "tracepanel.",
    "tracepanel/",
    "io.opentelemetry.",
    "dev.tracepanel.",
    "go.opentelemetry.io/",
    "github.com/tracepanel/",
];

/// Whether a frame not the app's is tracing's own code (a span started, an attribute set): by its module, else its
/// file.
pub fn tracing(module: &str, file: &str) -> bool {
    let name = if module.is_empty() { file } else { module };
    TRACING.iter().any(|prefix| name.starts_with(prefix))
}

/// A JVM's methods a thread waits in (parked, asleep, polling a socket): a sample whose innermost frame is one waited,
/// as the Python SDK marks its waits. By their class and their method.
const JVM_WAITS: [(&str, &[&str]); 10] = [
    ("java.lang.VirtualThread", &["park", "parkNanos"]),
    ("jdk.internal.misc.Unsafe", &["park"]),
    ("java.lang.Object", &["wait", "wait0"]),
    (
        "java.lang.Thread",
        &["sleep", "sleep0", "sleepNanos", "sleepNanos0"],
    ),
    ("sun.nio.ch.KQueue", &["poll"]),
    ("sun.nio.ch.EPoll", &["wait"]),
    ("sun.nio.ch.WEPoll", &["wait"]),
    ("sun.nio.ch.Net", &["poll"]),
    ("sun.nio.ch.SocketDispatcher", &["read0"]),
    ("java.net.SocketInputStream", &["socketRead0"]),
];

/// A JVM's frame by its file: Java's, Kotlin's, Scala's, Groovy's.
fn jvm(frame: &Value) -> bool {
    let file = frame
        .get("file")
        .and_then(Value::as_str)
        .unwrap_or_default();
    [".java", ".kt", ".scala", ".groovy"]
        .iter()
        .any(|extension| file.ends_with(extension))
}

/// A class made at runtime, whatever package it is in: Hibernate's lazy proxies (Brand$HibernateProxy, or with a
/// suffix), Spring's CGLIB subclasses and lambdas ($$), ByteBuddy's, the JDK's interface proxies ($Proxy172).
fn generated(class: &str) -> bool {
    let simple = class.rsplit('.').next().unwrap_or(class);
    class.contains("$$")
        || class.contains("$HibernateProxy")
        || class.contains("$ByteBuddy$")
        || simple.starts_with("$Proxy")
}

/// Whether a JVM frame is a method threads wait in.
fn jvm_wait(class: &str, function: &str) -> bool {
    let method = function.rsplit('.').next().unwrap_or(function);
    JVM_WAITS
        .iter()
        .any(|(waits, methods)| *waits == class && methods.contains(&method))
}

/// A profile's frames as the console reads them, whichever SDK sent them: a JVM's class made at runtime is never
/// the app's (an SDK that took Brand$HibernateProxy for the app's), and its methods threads wait in wait. Whether
/// any changed.
fn frames(profile: &mut Value) -> bool {
    let mut changed = false;
    for frame in profile
        .get_mut("frames")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        if !jvm(frame) {
            continue;
        }
        let text = |key: &str| {
            frame
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        let (class, function) = (text("module"), text("function"));
        if frame.get("in_app") == Some(&Value::Bool(true)) && generated(&class) {
            frame["in_app"] = Value::Bool(false);
            changed = true;
        }
        if frame.get("waiting") != Some(&Value::Bool(true)) && jvm_wait(&class, &function) {
            frame["waiting"] = Value::Bool(true);
            changed = true;
        }
    }
    changed
}

/// Whether a frame is tracing's own code, never the app's.
fn tracing_frame(frame: &Value) -> bool {
    let text = |key: &str| frame.get(key).and_then(Value::as_str).unwrap_or_default();
    frame.get("in_app") != Some(&Value::Bool(true)) && tracing(text("module"), text("file"))
}

/// A profile's memory without the sites tracing's own code allocated in (the SDK's profiler counting its samples,
/// a span's attributes): never the app's memory, whichever SDK sent them. Whether any were.
fn sites(profile: &mut Value) -> bool {
    let frames = profile
        .get("frames")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let Some(sites) = profile
        .get_mut("memory")
        .and_then(|memory| memory.get_mut("sites"))
        .and_then(Value::as_array_mut)
    else {
        return false;
    };
    let before = sites.len();
    sites.retain(|site| {
        let leaf = site
            .get("frames")
            .and_then(Value::as_array)
            .and_then(|indexes| indexes.last())
            .and_then(Value::as_u64)
            .and_then(|index| frames.get(usize::try_from(index).ok()?));
        !leaf.is_some_and(tracing_frame)
    });
    sites.len() != before
}

/// How wide a bucket of a profile's `at` is (µs), as the SDKs that say when they saw a stack count them.
const BUCKET_US: i64 = 10_000;

/// The SDKs whose profile is the CPU's time alone: Go's (runtime/pprof samples the goroutines on a CPU, and keeps no
/// sample's time), and Node's before it said when it saw each stack (it left the idle loop's samples out).
const CPU_ONLY: [&str; 2] = ["go", "nodejs"];

/// The frame a CPU profile's time off the CPU is spread as: waiting (`waiting · off CPU`).
const OFF_CPU: &str = "off CPU";

/// Whether a profile says when its stacks were seen: its buckets' width, and buckets on its stacks.
fn timed(profile: &Value) -> bool {
    profile
        .get("bucket_us")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        > 0
        && stacks_of(profile).any(|stack| {
            stack
                .get("at")
                .and_then(Value::as_array)
                .is_some_and(|at| !at.is_empty())
        })
}

fn stacks_of(profile: &Value) -> impl Iterator<Item = &Value> {
    profile
        .get("stacks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

/// Whole counts in proportion to `weights`, adding up to `total`: each rounded down, the rest to those that lost most
/// (largest remainder), the first of them on a tie.
fn apportion(weights: &[f64], total: i64) -> Vec<i64> {
    let sum: f64 = weights.iter().sum();
    if sum <= 0.0 || total <= 0 {
        return vec![0; weights.len()];
    }
    let exact: Vec<f64> = weights
        .iter()
        .map(|weight| weight * total as f64 / sum)
        .collect();
    let mut counts: Vec<i64> = exact
        .iter()
        .map(|value| (value + 1e-9).floor() as i64)
        .collect();
    let mut order: Vec<usize> = (0..weights.len()).collect();
    let remainder = |at: usize| exact[at] - (exact[at] + 1e-9).floor();
    order.sort_by(|&a, &b| remainder(b).total_cmp(&remainder(a)).then(a.cmp(&b)));
    let mut left = total - counts.iter().sum::<i64>();
    for at in order {
        if left <= 0 {
            break;
        }
        counts[at] += 1;
        left -= 1;
    }
    counts
}

/// A CPU profile (CPU_ONLY) that doesn't say when it saw its stacks, placed on the trace's clock in BUCKET_US buckets
/// (`at`), as the SDKs that say when count theirs, so the console and the MCP server read it by their one rule. Its
/// samples are spread evenly over the trace's own code (the spans' stretches that are no call's: what ran then is the
/// app's), each bucket a like mix of its stacks; a profile with more CPU time than that (goroutines at once, a
/// driver's own work) has the rest over the calls' time. The rest of each bucket, off the CPU, is one waiting stack
/// (OFF_CPU): in the app's code, its waits (a lock, a channel, a sleep); in a call, the call's own time. The profile
/// says it was placed (`spread`): when a stack ran within the trace's own code is the agent's estimate, not seen.
/// Whether it was.
fn spread(doc: &mut Value) -> bool {
    let language = doc
        .pointer("/attrs/telemetry.sdk.language")
        .and_then(Value::as_str)
        .unwrap_or("");
    let duration = doc.get("duration").and_then(Value::as_i64).unwrap_or(0);
    let Some(profile) = doc.get("profile") else {
        return false;
    };
    let interval = profile
        .get("interval_us")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let counts: Vec<i64> = stacks_of(profile)
        .map(|stack| {
            stack
                .get("count")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                .max(0)
        })
        .collect();
    let cpu: i64 = counts.iter().sum();
    if !CPU_ONLY.contains(&language) || timed(profile) || interval <= 0 || duration <= 0 || cpu <= 0
    {
        return false;
    }
    let buckets = usize::try_from((duration + BUCKET_US - 1) / BUCKET_US).unwrap_or(0);
    let (mut own, mut calls) = (vec![0.0; buckets], vec![0.0; buckets]);
    let spans = spans_of(doc);
    for stretch in stretches(doc, &spans) {
        let into = if OWN_CODE.contains(&stretch.category) {
            &mut own
        } else {
            &mut calls
        };
        let first = (stretch.from / BUCKET_US as f64).floor().max(0.0) as usize;
        for (bucket, time) in into.iter_mut().enumerate().skip(first) {
            let (from, to) = (
                (bucket as i64 * BUCKET_US) as f64,
                ((bucket as i64 + 1) * BUCKET_US) as f64,
            );
            if from >= stretch.to {
                break;
            }
            *time += (stretch.to.min(to) - stretch.from.max(from)).max(0.0);
        }
    }
    // Each bucket's samples on the CPU, and those its time leaves off it.
    let ticks = |times: &[f64]| {
        times
            .iter()
            .map(|us| us / interval as f64)
            .collect::<Vec<f64>>()
    };
    let room = |times: &[f64]| {
        apportion(
            &ticks(times),
            (times.iter().sum::<f64>() / interval as f64).round() as i64,
        )
    };
    let (own_room, call_room) = (room(&own), room(&calls));
    let own_total: i64 = own_room.iter().sum();
    let mut on: Vec<i64> = if cpu <= own_total {
        apportion(&own_room.iter().map(|&n| n as f64).collect::<Vec<_>>(), cpu)
    } else {
        own_room.clone()
    };
    let over = cpu - on.iter().sum::<i64>();
    if over > 0 {
        let weights: Vec<f64> = if call_room.iter().sum::<i64>() > 0 {
            call_room.iter().map(|&n| n as f64).collect()
        } else if own_total > 0 {
            own_room.iter().map(|&n| n as f64).collect()
        } else {
            vec![1.0; buckets]
        };
        for (bucket, extra) in apportion(&weights, over).into_iter().enumerate() {
            on[bucket] += extra;
        }
    }
    let off: Vec<i64> = (0..buckets)
        .map(|bucket| (own_room[bucket] + call_room[bucket] - on[bucket]).max(0))
        .collect();
    // Each stack's samples in turn, so that each bucket has a like mix of them: a stack's k-th of n at (k + ½) / n.
    let mut order: Vec<(f64, usize)> = counts
        .iter()
        .enumerate()
        .flat_map(|(stack, &count)| {
            (0..count).map(move |k| ((k as f64 + 0.5) / count as f64, stack))
        })
        .collect();
    order.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut at: Vec<BTreeMap<usize, i64>> = vec![BTreeMap::new(); counts.len()];
    let mut next = order.into_iter();
    for (bucket, &samples) in on.iter().enumerate() {
        for (_, stack) in next.by_ref().take(usize::try_from(samples).unwrap_or(0)) {
            *at[stack].entry(bucket).or_default() += 1;
        }
    }
    let pairs = |seen: &BTreeMap<usize, i64>| -> Value {
        seen.iter()
            .map(|(bucket, count)| json!([bucket, count]))
            .collect()
    };
    let waited: BTreeMap<usize, i64> = off
        .iter()
        .enumerate()
        .filter(|(_, n)| **n > 0)
        .map(|(bucket, n)| (bucket, *n))
        .collect();
    let waited_total: i64 = waited.values().sum();
    let Some(profile) = doc.get_mut("profile").and_then(Value::as_object_mut) else {
        return false;
    };
    if let Some(stacks) = profile.get_mut("stacks").and_then(Value::as_array_mut) {
        for (stack, seen) in stacks.iter_mut().zip(&at) {
            stack["at"] = pairs(seen);
        }
        if waited_total > 0 {
            let frames = profile.get_mut("frames").and_then(Value::as_array_mut);
            if let Some(frames) = frames {
                frames.push(json!({"function": OFF_CPU, "module": null, "file": "", "line": 0, "in_app": false, "waiting": true}));
                let index = frames.len() - 1;
                if let Some(stacks) = profile.get_mut("stacks").and_then(Value::as_array_mut) {
                    stacks.push(
                        json!({"frames": [index], "count": waited_total, "at": pairs(&waited)}),
                    );
                }
            }
        }
    }
    let samples = profile
        .get("samples")
        .and_then(Value::as_i64)
        .unwrap_or(cpu);
    profile.insert("samples".into(), json!(samples + waited_total));
    profile.insert("bucket_us".into(), json!(BUCKET_US));
    profile.insert("spread".into(), json!(true));
    true
}

/// A received trace's profile, its frames as `frames` has them and its memory's sites as `sites` does, placed on the
/// trace's clock where it doesn't say when it saw its stacks (`spread`), in its document (what the console shows).
pub fn normalize(received: &mut Received) {
    if !received.doc.contains("\"profile\"") {
        return;
    }
    let Ok(mut doc) = serde_json::from_str::<Value>(&received.doc) else {
        return;
    };
    let Some(profile) = doc.get_mut("profile").filter(|profile| profile.is_object()) else {
        return;
    };
    let framed = frames(profile);
    let sited = sites(profile);
    if spread(&mut doc) || sited || framed {
        received.doc = doc.to_string();
    }
}

#[cfg(test)]
mod tests {
    use super::{frames, sites, spread, tracing};
    use serde_json::{Value, json};

    /// A Go handler's CPU profile, 100 ms, 1 ms a sample: its view's code around a 40 ms query, then the framework's
    /// 20 ms after the view. 18 samples on the CPU: spread over the 60 ms of code that is no call's, 3 in each of its
    /// 10 ms, the rest of its time off the CPU; the query's time all off the CPU.
    #[test]
    fn a_go_cpu_profile_is_spread_over_the_code_and_the_rest_waits() {
        let span = |id: &str, parent: Value, kind: &str, start: i64, duration: i64| json!({"id": id, "parent_id": parent, "kind": kind, "name": id, "start": start, "duration": duration, "status": "ok", "attrs": {}});
        let mut doc = json!({
            "start": 1_000_000,
            "duration": 100_000,
            "attrs": {"telemetry.sdk.language": "go"},
            "spans": [
                span("r", Value::Null, "http", 1_000_000, 100_000),
                span("v", json!("r"), "view", 1_000_000, 80_000),
                span("q", json!("v"), "sql", 1_020_000, 40_000),
            ],
            "profile": {
                "interval_us": 1000,
                "samples": 18,
                "dropped": 0,
                "frames": [
                    {"function": "(*App).list", "module": "shop", "file": "list.go", "line": 3, "in_app": true},
                    {"function": "json.Marshal", "module": "encoding/json", "file": "encoding/json/encode.go", "line": 9, "in_app": false},
                ],
                "stacks": [{"frames": [0, 1], "count": 12}, {"frames": [0], "count": 6}],
            },
        });

        let changed = spread(&mut doc);

        assert!(changed);
        assert_eq!(
            doc["profile"],
            json!({
                "interval_us": 1000,
                "samples": 100,
                "dropped": 0,
                "bucket_us": 10_000,
                "spread": true,
                "frames": [
                    {"function": "(*App).list", "module": "shop", "file": "list.go", "line": 3, "in_app": true},
                    {"function": "json.Marshal", "module": "encoding/json", "file": "encoding/json/encode.go", "line": 9, "in_app": false},
                    {"function": "off CPU", "module": null, "file": "", "line": 0, "in_app": false, "waiting": true},
                ],
                "stacks": [
                    {"frames": [0, 1], "count": 12, "at": [[0, 2], [1, 2], [6, 2], [7, 2], [8, 2], [9, 2]]},
                    {"frames": [0], "count": 6, "at": [[0, 1], [1, 1], [6, 1], [7, 1], [8, 1], [9, 1]]},
                    {"frames": [2], "count": 82, "at": [[0, 7], [1, 7], [2, 10], [3, 10], [4, 10], [5, 10], [6, 7], [7, 7], [8, 7], [9, 7]]},
                ],
            })
        );
    }

    /// What isn't spread: a profile that says when it saw its stacks, and one whose SDK samples on the clock.
    #[test]
    fn a_timed_profile_or_a_clocks_is_left_as_it_is() {
        let doc = |language: &str, at: Value| {
            json!({
                "start": 0, "duration": 20_000, "attrs": {"telemetry.sdk.language": language},
                "spans": [{"id": "r", "parent_id": null, "kind": "http", "name": "r", "start": 0, "duration": 20_000, "status": "ok", "attrs": {}}],
                "profile": {"interval_us": 1000, "samples": 4, "bucket_us": 10_000, "frames": [{"function": "f", "module": null, "file": "f.js", "line": 1, "in_app": true}],
                    "stacks": [{"frames": [0], "count": 4, "at": at}]},
            })
        };
        let mut timed = doc("nodejs", json!([[0, 4]]));
        let mut java = doc("java", json!([]));

        let changed = (spread(&mut timed), spread(&mut java));

        assert_eq!(changed, (false, false));
        assert_eq!(timed, doc("nodejs", json!([[0, 4]])));
        assert_eq!(java, doc("java", json!([])));
    }

    /// The shared cases (`schema/waits.json`) whose profile is a CPU profile placed at ingest: what the SDK sent
    /// (`sent`), spread, is the profile the console and the MCP server read.
    #[test]
    fn the_shared_cases_cpu_profiles_are_spread_as_read() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../../schema/waits.json")).unwrap();
        let sent: Vec<&Value> = cases
            .iter()
            .filter(|case| case.get("sent").is_some())
            .collect();

        let read: Vec<(String, Value)> = sent
            .iter()
            .map(|case| {
                let mut doc = case["trace"].clone();
                doc["profile"] = case["sent"].clone();
                spread(&mut doc);
                (
                    case["name"].as_str().unwrap().to_owned(),
                    doc["profile"].clone(),
                )
            })
            .collect();

        assert!(!sent.is_empty());
        assert_eq!(
            read,
            sent.iter()
                .map(|case| (
                    case["name"].as_str().unwrap().to_owned(),
                    case["trace"]["profile"].clone()
                ))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn tracing_is_opentelemetry_and_tracepanel_in_every_language() {
        let named = [
            (
                "",
                "@opentelemetry/sdk-trace/build/src/MultiSpanProcessor.js",
            ),
            ("", "@tracepanel/js/dist/profile.js"),
            ("", "require-in-the-middle/index.js"),
            ("tracepanel.core.profile", "tracepanel/core/profile.py"),
            (
                "opentelemetry.sdk.trace",
                "opentelemetry/sdk/trace/__init__.py",
            ),
            (
                "dev.tracepanel.core.Profiler",
                "dev/tracepanel/core/Profiler.java",
            ),
            (
                "io.opentelemetry.sdk.trace.SdkSpan",
                "io/opentelemetry/sdk/trace/SdkSpan.java",
            ),
            (
                "github.com/tracepanel/tracepanel-go",
                "github.com/tracepanel/tracepanel-go/profile.go",
            ),
            (
                "go.opentelemetry.io/otel/sdk/trace",
                "go.opentelemetry.io/otel/sdk/trace/span.go",
            ),
        ];
        let others = [
            ("", "pg-pool/index.js"),
            ("", "node:internal/timers"),
            ("tracepanel_demo.views", "tracepanel_demo/views.py"),
            (
                "org.hibernate.engine.spi.EntityKey",
                "org/hibernate/engine/spi/EntityKey.java",
            ),
        ];

        assert!(named.iter().all(|(module, file)| tracing(module, file)));
        assert!(!others.iter().any(|(module, file)| tracing(module, file)));
    }

    /// A Spring request's frames as tracepanel-java 0.10.1 sends them: the controller, Hibernate 6's lazy proxy
    /// (taken for the app's), a JDK proxy, and the virtual thread parked on Postgres's socket.
    #[test]
    fn a_jvms_proxies_are_not_the_apps_and_a_parked_thread_waits() {
        let frame = |function: &str, module: &str, file: &str, in_app: bool| json!({"function": function, "module": module, "file": file, "line": 0, "in_app": in_app});
        let mut profile = json!({"frames": [
            frame("CatalogController.card", "shop.catalog.CatalogController", "src/main/java/shop/catalog/CatalogController.java", true),
            frame("Brand$HibernateProxy.getName", "shop.catalog.Brand$HibernateProxy", "src/main/java/shop/catalog/Brand.java", true),
            frame("$Proxy172.averageRating", "jdk.proxy2.$Proxy172", "jdk/proxy2/$Proxy172.java", false),
            frame("NioSocketImpl.park", "sun.nio.ch.NioSocketImpl", "sun/nio/ch/NioSocketImpl.java", false),
            frame("VirtualThread.park", "java.lang.VirtualThread", "java/lang/VirtualThread.java", false),
            frame("Unsafe.park", "jdk.internal.misc.Unsafe", "jdk/internal/misc/Unsafe.java", false),
            frame("card", "", "lib/catalog.ts", true),
        ]});

        let changed = frames(&mut profile);

        let read = |key: &str| -> Vec<bool> {
            profile["frames"]
                .as_array()
                .unwrap()
                .iter()
                .map(|frame| frame.get(key) == Some(&Value::Bool(true)))
                .collect()
        };
        assert!(changed);
        assert_eq!(
            read("in_app"),
            [true, false, false, false, false, false, true]
        );
        assert_eq!(
            read("waiting"),
            [false, false, false, false, true, true, false]
        );
    }

    /// A Django task's memory as tracepanel-python 0.10.0 sends it in a virtual environment: the profiler's own
    /// allocation (its sample counter) among the app's and Redis's.
    #[test]
    fn tracings_own_allocations_are_not_the_apps_memory() {
        let frame = |function: &str, module: &str, file: &str, in_app: bool| json!({"function": function, "module": module, "file": file, "line": 1, "in_app": in_app});
        let mut profile = json!({
            "frames": [
                frame("refresh_tracking", "shop.tasks", "shop/tasks.py", true),
                frame("CaseInsensitiveDict.__setitem__", "redis.client", "redis/client.py", false),
                frame("run", "threading", "threading.py", false),
                frame("count", "tracepanel.core.profile", "tracepanel/core/profile.py", false),
            ],
            "memory": {"peak": 55_000, "net": 36_000, "sites": [
                {"frames": [0, 1], "bytes": 12_000, "count": 40},
                {"frames": [2, 3], "bytes": 1_400, "count": 30},
                {"frames": [0], "bytes": 900, "count": 3},
            ]},
        });

        let changed = sites(&mut profile);

        assert!(changed);
        assert_eq!(
            profile["memory"]["sites"],
            json!([
                {"frames": [0, 1], "bytes": 12_000, "count": 40},
                {"frames": [0], "bytes": 900, "count": 3},
            ])
        );
    }
}
