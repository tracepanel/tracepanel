//! OpenTelemetry spans as live instrumentations record them (`fixtures/`: Python's psycopg, psycopg2, asyncpg, redis,
//! requests, httpx, grpc and pymongo instrumentations, and JavaScript's pg, http and undici), mapped to tracepanel's
//! kinds; and the forms the fixtures don't cover (the newer names, the other parameter forms, the other systems).

use serde_json::{Value, json};
use tracepanel_analysis::otel::{Mapped, map};
use tracepanel_protocol::Attrs;

/// The fixtures' spans as an SDK sends them: the span kind and scope among the attributes.
fn fixture(file: &str) -> Vec<(String, String, Attrs)> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(file);
    let spans: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    spans
        .into_iter()
        .map(|span| {
            let mut attrs = span["attrs"].as_object().unwrap().clone();
            attrs.insert("otel.span_kind".into(), span["otel.span_kind"].clone());
            attrs.insert("otel.scope".into(), span["otel.scope"].clone());
            (
                span["case"].as_str().unwrap().to_owned(),
                span["name"].as_str().unwrap().to_owned(),
                attrs,
            )
        })
        .collect()
}

fn mapped(file: &str) -> Vec<Mapped> {
    fixture(file)
        .into_iter()
        .map(|(_, name, attrs)| map(&name, &attrs))
        .collect()
}

fn attrs(value: Value) -> Attrs {
    value.as_object().unwrap().clone()
}

/// (kind, name) of each mapped span.
fn shapes(spans: &[Mapped]) -> Vec<(&str, &str)> {
    spans
        .iter()
        .map(|span| (span.kind.as_str(), span.name.as_str()))
        .collect()
}

#[test]
fn python_instrumentations() {
    let spans = mapped("otel-python.json");

    assert_eq!(
        shapes(&spans),
        [
            ("sql", "SELECT"),
            ("sql", "SELECT pg_type"),
            ("sql", "SELECT"),
            ("sql", "SELECT"),
            ("redis", "SET"),
            ("redis", "GET"),
            ("redis", "PIPELINE"),
            ("http.client", "GET 127.0.0.1/users/1"),
            ("http.client", "GET 127.0.0.1/missing"),
            ("http.client", "GET 127.0.0.1/users/2"),
            ("grpc", "grpc.health.v1.Health/Check"),
            ("grpc", "grpc.health.v1.Health/Check"),
            ("mongodb", "insert users"),
            ("mongodb", "find users"),
            ("mongodb", "find users"),
        ]
    );
    // psycopg: the old names, and the parameters as Python's repr of a tuple.
    let first = &spans[0].attrs;
    assert_eq!(first["db.client"], "psycopg");
    assert_eq!(first["db.vendor"], "postgresql");
    assert_eq!(first["db.alias"], "fx");
    assert_eq!(first["db.statement"], "SELECT %s::int AS n, %s AS s");
    assert_eq!(first["db.fingerprint"], "SELECT %s::int AS n, %s AS s");
    assert_eq!(first["db.params"], json!([1, "a"]));
    assert_eq!(first["db.params_hash"].as_str().unwrap().len(), 12);
    assert_eq!(first["server.address"], "localhost");
    assert_eq!(first["server.port"], 55433);
    // A dict's repr: the values, and their names.
    assert_eq!(spans[1].attrs["db.params"], json!(["int4"]));
    assert_eq!(spans[1].attrs["db.param_names"], json!(["n"]));
    assert_eq!(spans[2].attrs["db.params"], json!([7]));
    assert_eq!(spans[3].attrs["db.client"], "asyncpg");
    // Redis masks the keys: none to name. The pipeline's key is how many commands it sent.
    assert_eq!(spans[4].attrs["redis.key"], Value::Null);
    assert_eq!(spans[4].attrs["redis.alias"], "redis/1");
    assert_eq!(spans[6].attrs["redis.key"], 2);
    assert_eq!(spans[6].attrs["db.operation"], "PIPELINE");
    // The URL without credentials, a sensitive value masked; a 404 is an error.
    assert_eq!(
        spans[7].attrs["url.full"],
        "http://127.0.0.1:61738/users/1?token=********&page=2"
    );
    assert_eq!(spans[7].attrs["http.response.status_code"], 200);
    assert!(!spans[7].error);
    assert!(spans[8].error);
    // gRPC: NOT_FOUND (5) is an error.
    assert!(!spans[10].error);
    assert!(spans[11].error);
    assert_eq!(spans[11].attrs["rpc.grpc.status_code"], 5);
    // pymongo: the command's name in db.statement, the collection in db.mongodb.collection.
    assert_eq!(spans[13].attrs["db.operation"], "find");
    assert_eq!(spans[13].attrs["db.collection.name"], "users");
    assert_eq!(spans[13].attrs["db.namespace"], "shop");
}

