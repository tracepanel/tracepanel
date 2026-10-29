//! The MCP server as a client sees it: JSON-RPC lines in, lines out, on a store of the traces in `schema/examples`.

use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tracepanel_mcp::Server;
use tracepanel_protocol::{Batch, Thresholds};
use tracepanel_store_local::Store;

const N_PLUS_ONE: &str = "01M4GPC1BHG83SW8X460V23TM0";
const FIXED: &str = "01M4GPC1ESW50X1ZHJJ3ZNP7VM";
const ERROR: &str = "01M4GPC3BF07PDY3T2QJEPN5YZ";
const VERSIONS: [&str; 5] = [
    "2024-11-05",
    "2025-03-26",
    "2025-06-18",
    "2025-11-25",
    "2026-07-28",
];
const TOOLS: [&str; 10] = [
    "find_traces",
    "get_trace",
    "get_profile",
    "wait_for_trace",
    "compare_traces",
    "list_issues",
    "get_issue",
    "list_endpoints",
    "list_calls",
    "search_logs",
];

fn example(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../schema/examples")
        .join(name);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A store with `docs` in it, as the agent writes them: analyzed with the default limits.
fn store(name: &str, docs: &[Value]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tracepanel-mcp-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    write(&dir, docs);
    dir
}

fn write(dir: &Path, docs: &[Value]) {
    let mut store = Store::open(&tracepanel_store_local::path_in(dir)).unwrap();
    let batch = Batch {
        frame: serde_json::to_vec(docs).unwrap(),
        max_traces: Some(1000),
        thresholds: Thresholds::default(),
    };
    let mut traces = batch.decode().unwrap();
    for trace in &mut traces {
        tracepanel_analysis::apply(trace, &batch.thresholds);
    }
    store.write(&traces).unwrap();
}

fn examples() -> Vec<Value> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../schema/examples");
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name != "expected.json")
        .collect();
    names.sort();
    names.iter().map(|name| example(name)).collect()
}

/// A client on the server's stdin and stdout.
struct Client {
    input: tokio::io::DuplexStream,
    output: tokio::io::Lines<BufReader<tokio::io::DuplexStream>>,
}

impl Client {
    fn start(server: Server) -> Self {
        let (input, server_input) = tokio::io::duplex(1 << 20);
        let (server_output, output) = tokio::io::duplex(1 << 20);
        tokio::spawn(server.serve(server_input, server_output));
        Self {
            input,
            output: BufReader::new(output).lines(),
        }
    }

    async fn send(&mut self, line: &str) {
        self.input
            .write_all(format!("{line}\n").as_bytes())
            .await
            .unwrap();
    }

    async fn reply(&mut self) -> Value {
        let line = self
            .output
            .next_line()
            .await
            .unwrap()
            .expect("the server hung up");
        serde_json::from_str(&line).unwrap()
    }
}

/// The server's replies to `messages`: a request waits for its reply, a notification for none.
async fn exchange(server: &Server, messages: &[Value]) -> Vec<Value> {
    let mut client = Client::start(server.clone());
    let mut replies = Vec::new();
    for message in messages {
        client.send(&message.to_string()).await;
        if message.get("id").is_some() {
            replies.push(client.reply().await);
        }
    }
    replies
}

fn modern(id: i64, method: &str, params: Value) -> Value {
    let mut params = params;
    params["_meta"] = json!({
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
    });
    json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
}

/// A tool's text, and whether it is an error.
async fn tool(server: &Server, name: &str, arguments: Value) -> (String, bool) {
    let replies = exchange(
        server,
        &[modern(
            1,
            "tools/call",
            json!({"name": name, "arguments": arguments}),
        )],
    )
    .await;
    let result = &replies[0]["result"];
    let text = result["content"][0]["text"]
        .as_str()
        .unwrap_or_else(|| panic!("{}", replies[0]));
    // Times relative to now: the same in every run once named.
    (named_ago(text), result["isError"].as_bool().unwrap())
}

/// `12s ago`, `3d ago` → `<ago>`.
fn named_ago(text: &str) -> String {
    let ago = regex::Regex::new(r"\b\d+[smhd] ago\b").unwrap();
    ago.replace_all(text, "<ago>").into_owned()
}

fn names(tools: &Value) -> Vec<&str> {
    tools
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn an_earlier_client_opens_with_initialize() {
    let server = Server::new(store("initialize", &[]), false);
    let replies = exchange(
        &server,
        &[
            json!({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "claude-code", "version": "2.1"},
            }}),
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
            json!({"jsonrpc": "2.0", "id": 2, "method": "ping"}),
        ],
    )
    .await;

    assert_eq!(replies.len(), 3, "a notification gets no answer");
    let instructions = replies[0]["result"]["instructions"].clone();
    assert!(instructions.as_str().unwrap().contains("compare_traces"));
    assert_eq!(
        replies[0],
        json!({"jsonrpc": "2.0", "id": 0, "result": {
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "tracepanel", "title": "Tracepanel", "version": env!("CARGO_PKG_VERSION")},
            "instructions": instructions,
        }})
    );

    assert_eq!(names(&replies[1]["result"]["tools"]), TOOLS);
    assert_eq!(replies[1]["result"].get("resultType"), None);

    assert_eq!(replies[2], json!({"jsonrpc": "2.0", "id": 2, "result": {}}));
}

#[tokio::test]
async fn an_unknown_earlier_version_gets_the_newest_earlier_one() {
    let server = Server::new(store("initialize-old", &[]), false);
    let replies = exchange(
        &server,
        &[
            json!({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
                "protocolVersion": "2024-01-01",
                "capabilities": {},
                "clientInfo": {"name": "old", "version": "1"},
            }}),
        ],
    )
    .await;

    assert_eq!(replies[0]["result"]["protocolVersion"], "2025-11-25");
}

#[tokio::test]
async fn a_stateless_request_names_its_version() {
    let server = Server::new(store("stateless", &[]), false);
    let replies = exchange(
        &server,
        &[
            modern(1, "server/discover", json!({})),
            modern(2, "tools/list", json!({})),
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/list", "params": {"_meta": {
                "io.modelcontextprotocol/protocolVersion": "1900-01-01",
            }}}),
            json!({"jsonrpc": "2.0", "id": 4, "method": "tools/list"}),
            modern(5, "store/clear", json!({})),
            modern(
                6,
                "tools/call",
                json!({"name": "drop_tables", "arguments": {}}),
            ),
        ],
    )
    .await;
    let server_info = json!({"io.modelcontextprotocol/serverInfo": {
        "name": "tracepanel", "title": "Tracepanel", "version": env!("CARGO_PKG_VERSION"),
    }});

    let instructions = replies[0]["result"]["instructions"].clone();
    assert_eq!(
        replies[0],
        json!({"jsonrpc": "2.0", "id": 1, "result": {
            "resultType": "complete",
            "supportedVersions": VERSIONS,
            "capabilities": {"tools": {}},
            "instructions": instructions,
            "_meta": server_info,
            "ttlMs": 0,
            "cacheScope": "private",
        }})
    );

    // Fresh for no time, this client's: a list can't be cached past the server's lifetime.
    assert_eq!(
        (
            &replies[1]["result"]["resultType"],
            &replies[1]["result"]["ttlMs"],
            &replies[1]["result"]["cacheScope"]
        ),
        (&json!("complete"), &json!(0), &json!("private"))
    );
    assert_eq!(names(&replies[1]["result"]["tools"]), TOOLS);

    assert_eq!(
        replies[2],
        json!({"jsonrpc": "2.0", "id": 3, "error": {
            "code": -32022,
            "message": "Unsupported protocol version",
            "data": {
                "supported": VERSIONS,
                "requested": "1900-01-01",
            },
        }})
    );
    assert_eq!(
        replies[3],
        json!({"jsonrpc": "2.0", "id": 4, "error": {
            "code": -32602,
            "message": "request _meta is missing or has malformed required fields: \
                        io.modelcontextprotocol/protocolVersion, io.modelcontextprotocol/clientCapabilities",
        }})
    );
    assert_eq!(
        replies[4],
        json!({"jsonrpc": "2.0", "id": 5, "error": {"code": -32601, "message": "store/clear"}})
    );
    assert_eq!(
        replies[5],
        json!({"jsonrpc": "2.0", "id": 6, "error": {"code": -32602, "message": "unknown tool: drop_tables"}})
    );
}

