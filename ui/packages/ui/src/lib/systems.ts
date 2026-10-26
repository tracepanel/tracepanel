// The systems an app calls, as one table: each is a span kind (the agent maps OpenTelemetry spans to one per system)
// and a page of its operations. Everything the console shows per system — its name, its family's color and lane, its
// page's filters, what a group of its calls is called — comes from here, so a new system is one row.

/** Systems grouped where one color, lane or tile per system would be too many. */
export type Family = "sql" | "redis" | "cache" | "datastore" | "messaging" | "rpc" | "http" | "storage" | "llm";

export interface System {
  /** The span kind, and the `system` of its operations in the agent's API. */
  kind: string;
  family: Family;
  /** Its name in the console: "MongoDB", "HTTP calls". */
  label: string;
  /** What one call and several are called: a group of similar calls in a trace, an issue's "Show N …". */
  one: string;
  many: string;
  /** What its calls go to, as the filter says it: the database, the host, the topic. */
  target: string;
  /** Its operations, offered by the Operation filter. */
  ops: readonly string[];
  /** What its page says it lists. */
  description: string;
}

const SQL_OPS = ["SELECT", "INSERT", "UPDATE", "DELETE"];
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export const SYSTEMS: readonly System[] = [
  {
    kind: "sql",
    family: "sql",
    label: "Database",
    one: "query",
    many: "queries",
    target: "Database",
    ops: SQL_OPS,
    description: "SQL statements across requests: how often they run, how long they take, and their query plans.",
  },
  {
    kind: "redis",
    family: "redis",
    label: "Redis",
    one: "Redis command",
    many: "Redis commands",
    target: "Instance",
    ops: ["GET", "SET", "MGET", "HGET", "HSET", "INCR", "DEL", "EXPIRE", "LPUSH", "PIPELINE"],
    description: "Redis commands your app runs: which keys, how often, how long they take, how often they fail.",
  },
  {
    kind: "cache",
    family: "cache",
    label: "Cache",
    one: "cache call",
    many: "cache calls",
    target: "Cache",
    ops: ["get", "set", "add", "delete", "get_many", "set_many", "incr"],
    description: "Cache reads and writes through your framework's cache: hit rate, keys, and time.",
  },
  {
    kind: "mongodb",
    family: "datastore",
    label: "MongoDB",
    one: "MongoDB command",
    many: "MongoDB commands",
    target: "Database",
    ops: ["find", "insert", "update", "delete", "aggregate", "count"],
    description: "MongoDB commands your app runs: which collections, how often, how long they take.",
  },
  {
    kind: "elasticsearch",
    family: "datastore",
    label: "Elasticsearch",
    one: "Elasticsearch request",
    many: "Elasticsearch requests",
    target: "Cluster",
    ops: ["search", "index", "get", "bulk", "delete"],
    description: "Elasticsearch and OpenSearch requests: which indices, how often, how long they take.",
  },
  {
    kind: "cassandra",
    family: "datastore",
    label: "Cassandra",
    one: "Cassandra query",
    many: "Cassandra queries",
    target: "Keyspace",
    ops: SQL_OPS,
    description: "Cassandra queries: which tables, how often, how long they take.",
  },
  {
    kind: "dynamodb",
    family: "datastore",
    label: "DynamoDB",
    one: "DynamoDB request",
    many: "DynamoDB requests",
    target: "Table",
    ops: ["GetItem", "PutItem", "Query", "Scan", "UpdateItem", "DeleteItem", "BatchGetItem"],
    description: "DynamoDB requests: which tables, how often, how long they take.",
  },
  {
    kind: "memcached",
    family: "datastore",
    label: "Memcached",
    one: "Memcached command",
    many: "Memcached commands",
    target: "Server",
    ops: ["get", "set", "delete", "get_multi"],
    description: "Memcached commands: which keys, how often, how long they take.",
  },
  {
    kind: "kafka",
    family: "messaging",
    label: "Kafka",
    one: "Kafka message",
    many: "Kafka messages",
    target: "Topic",
    ops: ["publish"],
    description: "Messages your app publishes to Kafka: which topics, how often, how long sending takes.",
  },
  {
    kind: "rabbitmq",
    family: "messaging",
    label: "RabbitMQ",
    one: "RabbitMQ message",
    many: "RabbitMQ messages",
    target: "Queue",
    ops: ["publish"],
    description: "Messages your app publishes to RabbitMQ: which exchanges and queues, how often.",
  },
  {
    kind: "sqs",
    family: "messaging",
    label: "Amazon SQS",
    one: "SQS message",
    many: "SQS messages",
    target: "Queue",
    ops: ["publish"],
    description: "Messages your app sends to SQS: which queues, how often, how long sending takes.",
  },
  {
    kind: "grpc",
    family: "rpc",
    label: "gRPC",
    one: "gRPC call",
    many: "gRPC calls",
    target: "Service",
    ops: [],
    description: "gRPC calls your app makes: which services and methods, how often, how often they fail.",
  },
  {
    kind: "http.client",
    family: "http",
    label: "HTTP calls",
    one: "HTTP call",
    many: "HTTP calls",
    target: "Host",
    ops: HTTP_METHODS,
    description: "The HTTP calls your app makes to other services: how often, how long they take, how often they fail.",
  },
  {
    kind: "storage",
    family: "storage",
    label: "Storage",
    one: "storage call",
    many: "storage calls",
    target: "Storage",
    ops: ["save", "open", "exists", "url", "listdir", "size", "delete"],
    description: "Calls your file storages make, on the local disk or S3: which files, how often, how long they take.",
  },
  {
    kind: "llm",
    family: "llm",
    label: "LLM",
    one: "LLM call",
    many: "LLM calls",
    target: "Provider",
    ops: ["chat", "embeddings", "text_completion", "generate_content"],
    description: "Calls your app makes to LLMs: which models, how often, how long they take, their tokens and cost.",
  },
];

