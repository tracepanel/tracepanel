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
const TOOLS: [&str; 9] = [
    "find_traces",
    "get_trace",
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
        "traces (6, newest first):
01M4R1ER9RWER0QHV07BJDSZ7B  GET /api/feed → 200 · 13.3 ms · issues: n+1 · <ago>
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