#[tokio::test]
async fn a_line_that_is_not_json_is_skipped() {
    let mut client = Client::start(Server::new(store("parse", &[]), false));
    client.send("{nope").await;
    client
        .send(&modern(1, "tools/list", json!({})).to_string())
        .await;
    let reply = client.reply().await;

    assert_eq!(reply["id"], 1);
    assert_eq!(names(&reply["result"]["tools"]), TOOLS);
}

#[tokio::test]
async fn every_tool_only_reads_and_says_what_it_takes() {
    let server = Server::new(store("tools", &[]), false);
    let replies = exchange(&server, &[modern(1, "tools/list", json!({}))]).await;

    for tool in replies[0]["result"]["tools"].as_array().unwrap() {
        assert_eq!(
            tool["annotations"],
            json!({"readOnlyHint": true, "openWorldHint": false}),
            "{}",
            tool["name"]
        );
        assert_eq!(tool["inputSchema"]["type"], "object");
        assert_eq!(tool["inputSchema"]["additionalProperties"], false);
        assert!(!tool["description"].as_str().unwrap().contains("  "));
    }
}

#[tokio::test]
async fn a_trace_with_n_plus_one_in_a_few_lines() {
    let server = Server::new(store("n-plus-one", &examples()), false);

    assert_eq!(
        tool(&server, "get_trace", json!({"id": N_PLUS_ONE})).await,
        (
            "01M4GPC1BHG83SW8X460V23TM0  GET / → 200 · 27.6 ms · 151 SQL (3.2 ms) · view blog.views.post_list

issues (3):
  n+1  N+1: 50 similar queries · SELECT auth_user
      at blog/post_list.html (rendered from blog/views.py:28 in post_list)
      fix: The template `blog/post_list.html` makes these queries as it renders, one per row it shows. Load the related object in the same query: add `select_related()` for this ForeignKey to the queryset that produced these rows.
      fingerprint 3e55c87ed325564b
  n+1  N+1: 50 similar queries · SELECT blog_category
      at blog/post_list.html (rendered from blog/views.py:28 in post_list)
      fix: The template `blog/post_list.html` makes these queries as it renders, one per row it shows. Load the related object in the same query: add `select_related()` for this ForeignKey to the queryset that produced these rows.
      fingerprint cc5aafe33232b857
  n+1  N+1: 50 similar queries · SELECT blog_tag
      at blog/post_list.html (rendered from blog/views.py:28 in post_list)
      fix: The template `blog/post_list.html` makes these queries as it renders, one per row it shows. Load the related rows in one extra query: add `prefetch_related()` for this reverse or many-to-many relation to the queryset that produced these rows.
      fingerprint c9bf81e59a003513

tree (issues, errors and the slow branches):
  http GET / · 27.6 ms
    view blog.views.post_list · 27.5 ms
      template blog/post_list.html · 24.4 ms
        sql SELECT auth_user ×50 · 0.7 ms  [n+1] — blog/views.py:28 in post_list
        sql SELECT blog_category ×50 · 0.6 ms  [n+1] — blog/views.py:28 in post_list
        sql SELECT blog_tag ×50 · 0.7 ms  [n+1] — blog/views.py:28 in post_list
  … 1 more span · 1.2 ms; focus=tree shows them"
                .to_owned(),
            false
        )
    );
}

#[tokio::test]
async fn the_whole_tree_on_request() {
    let server = Server::new(store("tree", &examples()), false);
    let (text, _) = tool(
        &server,
        "get_trace",
        json!({"id": N_PLUS_ONE, "focus": "tree"}),
    )
    .await;
    let tree = &text[text.find("tree:").unwrap()..];

    assert_eq!(
        tree,
        "tree:
  http GET / · 27.6 ms
    view blog.views.post_list · 27.5 ms
      sql SELECT blog_post · 1.2 ms — blog/views.py:26 in post_list
      template blog/post_list.html · 24.4 ms
        sql SELECT auth_user ×50 · 0.7 ms  [n+1] — blog/views.py:28 in post_list
        sql SELECT blog_category ×50 · 0.6 ms  [n+1] — blog/views.py:28 in post_list
        sql SELECT blog_tag ×50 · 0.7 ms  [n+1] — blog/views.py:28 in post_list"
    );
}

#[tokio::test]
async fn sql_without_its_values_unless_asked() {
    let dir = store("sql", &examples());
    let (plain, _) = tool(
        &Server::new(dir.clone(), false),
        "get_trace",
        json!({"id": N_PLUS_ONE, "focus": "sql"}),
    )
    .await;
    let (values, _) = tool(
        &Server::new(dir, true),
        "get_trace",
        json!({"id": N_PLUS_ONE, "focus": "sql"}),
    )
    .await;

    assert!(plain.contains(
        "SQL: 151 queries, 4 statements, 3.2 ms\n  ×1 · 1.2 ms · blog/views.py:26 in post_list\n"
    ));
    assert!(!plain.contains("params"));
    assert!(values.contains(
        "\n  ×50 · 0.7 ms · blog/views.py:28 in post_list\n    SELECT \"auth_user\".\"id\", \"auth_user\".\"password\", \
         \"auth_user\".\"last_login\", \"auth_user\".\"is_superuser\", \"auth_user\".\"username\", \"auth_user\".\"first_name\", \
         \"auth_user\".\"last_name\", \"auth_user\".\"email\", \"auth_user\".\"is_staff\", \"auth_user\".\"is_active\", \
         \"auth_user\".\"date_joined\" FROM \"auth_user\" WHERE \"auth_user\".\"id\" = %s LIMIT 21\n    params: [21]\n"
    ));
}