#[test]
fn javascript_instrumentations() {
    let spans = mapped("otel-js.json");

    assert_eq!(
        shapes(&spans),
        [
            // A connection, not a query.
            ("function", "pg.connect"),
            ("sql", "SELECT"),
            ("sql", "SELECT pg_type"),
            // The test server's own spans: not calls the app made.
            ("function", "GET"),
            ("http.client", "GET 127.0.0.1/users/1"),
            ("function", "GET"),
            ("http.client", "GET 127.0.0.1/missing"),
        ]
    );
    // The newer names, and the parameters as pg's values.
    let query = &spans[1].attrs;
    assert_eq!(query["db.client"], "pg");
    assert_eq!(query["db.alias"], "fx");
    assert_eq!(query["db.statement"], "SELECT $1::int AS n, $2 AS s");
    assert_eq!(query["db.params"], json!(["1", "a"]));
    assert_eq!(query["server.port"], 55433);
    // Without values: still a query, without parameters (N+1 by its shape, no duplicates).
    assert!(!spans[2].attrs.contains_key("db.params_hash"));
    assert_eq!(
        spans[4].attrs["url.full"],
        "http://127.0.0.1:61791/users/1?token=********"
    );
    // Only what describes the call is kept.
    assert!(!spans[4].attrs.contains_key("network.peer.address"));
    assert!(spans[6].error);
}

#[test]
fn parameter_forms() {
    let query = |extra: Value| {
        let mut base = attrs(json!({
            "otel.span_kind": "client", "db.system.name": "postgresql",
            "db.query.text": "SELECT * FROM users WHERE id = $1",
        }));
        base.extend(attrs(extra));
        map("SELECT", &base).attrs
    };

    // Java's db.query.parameter.<key>, numerically ordered.
    let java = query(json!({"db.query.parameter.10": "b", "db.query.parameter.2": "a"}));
    assert_eq!(java["db.params"], json!(["a", "b"]));
    assert!(!java.contains_key("db.param_names"));
    // Named.
    let named = query(json!({"db.query.parameter.name": "ann", "db.query.parameter.age": 3}));
    assert_eq!(named["db.params"], json!([3, "ann"]));
    assert_eq!(named["db.param_names"], json!(["age", "name"]));
    // Go's otelsql.
    assert_eq!(
        query(json!({"db.sql.args.1": 42}))["db.params"],
        json!([42])
    );
    // pg's values as a JSON string.
    assert_eq!(
        query(json!({"db.postgresql.values": "[1, \"x\"]"}))["db.params"],
        json!([1, "x"])
    );
    // Python's repr: quotes, None, booleans, floats; something else is no parameters.
    assert_eq!(
        query(json!({"db.statement.parameters": "(\"a, b\", None, True, 1.5, 'x')"}))["db.params"],
        json!(["a, b", null, true, 1.5, "x"])
    );
    assert!(
        !query(json!({"db.statement.parameters": "(datetime.date(2026, 1, 1),)"}))
            .contains_key("db.params")
    );
    // The same values, the same hash.
    assert_eq!(
        query(json!({"db.sql.args.1": 42}))["db.params_hash"],
        query(json!({"db.query.parameter.0": 42}))["db.params_hash"]
    );
}

