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
fn sql_server_names_and_placeholders() {
    // go-mssqldb's @p1, tedious's @name, JDBC's ?: each IN list collapses, and the table keeps its schema.
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
            ("SELECT dbo.orders", &json!(fingerprint))
        );
    }

    let oracle = map(
        "query",
        &attrs(json!({
            "db.system": "oracle",
            "db.statement": r#"SELECT "ID" FROM "SHOP"."ORDERS" WHERE "ID" IN (:1, :2)"#,
        })),
    );

    assert_eq!(oracle.name, "SELECT SHOP.ORDERS");
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