#[tokio::test]
async fn an_error_with_its_line_and_secrets_masked() {
    let mut error = example("python-django-error.json");
    error["errors"][0]["frames"][3]["locals"]["api_token"] = json!("'abc'");
    let dir = store("error", &[error]);
    let (plain, _) = tool(
        &Server::new(dir.clone(), false),
        "get_trace",
        json!({"id": ERROR}),
    )
    .await;
    let (values, _) = tool(&Server::new(dir, true), "get_trace", json!({"id": ERROR})).await;

    assert_eq!(
        plain,
        "01M4GPC3BF07PDY3T2QJEPN5YZ  GET /error/ → 500 · 29.2 ms · 1 SQL (0.1 ms) · view blog.views.error

issues (1):
  error  ZeroDivisionError: division by zero
      at blog/views.py:79 in error
      fingerprint d119e52c4da5791b

error (unhandled): builtins.ZeroDivisionError: division by zero
    blog/views.py:79 in error
      > return JsonResponse({\"ratio\": posts / 0})

tree (issues, errors and the slow branches):
  http GET /error/ · 29.2 ms  [error]
    view blog.views.error · 1.6 ms  [error]
    template <string template> · 8.9 ms
  … 1 more span · 0.1 ms; focus=tree shows them

logs from warning (1):
  error django.request: Internal Server Error: /error/ (.venv/lib/python3.11/site-packages/django/utils/log.py:253)"
    );

    assert!(values.contains(
        "      > return JsonResponse({\"ratio\": posts / 0})\n      locals: api_token=***, posts=200, \
         request=<WSGIRequest: GET '/error/'>\n"
    ));
}

#[tokio::test]
async fn before_and_after_a_fix() {
    let server = Server::new(store("compare", &examples()), false);

    assert_eq!(
        tool(&server, "compare_traces", json!({"before": N_PLUS_ONE, "after": FIXED})).await.0,
        "before  01M4GPC1BHG83SW8X460V23TM0  GET / → 200 · 27.6 ms · 151 SQL (3.2 ms) · view blog.views.post_list
after   01M4GPC1ESW50X1ZHJJ3ZNP7VM  GET /fixed/ → 200 · 6.0 ms · 2 SQL (0.4 ms) · view blog.views.post_list_fixed

time: 27.6 ms → 6.0 ms (-78%)
SQL: 151 → 2 queries (-99%), 3.2 ms → 0.4 ms
issues: 3 → 0 (3 fixed, 0 new, 0 still there)
  fixed  n+1  N+1: 50 similar queries · SELECT auth_user — blog/post_list.html (rendered from blog/views.py:28 in post_list)
  fixed  n+1  N+1: 50 similar queries · SELECT blog_category — blog/post_list.html (rendered from blog/views.py:28 in post_list)
  fixed  n+1  N+1: 50 similar queries · SELECT blog_tag — blog/post_list.html (rendered from blog/views.py:28 in post_list)
statements that changed (6):
  ×50 → ×0  SELECT \"auth_user\".\"id\", \"auth_user\".\"password\", \"auth_user\".\"last_login\", \"auth_user\".\"is_superuser\", \"auth_user\".\"username\", \"auth_user\".\"first_name\", \"auth_user\".\"last_name\", \"auth_user\".\"email\", \"…
  ×50 → ×0  SELECT \"blog_category\".\"id\", \"blog_category\".\"name\" FROM \"blog_category\" WHERE \"blog_category\".\"id\" = %s LIMIT 21
  ×50 → ×0  SELECT \"blog_tag\".\"id\", \"blog_tag\".\"name\" FROM \"blog_tag\" INNER JOIN \"blog_post_tags\" ON (\"blog_tag\".\"id\" = \"blog_post_tags\".\"tag_id\") WHERE \"blog_post_tags\".\"post_id\" = %s
  ×1 → ×0  SELECT \"blog_post\".\"id\", \"blog_post\".\"author_id\", \"blog_post\".\"category_id\", \"blog_post\".\"title\", \"blog_post\".\"body\", \"blog_post\".\"likes\", \"blog_post\".\"created\" FROM \"blog_post\" ORDER BY \"blog_post\".\"…
  ×0 → ×1  SELECT \"blog_post\".\"id\", \"blog_post\".\"author_id\", \"blog_post\".\"category_id\", \"blog_post\".\"title\", \"blog_post\".\"body\", \"blog_post\".\"likes\", \"blog_post\".\"created\", \"auth_user\".\"id\", \"auth_user\".\"passwor…
  ×0 → ×1  SELECT (\"blog_post_tags\".\"post_id\") AS \"_prefetch_related_val_post_id\", \"blog_tag\".\"id\", \"blog_tag\".\"name\" FROM \"blog_tag\" INNER JOIN \"blog_post_tags\" ON (\"blog_tag\".\"id\" = \"blog_post_tags\".\"tag_id\") …"
    );
}

#[tokio::test]
async fn lists_one_line_each() {
    let server = Server::new(store("lists", &examples()), false);

    assert_eq!(
        tool(&server, "find_traces", json!({"query": "has:n+1"}))
            .await
            .0,
        "traces (7, newest first):
01M4R1ER9RWER0QHV07BJDSZ7B  GET /api/feed → 200 · 13.3 ms · issues: n+1 · <ago>
01M5GCHAT0K3VJ6TN8C2XWB4FR  POST /summaries/ → 200 · 500 ms · issues: n+1 · <ago>
01M5GSTRG0K3VJ6TN8C2XWB4FR  GET /gallery/ → 200 · 48.0 ms · issues: duplicates, n+1 · <ago>
01M4GPCSNDHYSFJGJK7FY7NGH5  GET /books → 200 · 2.0 ms · 21 SQL (0.9 ms) · issues: n+1 · <ago>
01M4GPC5X4GTP7C29QTSE6VRAM  GET /async/ → 200 · 38.2 ms · 61 SQL (2.3 ms) · issues: n+1 · <ago>
01M4GPC1BHG83SW8X460V23TM0  GET / → 200 · 27.6 ms · 151 SQL (3.2 ms) · issues: n+1 · <ago>
01M4GPAPP2WXJQE2FXJ7PSQBG5  GET /api/posts → 200 · 4.8 ms · 14 SQL (0.3 ms) · issues: n+1 · <ago>"
    );

    assert_eq!(
        tool(
            &server,
            "list_issues",
            json!({"query": "kind:slow-sql", "limit": 1})
        )
        .await
        .0,
        "issues (1, most recent first):
slow-sql  Slow query: 376 ms · WITH n
    at app.go:130 in (*App).slowReport
    fix: Check the query plan (`EXPLAIN`) and add an index or narrow the query.
    1× · last <ago> · on GET /reports/slow · fingerprint d21ce3db4a532371"
    );

    assert_eq!(
        tool(
            &server,
            "get_issue",
            json!({"fingerprint": "d119e52c4da5791b"})
        )
        .await
        .0,
        "error  ZeroDivisionError: division by zero
    at blog/views.py:79 in error
    1× · last <ago> · on GET /error/ · fingerprint d119e52c4da5791b
first seen <ago>

latest traces:
  01M4GPC3BF07PDY3T2QJEPN5YZ  GET /error/ → 500 · 29.2 ms · 1 SQL (0.1 ms) · issues: error · <ago>"
    );

    assert_eq!(
        tool(&server, "list_endpoints", json!({"limit": 2})).await.0,
        "endpoints (2, busiest first):
GET /slow-transaction/ · 1 call · p50 611 ms · p95 611 ms · 2.0 SQL avg · 1 with issues · last <ago>
GET /api/checkout · 1 call · p50 609 ms · p95 609 ms · 1 with issues · last <ago>"
    );

    assert_eq!(
        tool(&server, "list_calls", json!({"query": "system:sql", "limit": 1})).await.0,
        "calls (1, heaviest first):
sql app.sqlite3 · ×1 in 1 trace · up to 1 per trace · total 599 ms · slowest 599 ms · app/api.py:56 in report
    WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000000) SELECT count(*) FROM c
    e.g. trace 01M4GPB3578QTR3FS1P9G47DTX · call:070b2f637f88284a"
    );

    assert_eq!(
        tool(&server, "search_logs", json!({"query": "level>=warning"})).await.0,
        "logs (3, newest first):
<ago> error django.dispatch: Error calling notify_warehouse in Signal.send_robust() (warehouse offline) · POST /checkout/ (01M4GPD7Q0K3VJ6TN8C2XWB4FR)
<ago> error django.request: Internal Server Error: /error/ · GET /error/ (01M4GPC3BF07PDY3T2QJEPN5YZ)
<ago> warning app.api: report scanned 2000000 rows · GET /api/report (01M4GPB3578QTR3FS1P9G47DTX)"
    );
}

#[tokio::test]
async fn wait_for_trace_returns_the_request_made_meanwhile() {
    let dir = store("wait", &examples());
    let server = Server::new(dir.clone(), false);
    let mut next = example("go-fixed.json");
    next["id"] = json!("01M4GPCSS3KSESQME6H6J7M999");
    let writer = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        next["start"] = json!(tracepanel_store_local::search::now_us());
        write(&dir, &[next]);
    });

    let (text, failed) = tool(
        &server,
        "wait_for_trace",
        json!({"query": "route:/books/fixed", "timeout_s": 10}),
    )
    .await;
    writer.join().unwrap();

    assert!(!failed);
    assert!(
        text.starts_with(
            "01M4GPCSS3KSESQME6H6J7M999  GET /books/fixed → 200 · 0.4 ms · 1 SQL (0.1 ms)"
        ),
        "{text}"
    );
}