#[test]
fn sql_names_and_in_lists() {
    let mapped = map(
        "query",
        &attrs(json!({
            "otel.span_kind": "client", "otel.scope": "github.com/XSAM/otelsql",
            "db.system": "mysql", "db.name": "shop",
            "db.statement": "SELECT  count(*)\n FROM orders WHERE id IN (?, ?, ?)",
        })),
    );

    assert_eq!(mapped.kind, "sql");
    assert_eq!(mapped.name, "SELECT COUNT orders");
    assert_eq!(mapped.attrs["db.client"], "otelsql");
    assert_eq!(
        mapped.attrs["db.fingerprint"],
        "SELECT count(*) FROM orders WHERE id IN (...)"
    );
    // MariaDB is MySQL to EXPLAIN and the console; SQLite's alias is its file's name.
    let sqlite = map(
        "q",
        &attrs(
            json!({"db.system": "sqlite", "db.name": "/srv/app/db.sqlite3", "db.statement": "SELECT 1"}),
        ),
    );
    assert_eq!(sqlite.attrs["db.alias"], "db.sqlite3");
    let mariadb = map(
        "q",
        &attrs(json!({"db.system.name": "mariadb", "db.query.text": "SELECT 1"})),
    );
    assert_eq!(mariadb.attrs["db.vendor"], "mysql");
    assert_eq!(mariadb.attrs["db.alias"], "mariadb");
}

#[test]
fn schema_qualified_tables_are_named_by_the_table() {
    // The same cases as the SDKs' own tests: one rule everywhere.
    let names: Vec<String> = [
        r#"SELECT "public"."category"."id", "public"."category"."name" FROM "public"."category" WHERE 1=1"#,
        r#"SELECT COUNT(*) AS "_count$_all" FROM (SELECT "public"."order"."id" FROM "public"."order" OFFSET $1) AS "sub""#,
        r#"SELECT "t1"."id" FROM "public"."order_item" AS "t1" LEFT JOIN "public"."product" AS "t2" ON "t2"."id" = 1"#,
        r#"INSERT INTO "public"."order" ("number") VALUES ($1) RETURNING "public"."order"."id""#,
        r#"UPDATE "public"."product" SET "stock" = $1 WHERE "public"."product"."id" = $2"#,
        r#"DELETE FROM "public"."cart_item" WHERE "public"."cart_item"."customer_id" = $1"#,
        "SELECT `book`.`id` FROM `shop`.`book` JOIN `shop`.`author` ON `author`.`id` = `book`.`author_id`",
        "UPDATE `shop` . `book` SET `price` = ?",
        "SELECT [id] FROM [dbo].[orders]",
        "SELECT * FROM shop.books",
        r#"SELECT id FROM "Order Items""#,
    ]
    .into_iter()
    .map(tracepanel_analysis::otel::span_name)
    .collect();

    assert_eq!(
        names,
        [
            "SELECT category",
            "SELECT COUNT order",
            "SELECT order_item",
            "INSERT order",
            "UPDATE product",
            "DELETE cart_item",
            "SELECT book",
            "UPDATE book",
            "SELECT orders",
            "SELECT books",
            "SELECT Order Items",
        ]
    );
}

#[test]
fn sql_server_names_and_placeholders() {
    // go-mssqldb's @p1, tedious's @name, JDBC's ?: each IN list collapses, and the table is named without its schema.
    for (statement, fingerprint) in [
        (
            "SELECT TOP 10 [o].[id] FROM [dbo].[orders] AS [o] WHERE [o].[customer_id] IN (@p1, @p2, @p3)",
            "SELECT TOP 10 [o].[id] FROM [dbo].[orders] AS [o] WHERE [o].[customer_id] IN (...)",
        ),
        (
            "SELECT [id] FROM [dbo].[orders] WHERE [customer_id] IN (@id0, @id1)",
            "SELECT [id] FROM [dbo].[orders] WHERE [customer_id] IN (...)",
        ),
        (
            "SELECT id FROM dbo.orders WHERE customer_id IN (?, ?)",
            "SELECT id FROM dbo.orders WHERE customer_id IN (...)",
        ),
    ] {
        let mapped = map(
            "query",
            &attrs(json!({"db.system": "mssql", "db.statement": statement})),
        );

        assert_eq!(
            (mapped.name.as_str(), &mapped.attrs["db.fingerprint"]),
            ("SELECT orders", &json!(fingerprint))
        );
    }

    let oracle = map(
        "query",
        &attrs(json!({
            "db.system": "oracle",
            "db.statement": r#"SELECT "ID" FROM "SHOP"."ORDERS" WHERE "ID" IN (:1, :2)"#,
        })),
    );

    assert_eq!(oracle.name, "SELECT ORDERS");
    assert_eq!(
        oracle.attrs["db.fingerprint"],
        r#"SELECT "ID" FROM "SHOP"."ORDERS" WHERE "ID" IN (...)"#
    );
}