export const SYSTEM_OF: ReadonlyMap<string, System> = new Map(SYSTEMS.map((system) => [system.kind, system]));

/**
 * A system the table doesn't know (Neo4j, NATS, Thrift…) arrives as its family's generic kind (`db`, `messaging`,
 * `rpc`) with its real name: it gets the family's words and filters, under that name.
 */
const GENERIC: Record<string, Family> = { db: "datastore", messaging: "messaging", rpc: "rpc" };
const FAMILY_DEFAULTS: Record<Family, Pick<System, "one" | "many" | "target" | "ops">> = {
  sql: { one: "query", many: "queries", target: "Database", ops: SQL_OPS },
  redis: { one: "command", many: "commands", target: "Instance", ops: [] },
  cache: { one: "cache call", many: "cache calls", target: "Cache", ops: [] },
  datastore: { one: "command", many: "commands", target: "Database", ops: [] },
  messaging: { one: "message", many: "messages", target: "Destination", ops: ["publish"] },
  rpc: { one: "call", many: "calls", target: "Service", ops: [] },
  http: { one: "HTTP call", many: "HTTP calls", target: "Host", ops: HTTP_METHODS },
  storage: { one: "storage call", many: "storage calls", target: "Storage", ops: [] },
  llm: { one: "LLM call", many: "LLM calls", target: "Provider", ops: [] },
};

/**
 * Names of systems the table has no row for, as the agent writes them in its issues: what a span in a trace is called
 * before the agent's counts (which carry the name) are at hand.
 */
const LABELS: Record<string, string> = {
  opensearch: "OpenSearch",
  neo4j: "Neo4j",
  couchbase: "Couchbase",
  influxdb: "InfluxDB",
  nats: "NATS",
  pulsar: "Pulsar",
  // biome-ignore lint/style/useNamingConvention: the system's name as OpenTelemetry writes it.
  google_pubsub: "Google Pub/Sub",
  thrift: "Thrift",
  jsonrpc: "JSON-RPC",
  "aws-api": "AWS",
  // A family's generic kind: a system that didn't name itself, as the agent names it.
  rpc: "RPC",
  db: "Datastore",
  messaging: "Broker",
};