#[tokio::test]
async fn wait_for_trace_says_when_nothing_came() {
    let server = Server::new(store("wait-nothing", &examples()), false);

    assert_eq!(
        tool(&server, "wait_for_trace", json!({"query": "route:/nowhere", "timeout_s": 1})).await,
        (
            "No new trace matching `route:/nowhere` in 1 s. Is the app running with Tracepanel, and did the request \
             reach it? find_traces shows what was recorded."
                .to_owned(),
            true
        )
    );
}

#[tokio::test]
async fn mistakes_come_back_for_the_model_to_correct() {
    let server = Server::new(store("mistakes", &examples()), false);

    assert_eq!(
        tool(&server, "find_traces", json!({"query": "colour:red"})).await,
        (
            "Unknown filter 'colour'. Use one of: cache, call, db, duration, group, has, kind, method, name, operation, path, \
             peer, queries, queue, route, service, since, span, state, status, system, task, trace, until, user, view"
                .to_owned(),
            true
        )
    );
    assert_eq!(
        tool(
            &server,
            "get_trace",
            json!({"id": "01M4GPC1BHG83SW8X460V23TZZ"})
        )
        .await,
        (
            "No trace 01M4GPC1BHG83SW8X460V23TZZ: find_traces lists the recent ones.".to_owned(),
            true
        )
    );
    assert_eq!(
        tool(&server, "get_trace", json!({})).await,
        ("id is required".to_owned(), true)
    );
    assert_eq!(
        tool(
            &server,
            "get_trace",
            json!({"id": N_PLUS_ONE, "focus": "everything"})
        )
        .await,
        (
            "focus is one of issues, tree, sql, logs; not everything".to_owned(),
            true
        )
    );
    assert_eq!(
        tool(&server, "get_issue", json!({"fingerprint": "0000"})).await,
        ("No issue 0000: list_issues lists them.".to_owned(), true)
    );
}

#[tokio::test]
async fn without_a_store_it_says_how_to_get_one() {
    let dir = std::env::temp_dir().join(format!("tracepanel-mcp-{}-none", std::process::id()));
    let server = Server::new(dir.clone(), false);

    assert_eq!(
        tool(&server, "find_traces", json!({})).await,
        (
            format!(
                "No traces yet: {} has no store. Run the app with Tracepanel and make a request.",
                dir.display()
            ),
            true
        )
    );
    assert!(!dir.exists(), "reading never creates the store");
}

#[tokio::test]
async fn answers_link_to_the_console_when_an_agent_serves_it() {
    let dir = store("console", &examples());
    std::fs::write(dir.join("console.addr"), "http://127.0.0.1:8765/\n").unwrap();
    let (text, _) = tool(&Server::new(dir, false), "get_trace", json!({"id": FIXED})).await;

    assert!(
        text.ends_with("\n\nconsole: http://127.0.0.1:8765/#/t/01M4GPC1ESW50X1ZHJJ3ZNP7VM"),
        "{text}"
    );
}

#[tokio::test]
async fn a_big_trace_is_cut_to_the_budget() {
    let mut doc = example("go-fixed.json");
    let root = doc["spans"][0]["id"].clone();
    let spans = doc["spans"].as_array_mut().unwrap();
    for n in 0..600 {
        spans.push(json!({
            "id": format!("01M4GPCSS3KSESQME6H{n:07}"),
            "parent_id": root,
            "kind": "sql",
            "name": format!("SELECT table_{n}"),
            "start": 1791561721635900_i64 + n,
            "duration": 100,
            "status": "ok",
            "attrs": {"db.fingerprint": format!("SELECT * FROM table_{n} WHERE id = ?")},
        }));
    }
    let server = Server::new(store("big", &[doc]), false);
    let (text, failed) = tool(
        &server,
        "get_trace",
        json!({"id": "01M4GPCSS3KSESQME6H6J7M540", "focus": "sql"}),
    )
    .await;

    assert!(!failed);
    assert!(text.len() < 16_200, "{}", text.len());
    let last = text.lines().last().unwrap();
    assert!(
        last.starts_with("… cut: ")
            && last.ends_with(" more characters (a narrower query or focus shows the rest)"),
        "{last}"
    );
}

/// A task run, `0…0<letter>`, with these attributes.
fn task_run(letter: char, start: i64, attrs: Value) -> Value {
    let mut all = json!({"service.name": "shop", "task.system": "rq", "task.state": "SUCCESS"});
    all.as_object_mut()
        .unwrap()
        .extend(attrs.as_object().unwrap().clone());
    json!({
        "id": format!("01M4W0RKF10W00000000000{letter}00"), "kind": "task", "name": format!("shop.jobs.{letter}"),
        "start": start, "duration": 2000, "status": "ok", "attrs": all,
        "spans": [{"id": "ROOT", "parent_id": null, "kind": "task.run", "name": format!("shop.jobs.{letter}"),
                   "start": start, "duration": 2000, "status": "ok", "attrs": {}}],
        "logs": [], "errors": [], "links": [], "issues": [],
    })
}