#[test]
fn the_other_systems() {
    let one = |name: &str, value: Value| {
        let mapped = map(name, &attrs(value));
        (mapped.kind, mapped.name)
    };

    assert_eq!(
        one(
            "GET",
            json!({"otel.span_kind": "client", "db.system.name": "redis", "db.operation.name": "get",
                   "db.query.text": "get user:42", "db.namespace": "0"})
        ),
        ("redis".into(), "GET user:42".into())
    );
    assert_eq!(
        one(
            "search",
            json!({"db.system": "elasticsearch", "db.operation": "search", "db.elasticsearch.path_parts.index": "posts"})
        ),
        ("elasticsearch".into(), "search posts".into())
    );
    assert_eq!(
        one(
            "q",
            json!({"db.system.name": "opensearch", "db.operation.name": "index"})
        ),
        ("elasticsearch".into(), "index".into())
    );
    assert_eq!(
        one(
            "SELECT",
            json!({"db.system": "cassandra", "db.operation": "SELECT", "db.cassandra.table": "events",
                   "db.cassandra.keyspace": "app"})
        ),
        ("cassandra".into(), "SELECT events".into())
    );
    assert_eq!(
        one(
            "DynamoDB.GetItem",
            json!({"otel.span_kind": "client", "rpc.system": "aws-api", "rpc.service": "DynamoDB",
                   "rpc.method": "GetItem", "aws.dynamodb.table_names": ["orders"]})
        ),
        ("dynamodb".into(), "GetItem orders".into())
    );
    assert_eq!(
        one(
            "get",
            json!({"db.system": "memcached", "db.operation": "get"})
        ),
        ("memcached".into(), "get".into())
    );
    assert_eq!(
        one(
            "orders publish",
            json!({"otel.span_kind": "producer", "messaging.system": "kafka",
                   "messaging.destination.name": "orders", "messaging.operation.type": "send"})
        ),
        ("kafka".into(), "send orders".into())
    );
    assert_eq!(
        one(
            "jobs publish",
            json!({"otel.span_kind": "producer", "messaging.system": "rabbitmq", "messaging.destination": "jobs"})
        ),
        ("rabbitmq".into(), "publish jobs".into())
    );
    assert_eq!(
        one(
            "send",
            json!({"otel.span_kind": "client", "messaging.system": "aws_sqs", "messaging.operation": "publish",
                   "messaging.destination.name": "queue-1"})
        ),
        ("sqs".into(), "publish queue-1".into())
    );
    // A consumer processing a message: its own work.
    assert_eq!(
        one(
            "orders process",
            json!({"otel.span_kind": "consumer", "messaging.system": "kafka", "messaging.operation": "process"})
        ),
        ("function".into(), "orders process".into())
    );
    // Systems without a kind of their own: their family's generic kind, their own name kept.
    let neo4j = map(
        "MATCH",
        &attrs(
            json!({"otel.span_kind": "client", "db.system": "neo4j", "db.operation.name": "MATCH",
                      "db.namespace": "graph", "server.address": "graph.local"}),
        ),
    );
    assert_eq!((neo4j.kind.as_str(), neo4j.name.as_str()), ("db", "MATCH"));
    assert_eq!(neo4j.attrs["db.system"], "neo4j");
    assert_eq!(neo4j.attrs["server.address"], "graph.local");
    let nats = map(
        "orders publish",
        &attrs(
            json!({"otel.span_kind": "producer", "messaging.system": "nats",
                      "messaging.destination.name": "orders"}),
        ),
    );
    assert_eq!(
        (nats.kind.as_str(), nats.name.as_str()),
        ("messaging", "publish orders")
    );
    assert_eq!(nats.attrs["messaging.system"], "nats");
    let thrift = map(
        "Users.get",
        &attrs(
            json!({"otel.span_kind": "client", "rpc.system": "thrift", "rpc.service": "Users",
                      "rpc.method": "get"}),
        ),
    );
    assert_eq!(
        (thrift.kind.as_str(), thrift.name.as_str()),
        ("rpc", "Users/get")
    );
    assert_eq!(thrift.attrs["rpc.system"], "thrift");
    // A gRPC server span: a function, its attributes kept.
    assert_eq!(
        one(
            "/svc/Method",
            json!({"otel.span_kind": "server", "rpc.system": "grpc"})
        ),
        ("function".into(), "/svc/Method".into())
    );
}

