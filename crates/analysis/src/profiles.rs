//! A profile's frames as the console and the MCP server read them: which are tracing's own code, never the app's;
//! which of a JVM's are classes made at runtime, never the app's either, and which wait rather than compute.

use serde_json::Value;
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

/// A received trace's profile, its frames as `frames` has them and its memory's sites as `sites` does, in its
/// document (what the console shows).
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
    if sites(profile) || framed {
        received.doc = doc.to_string();
    }
}

#[cfg(test)]
mod tests {
    use super::{frames, sites, tracing};
    use serde_json::{Value, json};

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