#[tokio::test]
async fn a_task_run_says_its_workflow() {
    // C waited for A and B (RQ's depends_on), and runs in a group with D.
    let docs = [
        task_run('A', 1_000_000, json!({"task.id": "a"})),
        task_run('B', 2_000_000, json!({"task.id": "b"})),
        task_run(
            'C',
            3_000_000,
            json!({"task.id": "c", "task.parent_id": "a", "task.root_id": "a", "task.depends_on": ["a", "b"],
                   "task.group_id": "g"}),
        ),
        task_run(
            'D',
            4_000_000,
            json!({"task.id": "d", "task.group_id": "g"}),
        ),
    ];
    let server = Server::new(store("workflow", &docs), false);

    let (text, error) = tool(
        &server,
        "get_trace",
        json!({"id": "01M4W0RKF10W00000000000C00"}),
    )
    .await;

    assert!(!error);
    assert_eq!(
        text.split_once("\n\nfollows:").map(|(_, rest)| rest),
        Some(
            "
  01M4W0RKF10W00000000000A00  task shop.jobs.A (success) · 2.0 ms · <ago>
  01M4W0RKF10W00000000000B00  task shop.jobs.B (success) · 2.0 ms · <ago>
group g (2 tasks):
  01M4W0RKF10W00000000000D00  task shop.jobs.D (success) · 2.0 ms · <ago>"
        )
    );
}

const SLOW: &str = "01M4PR0F11E0000000000000S0";
const QUICK: &str = "01M4PR0F11E0000000000000Q0";
const JS: &str = "01M4PR0F11E0000000000000J0";

/// A request to `/reports/sales` of `id`, `duration` long, with `profile` as the SDK sent it.
fn profiled(id: &str, duration: i64, profile: Value) -> Value {
    json!({
        "id": id, "kind": "http", "name": "GET /reports/sales", "start": 1_791_561_721_000_000_i64,
        "duration": duration, "status": "ok",
        "attrs": {"service.name": "shop", "http.method": "GET", "http.path": "/reports/sales", "http.route": "/reports/sales",
                  "http.status_code": 200},
        "spans": [{"id": format!("{id}R"), "parent_id": null, "kind": "http", "name": "GET /reports/sales",
                   "start": 1_791_561_721_000_000_i64, "duration": duration, "status": "ok", "attrs": {}}],
        "logs": [], "errors": [], "links": [], "issues": [], "profile": profile,
    })
}

/// The frames of a Django view on ASGI as the Python SDK names them: the view awaits a sleep, builds cards with
/// json.dumps, runs a query; the last is the line in build_cards that allocated.
fn python_frames() -> Value {
    let frame = |function: &str, module: &str, file: &str, line: i64, in_app: bool| json!({"function": function, "module": module, "file": file, "line": line, "in_app": in_app});
    let mut view = frame("sales", "reports.views", "reports/views.py", 18, true);
    view["at_line"] = json!(24);
    let mut sleep = frame("sleep", "asyncio.tasks", "asyncio/tasks.py", 640, false);
    sleep["waiting"] = json!(true);
    let mut allocating = frame("build_cards", "reports.cards", "reports/cards.py", 40, true);
    allocating["at_line"] = json!(44);
    json!([
        frame(
            "ASGIHandler.handle",
            "django.core.handlers.asgi",
            "django/core/handlers/asgi.py",
            160,
            false
        ),
        view,
        frame("build_cards", "reports.cards", "reports/cards.py", 40, true),
        frame("dumps", "json", "json/__init__.py", 231, false),
        frame(
            "SQLCompiler.execute_sql",
            "django.db.models.sql.compiler",
            "django/db/models/sql/compiler.py",
            1574,
            false
        ),
        sleep,
        allocating,
    ])
}

/// `count` samples of a stack, one bucket of ten each from `first` on.
fn timed_stack(frames: Value, first: i64, count: i64) -> Value {
    let at: Vec<Value> = (0..count / 10).map(|n| json!([first + n, 10])).collect();
    json!({"frames": frames, "count": count, "at": at})
}

/// 200 ms: json.dumps in build_cards for half of it, then build_cards, a query and a sleep; 10 ms not sampled at
/// the end. 48 MB at the peak, most of it json.dumps's.
fn slow_profile() -> Value {
    json!({
        "interval_us": 1000, "samples": 190, "dropped": 10, "bucket_us": 10_000,
        "frames": python_frames(),
        "stacks": [
            timed_stack(json!([0, 1, 2, 3]), 0, 100),
            timed_stack(json!([0, 1, 2]), 10, 20),
            timed_stack(json!([0, 1, 4]), 12, 30),
            timed_stack(json!([0, 1, 5]), 15, 40),
        ],
        "memory": {
            "peak": 50_331_648, "net": 1_258_291, "allocated": 94_371_840, "sites_at": "peak", "shared": false,
            "sites": [
                {"frames": [0, 1, 6, 3], "bytes": 31_457_280, "count": 1200},
                {"frames": [0, 1, 2], "bytes": 8_388_608, "count": 64},
                {"frames": [0, 1, 4], "bytes": 2_097_152, "count": 300},
            ],
        },
        "gc": {"collections": 2, "pause_us": 3000, "pauses": [[50_000, 1000, 0], [120_000, 2000, 2]]},
    })
}

/// 20 ms after the fix, untimed: build_cards and the query. 6 MB at the peak, the sites at the end.
fn quick_profile() -> Value {
    json!({
        "interval_us": 1000, "samples": 20,
        "frames": python_frames(),
        "stacks": [{"frames": [0, 1, 2], "count": 8}, {"frames": [0, 1, 4], "count": 12}],
        "memory": {
            "peak": 6_291_456, "net": 10_240, "sites_at": "end", "shared": true,
            "sites": [{"frames": [0, 1, 6], "bytes": 4_194_304, "count": 10}],
        },
    })
}

fn profiles_store(name: &str) -> PathBuf {
    let mut cpu_only = profiled(JS, 20_000, quick_profile());
    cpu_only["profile"]
        .as_object_mut()
        .unwrap()
        .remove("memory");
    store(
        name,
        &[
            example("python-django-fixed.json"),
            profiled(SLOW, 200_000, slow_profile()),
            profiled(QUICK, 20_000, quick_profile()),
            cpu_only,
        ],
    )
}

#[tokio::test]
async fn a_cpu_profile_by_function_and_path() {
    let server = Server::new(profiles_store("profile-cpu"), false);

    assert_eq!(
        tool(&server, "get_profile", json!({"id": SLOW, "top": 3})).await,
        (
            "01M4PR0F11E0000000000000S0  GET /reports/sales → 200 · 200 ms
CPU profile: 200 ms profiled of the trace's 200 ms · 190 samples, one every 1.0 ms
waiting (a sleep, a socket, a lock, the event loop: not computing): 50.0 ms (25%), most in asyncio.sleep in sales at reports/views.py:24
not sampled: 10.0 ms (other traces ran on the same thread), filled in from the samples around it
GC: 2 collections, 3.0 ms paused
note: a sample every 1.0 ms: a function that ran for less may be missed or miscounted. Its memory was counted too, which slows the code down: these times are higher than without it.

functions by self time (your code, with the library calls it made):
  100 ms  50%  dumps — json/__init__.py:231 · total 100 ms
  50.0 ms  25%  sleep (waiting) — asyncio/tasks.py:640 · total 50.0 ms
  30.0 ms  15%  SQLCompiler.execute_sql — django/db/models/sql/compiler.py:1574 · total 30.0 ms

functions by total time:
  200 ms  100%  sales (yours) — reports/views.py:24 · self 0.0 ms
  120 ms  60%  build_cards (yours) — reports/cards.py:40 · self 20.0 ms
  100 ms  50%  dumps — json/__init__.py:231 · self 100 ms

hottest paths (outermost first):
  100 ms  50%  sales (reports/views.py:24) → build_cards (reports/cards.py:40) → dumps (json/__init__.py:231)
  50.0 ms  25%  sales (reports/views.py:24) → sleep (asyncio/tasks.py:640)
  30.0 ms  15%  sales (reports/views.py:24) → SQLCompiler.execute_sql (django/db/models/sql/compiler.py:1574)
  20.0 ms  10%  sales (reports/views.py:24) → build_cards (reports/cards.py:40)"
                .to_owned(),
            false
        )
    );
}

