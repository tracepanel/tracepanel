//! A profile's frames as the console and the MCP server read them: which are tracing's own code, never the app's.

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

#[cfg(test)]
mod tests {
    use super::tracing;

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
}