/** A system by its name in the agent's operations (`mongodb`, `neo4j`), the table's or one made for it. */
export function systemNamed(name: string, family: Family, agentLabel?: string): System {
  const known = SYSTEM_OF.get(name);
  if (known) return known;
  const label = agentLabel ?? LABELS[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
  const words = FAMILY_DEFAULTS[family];
  return {
    kind: name,
    family,
    label,
    ...words,
    one: `${label} ${words.one}`,
    many: `${label} ${words.many}`,
    description: `${label} ${words.many} your app makes: how often, how long they take, how often they fail.`,
  };
}

/** The kinds of one family, its generic kind included: the lanes, tiles and breakdown categories that group them. */
export function kindsOf(family: Family): string[] {
  const generic = Object.keys(GENERIC).filter((kind) => GENERIC[kind] === family);
  return [...SYSTEMS.filter((system) => system.family === family).map((system) => system.kind), ...generic];
}

/** The kinds a call tree groups when repeated, as it groups queries. */
export const CALL_KINDS: ReadonlySet<string> = new Set([
  ...SYSTEMS.map((system) => system.kind),
  ...Object.keys(GENERIC),
]);

export const DATASTORES = kindsOf("datastore");
export const MESSAGING = kindsOf("messaging");
export const RPC = kindsOf("rpc");

/** Where a generic kind's span names its system. */
const SYSTEM_ATTRS = ["db.system", "messaging.system", "rpc.system"];

/** The system a span calls: its kind's, or, for a generic kind, the one its attributes name. */
export function systemOfSpan(span: { kind: string; attrs: Record<string, unknown> }): System | undefined {
  const family = GENERIC[span.kind];
  if (!family) return SYSTEM_OF.get(span.kind);
  const name = SYSTEM_ATTRS.map((key) => span.attrs[key]).find((value) => typeof value === "string");
  // One that names no system is the family's generic kind, named as the agent names it ("RPC").
  return systemNamed(typeof name === "string" ? name : span.kind, family);
}

/** The agent lists HTTP calls as system "http" (their span kind is `http.client`); every other system by its kind. */
const PAGE_KINDS: Record<string, string> = { http: "http.client" };

/**
 * A page of a family's generic kind (a system that didn't name itself): named as its calls, as "HTTP calls" is,
 * apart from the entry point of the same name (RPC).
 */
const GENERIC_PAGES: Record<string, string> = { rpc: "RPC calls", db: "Datastore calls", messaging: "Messages" };

/** A system by the name the agent's operations give it (`sql`, `http`, `mongodb`, `neo4j`): its page. */
export function systemOfPage(name: string, family: Family | undefined, label?: string): System {
  const system = systemNamed(PAGE_KINDS[name] ?? name, family ?? "datastore", label);
  const page = GENERIC_PAGES[name];
  return page ? { ...system, label: page } : system;
}

/** The families in the order the console lists systems: the agent's counts order them the same way. */
export const FAMILY_ORDER: readonly Family[] = [
  "sql",
  "redis",
  "cache",
  "datastore",
  "messaging",
  "rpc",
  "http",
  "storage",
  "llm",
];

/** The name of a system's page in the agent's operations. */
export function pageOf(system: System): string {
  return system.kind === "http.client" ? "http" : system.kind;
}

/** The databases the agent lists under SQL (their vendor in `vendor`): a service of one opens the SQL page. */
export const SQL_VENDORS: ReadonlySet<string> = new Set([
  "postgresql",
  "mysql",
  "mariadb",
  "sqlite",
  "oracle",
  "mssql",
  "db2",
  "cockroachdb",
  "clickhouse",
  "h2",
  "hsqldb",
  "derby",
  "trino",
  "snowflake",
  "redshift",
  "other_sql",
]);