#[test]
fn http_from_its_parts() {
    // No url.full: built from the scheme, the host and the path.
    let mapped = map(
        "GET",
        &attrs(json!({
            "otel.span_kind": "client", "http.method": "get", "http.scheme": "https",
            "net.peer.name": "api.example.com", "http.target": "/v1/charges?limit=3",
            "http.status_code": 500,
        })),
    );

    assert_eq!(mapped.kind, "http.client");
    assert_eq!(mapped.name, "GET api.example.com/v1/charges");
    assert_eq!(
        mapped.attrs["url.full"],
        "https://api.example.com/v1/charges?limit=3"
    );
    assert_eq!(mapped.attrs["server.port"], 443);
    assert!(mapped.error);
}

#[test]
fn a_query_keeps_how_many_rows_it_returned() {
    let attrs = json!({
        "otel.span_kind": "client", "db.system.name": "postgresql", "db.query.text": "SELECT * FROM product",
        "db.response.returned_rows": 25000,
    });
    let mapped = tracepanel_analysis::otel::map("SELECT product", attrs.as_object().unwrap());

    assert_eq!(
        (
            mapped.kind.as_str(),
            &mapped.attrs["db.response.returned_rows"]
        ),
        ("sql", &json!(25000))
    );
}

/// Model calls as the GenAI instrumentations record them: an `llm` span with the `gen_ai.*` attributes in their
/// current names, an older instrumentation's (`gen_ai.system`, prompt and completion tokens, the cache's writes as
/// `cache_creation`, no operation) too. An
/// agent's or a tool's span is no model call.
#[test]
fn model_calls_are_llm_spans_in_the_current_names() {
    let current = map(
        "chat gpt-4o-mini",
        &attrs(json!({
            "otel.span_kind": "client", "otel.scope": "opentelemetry.instrumentation.openai_v2",
            "gen_ai.provider.name": "openai", "gen_ai.operation.name": "chat", "gen_ai.request.model": "gpt-4o-mini",
            "gen_ai.response.model": "gpt-4o-mini-2024-07-18", "gen_ai.usage.input_tokens": 12,
            "gen_ai.usage.output_tokens": 5, "server.address": "api.openai.com", "server.port": 443,
            "http.request.method": "POST",
        })),
    );
    let older = map(
        "anthropic.chat",
        &attrs(json!({
            "otel.span_kind": "client", "gen_ai.system": "anthropic", "gen_ai.request.model": "claude-sonnet-4-5",
            "gen_ai.usage.prompt_tokens": 30, "gen_ai.usage.completion_tokens": 7,
            "gen_ai.usage.cache_read.input_tokens": 10, "gen_ai.usage.cache_creation.input_tokens": 5,
        })),
    );
    let tool = map(
        "execute_tool get_weather",
        &attrs(json!({"otel.span_kind": "internal", "gen_ai.operation.name": "execute_tool"})),
    );

    assert_eq!(
        current,
        Mapped {
            kind: "llm".into(),
            name: "chat gpt-4o-mini".into(),
            attrs: attrs(json!({
                "otel.scope": "opentelemetry.instrumentation.openai_v2", "gen_ai.provider.name": "openai",
                "gen_ai.operation.name": "chat", "gen_ai.request.model": "gpt-4o-mini",
                "gen_ai.response.model": "gpt-4o-mini-2024-07-18", "gen_ai.usage.input_tokens": 12,
                "gen_ai.usage.output_tokens": 5, "server.address": "api.openai.com", "server.port": 443,
            })),
            error: false,
            reason: "A call to a model: the GenAI conventions' gen_ai.* attributes".into(),
        }
    );

    assert_eq!(
        (older.kind.as_str(), older.attrs),
        (
            "llm",
            attrs(json!({
                "gen_ai.provider.name": "anthropic", "gen_ai.operation.name": "chat",
                "gen_ai.request.model": "claude-sonnet-4-5", "gen_ai.usage.input_tokens": 30,
                "gen_ai.usage.output_tokens": 7, "gen_ai.usage.cache_read.input_tokens": 10,
                "gen_ai.usage.cache_write.input_tokens": 5,
            }))
        )
    );

    assert_eq!(tool.kind, "function");
}