#[tokio::test]
async fn a_memory_profile_by_site() {
    let server = Server::new(profiles_store("profile-memory"), false);

    assert_eq!(
        tool(&server, "get_profile", json!({"id": SLOW, "kind": "memory"})).await,
        (
            "01M4PR0F11E0000000000000S0  GET /reports/sales → 200 · 200 ms
memory profile: peak 48 MB above where it started · net +1.2 MB · 90 MB allocated in all
GC: 2 collections, 3.0 ms paused
note: counting memory slows the code down (Python's tracemalloc, a short request several times over; Node's heap sampler less, and a full GC after the response): compare times on traces profiled without it.

allocation sites at the peak (3 of 3, 40 MB in all, largest first; ×: allocations counted):
  30 MB  75%  ×1200  build_cards (yours) — reports/cards.py:44 · allocated in dumps — json/__init__.py:231
  8.0 MB  20%  ×64  build_cards (yours) — reports/cards.py:40
  2.0 MB  5%  ×300  sales (yours) — reports/views.py:24 · allocated in SQLCompiler.execute_sql — django/db/models/sql/compiler.py:1574"
                .to_owned(),
            false
        )
    );

    assert_eq!(
        tool(&server, "get_profile", json!({"id": QUICK, "kind": "memory"})).await.0,
        "01M4PR0F11E0000000000000Q0  GET /reports/sales → 200 · 20.0 ms
memory profile: peak 6.0 MB above where it started · net +10 KB
note: the sites are where the memory was at the trace's end, not at its peak.
note: other traces ran in the process meanwhile: these numbers include what they allocated.
note: counting memory slows the code down (Python's tracemalloc, a short request several times over; Node's heap sampler less, and a full GC after the response): compare times on traces profiled without it.

allocation sites at the end (1 of 1, 4.0 MB in all, largest first; ×: allocations counted):
  4.0 MB  100%  ×10  build_cards (yours) — reports/cards.py:44"
    );
}

#[tokio::test]
async fn a_node_memory_profile_reads_the_same() {
    // As the JavaScript SDK sends it: no modules, frames where functions are defined, V8's sampled sites at the end.
    let frame = |function: &str, file: &str, line: i64, in_app: bool| json!({"function": function, "module": null, "file": file, "line": line, "in_app": in_app});
    let profile = json!({
        "interval_us": 1000, "samples": 12,
        "frames": [
            frame("handle", "node_modules/express/lib/router/layer.js", 86, false),
            frame("sales", "src/reports.ts", 12, true),
            frame("buildCards", "src/cards.ts", 30, true),
            frame("stringify", "", 0, false),
        ],
        "stacks": [{"frames": [0, 1, 2, 3], "count": 9}, {"frames": [0, 1, 2], "count": 3}],
        "memory": {
            "peak": 25_165_824, "net": 3_145_728, "sites_at": "end", "shared": false,
            "sites": [{"frames": [0, 1, 2, 3], "bytes": 3_145_728, "count": 96}],
        },
        "gc": {"collections": 1, "pause_us": 1500, "pauses": [[4000, 1500, 0]]},
    });
    let server = Server::new(
        store("profile-node", &[profiled(JS, 14_000, profile)]),
        false,
    );

    assert_eq!(
        tool(&server, "get_profile", json!({"id": JS, "kind": "memory"})).await.0,
        "01M4PR0F11E0000000000000J0  GET /reports/sales → 200 · 14.0 ms
memory profile: peak 24 MB above where it started · net +3.0 MB
GC: 1 collection, 1.5 ms paused
note: the sites are where the memory was at the trace's end, not at its peak.
note: counting memory slows the code down (Python's tracemalloc, a short request several times over; Node's heap sampler less, and a full GC after the response): compare times on traces profiled without it.

allocation sites at the end (1 of 1, 3.0 MB in all, largest first; ×: allocations counted):
  3.0 MB  100%  ×96  buildCards (yours) — src/cards.ts:30 · allocated in stringify"
    );
    assert_eq!(
        tool(&server, "get_profile", json!({"id": JS})).await.0,
        "01M4PR0F11E0000000000000J0  GET /reports/sales → 200 · 14.0 ms
CPU profile: 12.0 ms sampled of the trace's 14.0 ms · 12 samples, one every 1.0 ms
GC: 1 collection, 1.5 ms paused
note: a sample every 1.0 ms: a function that ran for less may be missed or miscounted. Its memory was counted too, which slows the code down: these times are higher than without it.

functions by self time (your code, with the library calls it made):
  9.0 ms  75%  stringify · total 9.0 ms
  3.0 ms  25%  buildCards (yours) — src/cards.ts:30 · total 12.0 ms

functions by total time:
  12.0 ms  100%  sales (yours) — src/reports.ts:12 · self 0.0 ms
  12.0 ms  100%  buildCards (yours) — src/cards.ts:30 · self 3.0 ms
  9.0 ms  75%  stringify · self 9.0 ms

hottest paths (outermost first):
  9.0 ms  75%  sales (src/reports.ts:12) → buildCards (src/cards.ts:30) → stringify
  3.0 ms  25%  sales (src/reports.ts:12) → buildCards (src/cards.ts:30)"
    );
}

#[tokio::test]
async fn a_trace_says_it_was_profiled() {
    let server = Server::new(profiles_store("profile-trace"), false);
    let (slow, _) = tool(&server, "get_trace", json!({"id": SLOW})).await;
    let (cpu_only, _) = tool(&server, "get_trace", json!({"id": JS})).await;
    let (none, _) = tool(&server, "get_trace", json!({"id": FIXED})).await;

    assert!(
        slow.starts_with(
            "01M4PR0F11E0000000000000S0  GET /reports/sales → 200 · 200 ms\nprofiled: cpu, memory → get_profile\n\nissues: none"
        ),
        "{slow}"
    );

    assert!(
        cpu_only.starts_with("01M4PR0F11E0000000000000J0  GET /reports/sales → 200 · 20.0 ms\nprofiled: cpu → get_profile\n\n"),
        "{cpu_only}"
    );

    assert!(!none.contains("profiled"), "{none}");
}