#[test]
fn sql_comments_name_and_group_nothing() {
    let mapped = map(
        "query",
        &attrs(json!({
            "db.system": "postgresql",
            "db.statement": "/*controller='orders',traceparent='00-4bf9-01'*/ SELECT id\n-- the page's rows\nFROM orders \
                             WHERE note = '-- not /* a */ comment' AND id IN ($1, $2)",
        })),
    );

    assert_eq!(mapped.name, "SELECT orders");
    assert_eq!(
        mapped.attrs["db.fingerprint"],
        "SELECT id FROM orders WHERE note = '-- not /* a */ comment' AND id IN (...)"
    );
    // The statement keeps them, its line comment closed so the line it ended still reads as SQL.
    assert_eq!(
        mapped.attrs["db.statement"],
        "/*controller='orders',traceparent='00-4bf9-01'*/ SELECT id /* the page's rows */ FROM orders \
         WHERE note = '-- not /* a */ comment' AND id IN ($1, $2)"
    );
}

#[test]
fn an_sdks_commented_queries_are_named_and_grouped_without_them() {
    let query = |id: &str, statement: &str| {
        json!({"id": id, "parent_id": "01M5SQLR00T000000000000000", "kind": "sql", "name": "/*TRACEPARENT='00-1'*/",
               "start": 1, "duration": 1, "status": "ok",
               "attrs": {"db.statement": statement, "db.fingerprint": statement}})
    };
    let doc = json!({
        "id": "01M5SQLTRACE00000000000000", "kind": "request", "name": "GET /orders", "start": 0, "duration": 10,
        "status": "ok", "attrs": {},
        "spans": [
            {"id": "01M5SQLR00T000000000000000", "parent_id": null, "kind": "request", "name": "GET /orders",
             "start": 0, "duration": 10, "status": "ok", "attrs": {}},
            query("01M5SQLQUERY10000000000000", "/*traceparent='00-1'*/ SELECT * FROM orders WHERE id IN (%s, %s)"),
            query("01M5SQLQUERY20000000000000", "/*traceparent='00-2'*/ SELECT * FROM orders WHERE id IN (%s)"),
            // An older SDK's statement on one line: its `--` comment runs to its end, and is left as it is.
            query("01M5SQLQUERY30000000000000", "-- name: orders SELECT * FROM orders"),
        ],
        "logs": [], "errors": [], "links": [], "issues": [],
    });
    let mut received = tracepanel_protocol::Received {
        trace: serde_json::from_value(doc.clone()).unwrap(),
        doc: doc.to_string(),
    };

    tracepanel_analysis::otel::uncomment(&mut received);

    let rows: Vec<(&str, &Value)> = received.trace.spans[1..]
        .iter()
        .map(|span| (span.name.as_str(), &span.attrs["db.fingerprint"]))
        .collect();
    assert_eq!(
        rows,
        [
            (
                "SELECT orders",
                &json!("SELECT * FROM orders WHERE id IN (...)")
            ),
            (
                "SELECT orders",
                &json!("SELECT * FROM orders WHERE id IN (...)")
            ),
            (
                "/*TRACEPARENT='00-1'*/",
                &json!("-- name: orders SELECT * FROM orders")
            ),
        ]
    );

    let stored: Value = serde_json::from_str(&received.doc).unwrap();
    assert_eq!(stored["spans"][1]["name"], "SELECT orders");
    assert_eq!(
        stored["spans"][1]["attrs"]["db.statement"],
        "/*traceparent='00-1'*/ SELECT * FROM orders WHERE id IN (%s, %s)"
    );
}

/// The trace's `otel` spans mapped by `normalize`, from their documents.
fn normalized(spans: Value) -> Vec<Value> {
    let root = json!({"id": "01M5OTELR00T00000000000000", "parent_id": null, "kind": "request", "name": "GET /",
                      "start": 0, "duration": 10, "status": "ok", "attrs": {}});
    let mut all = vec![root];
    all.extend(
        spans
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(n, span)| {
                let mut span = span.clone();
                span["id"] = Value::from(format!("01M5OTELSPAN{n:014}"));
                span["parent_id"] = Value::from("01M5OTELR00T00000000000000");
                span["kind"] = Value::from("otel");
                span["start"] = Value::from(1);
                span["duration"] = Value::from(1);
                span["status"] = Value::from("ok");
                span
            }),
    );
    let doc = json!({
        "id": "01M5OTELTRACE0000000000000", "kind": "request", "name": "GET /", "start": 0, "duration": 10,
        "status": "ok", "attrs": {}, "spans": all, "logs": [], "errors": [], "links": [], "issues": [],
    });
    let mut received = tracepanel_protocol::Received {
        trace: serde_json::from_value(doc.clone()).unwrap(),
        doc: doc.to_string(),
    };

    tracepanel_analysis::otel::normalize(&mut received);

    let stored: Value = serde_json::from_str(&received.doc).unwrap();
    stored["spans"].as_array().unwrap()[1..].to_vec()
}

/// A mapped span keeps what came over OTLP under `received`: its name, its OpenTelemetry kind and scope, why it became
/// what it is, and its attributes. One the mapped span keeps with the same value is named in `same`, by the key it is
/// under there, not copied. A URL's credentials and sensitive values stay masked.
#[test]
fn a_mapped_span_keeps_what_it_received_and_why() {
    let spans = normalized(json!([
        {"name": "GET", "attrs": {
            "otel.span_kind": "client", "otel.scope": "opentelemetry.instrumentation.requests",
            "http.method": "GET", "http.url": "https://user:pw@shop.test/items?token=abc&page=2",
            "http.target": "/items?api_key=abc", "http.status_code": 200, "w3c.span_id": "00f067aa0ba902b7"}},
        {"name": "SELECT shop", "attrs": {
            "otel.span_kind": "client", "otel.scope": "@opentelemetry/instrumentation-pg",
            "db.system.name": "postgresql", "db.query.text": "SELECT * FROM book", "db.namespace": "shop"}},
        {"name": "send", "attrs": {
            "otel.span_kind": "client", "otel.scope": "custom", "peer.service": "billing"}},
        {"name": "render", "attrs": {"otel.span_kind": "internal", "otel.scope": "app", "items": 3}},
    ]));

    assert_eq!(
        spans[0]["received"],
        json!({
            "name": "GET", "span_kind": "client", "scope": "opentelemetry.instrumentation.requests",
            "mapped_as": "HTTP call: method from http.method, URL from http.url. It carries the trace on: links the \
                          trace of the service it called",
            "attrs": {"http.target": "/items?api_key=********"},
            "same": {"http.method": "http.request.method", "http.status_code": "http.response.status_code",
                     "http.url": "url.full", "w3c.span_id": "w3c.span_id"},
        })
    );

    assert_eq!(
        spans[1]["received"],
        json!({
            "name": "SELECT shop", "span_kind": "client", "scope": "@opentelemetry/instrumentation-pg",
            "mapped_as": "SQL: postgresql from db.system.name, statement from db.query.text",
            "same": {"db.namespace": "db.namespace", "db.query.text": "db.statement",
                     "db.system.name": "db.system"},
        })
    );

    assert_eq!(
        (&spans[2]["kind"], &spans[2]["received"]),
        (
            &json!("function"),
            &json!({
                "name": "send", "span_kind": "client", "scope": "custom",
                "mapped_as": "Not a call: a client span with no HTTP method or URL, no rpc.system or \
                              messaging.system, kept as a step. It carries no trace on: not linked to the service \
                              it called",
                "same": {"peer.service": "peer.service"},
            })
        )
    );

    assert_eq!(
        spans[3]["received"],
        json!({
            "name": "render", "span_kind": "internal", "scope": "app", "mapped_as": "An internal span: a step",
            "same": {"items": "items"},
        })
    );
}