#[tokio::test]
async fn without_a_profile_it_says_how_to_get_one() {
    let server = Server::new(profiles_store("profile-none"), false);

    assert_eq!(
        tool(&server, "get_profile", json!({"id": FIXED})).await,
        (
            "Trace 01M4GPC1ESW50X1ZHJJ3ZNP7VM has no profile. Make the request again with an `X-Tracepanel-Profile: 1` \
             header (`memory` to count its memory too) or a `tracepanel_profile=1` cookie, or turn on the `profile` \
             setting to profile every trace; then wait_for_trace and get_profile."
                .to_owned(),
            true
        )
    );

    assert_eq!(
        tool(&server, "get_profile", json!({"id": JS, "kind": "memory"})).await,
        (
            "Trace 01M4PR0F11E0000000000000J0 has a CPU profile but its memory wasn't counted. Make the request \
             again with an `X-Tracepanel-Profile: memory` header or a `tracepanel_profile=memory` cookie (the \
             `profile_memory` setting counts every profiled trace's); then wait_for_trace and get_profile."
                .to_owned(),
            true
        )
    );

    assert_eq!(
        tool(&server, "get_profile", json!({"id": SLOW, "kind": "heap"})).await,
        ("kind is cpu or memory; not heap".to_owned(), true)
    );
}

#[tokio::test]
async fn before_and_after_a_fix_with_profiles() {
    let server = Server::new(profiles_store("profile-compare"), false);

    assert_eq!(
        tool(&server, "compare_traces", json!({"before": SLOW, "after": QUICK})).await.0,
        "before  01M4PR0F11E0000000000000S0  GET /reports/sales → 200 · 200 ms
after   01M4PR0F11E0000000000000Q0  GET /reports/sales → 200 · 20.0 ms

time: 200 ms → 20.0 ms (-90%)
SQL: 0 → 0 queries, 0.0 ms → 0.0 ms
issues: 0 → 0 (0 fixed, 0 new, 0 still there)
profile: 200 ms → 20.0 ms profiled, of which waiting 50.0 ms → 0.0 ms
functions whose self time changed most:
  dumps (json/__init__.py:231): 100 ms → 0.0 ms
  sleep (asyncio/tasks.py:640): 50.0 ms → 0.0 ms
  SQLCompiler.execute_sql (django/db/models/sql/compiler.py:1574): 30.0 ms → 12.0 ms
  build_cards (reports/cards.py:40): 20.0 ms → 8.0 ms
memory: peak 48 MB → 6.0 MB, net +1.2 MB → +10 KB
allocation sites that changed most:
  build_cards (yours) — reports/cards.py:44 · allocated in dumps — json/__init__.py:231: 30 MB → 0 B
  build_cards (yours) — reports/cards.py:40: 8.0 MB → 0 B
  build_cards (yours) — reports/cards.py:44: 0 B → 4.0 MB
  sales (yours) — reports/views.py:24 · allocated in SQLCompiler.execute_sql — django/db/models/sql/compiler.py:1574: 2.0 MB → 0 B"
    );

    let (one, _) = tool(
        &server,
        "compare_traces",
        json!({"before": FIXED, "after": QUICK}),
    )
    .await;
    assert!(
        one.ends_with(
            "\nprofile: only the after trace was profiled; profile the before one too to compare (an \
             `X-Tracepanel-Profile: 1` header)."
        ),
        "{one}"
    );
}

#[tokio::test]
async fn a_profile_too_short_for_a_sample() {
    let profile = json!({"interval_us": 1000, "samples": 0, "dropped": 0, "bucket_us": 10_000, "frames": [], "stacks": []});
    let server = Server::new(
        store("profile-empty", &[profiled(QUICK, 2_900, profile)]),
        false,
    );

    assert_eq!(
        tool(&server, "get_profile", json!({"id": QUICK})).await,
        (
            "01M4PR0F11E0000000000000Q0  GET /reports/sales → 200 · 2.9 ms
CPU profile: 0.0 ms sampled of the trace's 2.9 ms · 0 samples, one every 1.0 ms
note: a sample every 1.0 ms: a function that ran for less may be missed or miscounted.

No samples: the trace was over before the profiler saw its code (one sample every 1.0 ms)."
                .to_owned(),
            false
        )
    );
}

/// A ULID of the chain test's own: `n` padded.
fn chain_id(n: u32) -> String {
    format!("01M4C4A1N5{n:0>16}")
}

/// A BFF's request whose step calls a service twice; the service logs in its query, one of them an error.
fn chain_docs(start: i64) -> Vec<Value> {
    let span = |n: u32, parent: Option<u32>, kind: &str, name: &str, at: i64, w3c: Option<&str>| {
        let mut attrs = json!({});
        if let Some(w3c) = w3c {
            attrs["w3c.span_id"] = json!(w3c);
        }
        if kind == "http.client" {
            attrs["url.full"] = json!(format!("http://library-api{}", &name[4..]));
        }
        json!({"id": chain_id(n), "parent_id": parent.map(chain_id), "kind": kind, "name": name, "start": start + at,
               "duration": 100, "status": "ok", "attrs": attrs})
    };
    let log = |n: u32, at: i64, level: &str, logger: &str, message: &str| {
        json!({"span_id": chain_id(n), "time": start + at, "level": level, "logger": logger, "message": message,
               "exception": null, "attrs": {}})
    };
    let doc = |n: u32,
               app: &str,
               name: &str,
               at: i64,
               parent: Option<&str>,
               spans: Vec<Value>,
               logs: Vec<Value>| {
        let mut attrs =
            json!({"service.name": app, "w3c.trace_id": "4bf92f3577b34da6a3ce929d0e0e47c2"});
        if let Some(parent) = parent {
            attrs["w3c.parent_span_id"] = json!(parent);
        }
        json!({"id": chain_id(n), "kind": "http", "name": name, "start": start + at, "duration": 1000, "status": "ok",
               "attrs": attrs, "spans": spans, "logs": logs, "errors": [], "links": [], "issues": []})
    };
    let mut bff_root = span(101, None, "http", "POST /graphql", 0, None);
    bff_root["duration"] = json!(1000);
    let mut step = span(102, Some(101), "function", "Book.author", 100, None);
    step["duration"] = json!(600);
    vec![
        doc(
            1,
            "library-bff",
            "POST /graphql",
            0,
            None,
            vec![
                bff_root,
                step,
                span(
                    103,
                    Some(102),
                    "http.client",
                    "GET /authors/1",
                    200,
                    Some("c000000000000001"),
                ),
                span(
                    104,
                    Some(102),
                    "http.client",
                    "GET /authors/2",
                    500,
                    Some("c000000000000002"),
                ),
            ],
            vec![
                log(101, 10, "info", "yoga", "query Books"),
                log(102, 150, "warning", "resolvers", "slow author"),
            ],
        ),
        doc(
            2,
            "library-api",
            "GET /authors/1",
            200,
            Some("c000000000000001"),
            vec![
                span(201, None, "http", "GET /authors/1", 200, None),
                span(202, Some(201), "sql", "SELECT author", 210, None),
            ],
            vec![log(201, 220, "error", "app.db", "no author 1")],
        ),
        doc(
            3,
            "library-api",
            "GET /authors/2",
            500,
            Some("c000000000000002"),
            vec![
                span(301, None, "http", "GET /authors/2", 500, None),
                span(302, Some(301), "sql", "SELECT author", 510, None),
            ],
            vec![log(301, 520, "info", "app.db", "author 2")],
        ),
    ]
}

#[tokio::test]
async fn a_traces_logs_come_with_its_chains_and_get_trace_says_the_chain() {
    let start = tracepanel_store_local::search::now_us() - 5_000_000;
    let dir = store("chain", &chain_docs(start));
    let server = Server::new(dir, false);
    let bff = chain_id(1);

    let (whole, _) = tool(&server, "search_logs", json!({"trace": bff})).await;
    let (under, _) = tool(
        &server,
        "search_logs",
        json!({"trace": bff, "span": chain_id(102), "only": true}),
    )
    .await;
    let (alone, _) = tool(
        &server,
        "search_logs",
        json!({"trace": bff, "chain": false}),
    )
    .await;
    let (missing, failed) = tool(&server, "search_logs", json!({"trace": chain_id(9)})).await;
    let (trace, _) = tool(&server, "get_trace", json!({"id": bff})).await;

    assert_eq!(
        whole,
        format!(
            "logs of {bff} and its chain (4 records in 3 traces):
error 1 · warning 1 · info 2 · by app: library-api 2 · library-bff 2
first error: +0.2 ms error library-api app.db: no author 1
+0.0 ms info library-bff yoga: query Books
+0.1 ms warning library-bff resolvers: slow author
+0.2 ms error library-api app.db: no author 1
+0.5 ms info library-api app.db: author 2"
        )
    );

    assert_eq!(
        under,
        format!(
            "logs of {bff} and its chain under {} (1 record in 3 traces):
warning 1 · by app: library-bff 1
+0.1 ms warning library-bff resolvers: slow author",
            chain_id(102)
        )
    );

    assert_eq!(
        alone,
        format!(
            "logs of {bff} (2 records in 1 trace):
warning 1 · info 1 · by app: library-bff 2
+0.0 ms info library-bff yoga: query Books
+0.1 ms warning library-bff resolvers: slow author"
        )
    );

    assert!(failed);
    assert_eq!(
        missing,
        format!(
            "No trace {}: find_traces lists the recent ones.",
            chain_id(9)
        )
    );

    assert!(
        trace.contains(&format!(
            "chain: 2 traces down its calls (library-api); logs → search_logs trace:{bff}
their warnings and worse (1):
  +0.2 ms error library-api app.db: no author 1"
        )),
        "{trace}"
    );
}

#[tokio::test]
async fn a_traces_calls_come_with_its_chains() {
    let start = tracepanel_store_local::search::now_us() - 5_000_000;
    let dir = store("chain-calls", &chain_docs(start));
    let server = Server::new(dir, false);
    let bff = chain_id(1);

    let (sql, _) = tool(&server, "list_calls", json!({"trace": bff})).await;
    let (http, _) = tool(
        &server,
        "list_calls",
        json!({"trace": bff, "system": "http", "chain": false}),
    )
    .await;

    assert_eq!(
        sql,
        format!(
            "sql calls of {bff} and its chain: 2 calls · 0.2 ms · 0.2 ms on the clock · slowest 0.1 ms (library-api) · by app: library-api 2
×2 in 2 traces · 0.2 ms · library-api default: SELECT author"
        )
    );

    assert_eq!(
        http,
        format!(
            "http calls of {bff}: 2 calls · 0.2 ms · 0.2 ms on the clock · slowest 0.1 ms (library-bff) · by app: library-bff 2
×2 in 1 trace · 0.2 ms · library-bff library-api: GET /authors/{{id}}"
        )
    );
}

#[tokio::test]
async fn get_profile_reads_the_chains_profiles_each_apps_apart() {
    let start = tracepanel_store_local::search::now_us() - 5_000_000;
    let mut docs = chain_docs(start);
    // The service's two traces profiled, the first with its memory; the BFF not.
    docs[1]["profile"] = quick_profile();
    let mut cpu_only = quick_profile();
    cpu_only.as_object_mut().unwrap().remove("memory");
    docs[2]["profile"] = cpu_only;
    let dir = store("chain-profiles", &docs);
    let server = Server::new(dir, false);
    let bff = chain_id(1);

    let (cpu, _) = tool(&server, "get_profile", json!({"id": bff, "top": 2})).await;
    let (memory, _) = tool(
        &server,
        "get_profile",
        json!({"id": bff, "kind": "memory", "top": 2}),
    )
    .await;
    let (alone, failed) = tool(&server, "get_profile", json!({"id": bff, "chain": false})).await;
    let (trace, _) = tool(&server, "get_trace", json!({"id": bff})).await;
    let (compared, _) = tool(
        &server,
        "compare_traces",
        json!({"before": bff, "after": bff}),
    )
    .await;

    let (api1, api2) = (chain_id(2), chain_id(3));

    assert_eq!(
        cpu,
        format!(
            "{bff}  http POST /graphql · 1.0 ms
this trace: no cpu profile; those of its chain follow.

chain: cpu profiles of 2 traces down its calls, each app's apart (never one profile across apps):

library-api · 2 traces added up · {api1}, {api2}
CPU profile: 40.0 ms sampled of the traces' 2.0 ms · 40 samples, one every 1.0 ms
note: a sample every 1.0 ms: a function that ran for less may be missed or miscounted. Its memory was counted too, which slows the code down: these times are higher than without it.

functions by self time (your code, with the library calls it made):
  24.0 ms  60%  SQLCompiler.execute_sql — django/db/models/sql/compiler.py:1574 · total 24.0 ms
  16.0 ms  40%  build_cards (yours) — reports/cards.py:40 · total 16.0 ms

functions by total time:
  40.0 ms  100%  sales (yours) — reports/views.py:24 · self 0.0 ms
  24.0 ms  60%  SQLCompiler.execute_sql — django/db/models/sql/compiler.py:1574 · self 24.0 ms

hottest paths (outermost first):
  24.0 ms  60%  sales (reports/views.py:24) → SQLCompiler.execute_sql (django/db/models/sql/compiler.py:1574)
  16.0 ms  40%  sales (reports/views.py:24) → build_cards (reports/cards.py:40)"
        )
    );

    assert_eq!(
        memory,
        format!(
            "{bff}  http POST /graphql · 1.0 ms
this trace: no memory profile; those of its chain follow.

chain: memory profiles of 1 trace down its calls, each app's apart (never one profile across apps):

library-api · http GET /authors/1 · 1.0 ms · 1 SQL (0.1 ms) · {api1}
memory profile: peak 6.0 MB above where it started · net +10 KB
note: the sites are where the memory was at the trace's end, not at its peak.
note: other traces ran in the process meanwhile: these numbers include what they allocated.
note: counting memory slows the code down (Python's tracemalloc, a short request several times over; Node's heap sampler less, and a full GC after the response): compare times on traces profiled without it.

allocation sites at the end (1 of 1, 4.0 MB in all, largest first; ×: allocations counted):
  4.0 MB  100%  ×10  build_cards (yours) — reports/cards.py:44"
        )
    );

    assert!(failed);
    assert!(
        alone.starts_with(&format!("Trace {bff} has no profile.")),
        "{alone}"
    );

    assert!(
        trace.contains(&format!(
            "chain: 2 traces down its calls (library-api); logs → search_logs trace:{bff}
profiled down its calls: 2 traces (library-api) → get_profile id:{bff}"
        )),
        "{trace}"
    );

    assert!(
        compared.ends_with(&format!(
            "\nnote: the profiles compared are the traces' own; those down their chain of calls → get_profile id:{bff}"
        )),
        "{compared}"
    );
}
