// The span kinds of the systems an app calls, by family: the agent maps OpenTelemetry spans to one kind per system
// (mongodb, kafka, grpc…), and the console groups them where one color or lane per system would be too many.

/** Datastores other than SQL and Redis, each its own kind. */
export const DATASTORES = ["mongodb", "elasticsearch", "cassandra", "dynamodb", "memcached"] as const;
/** Message brokers: a span publishes to one. */
export const MESSAGING = ["kafka", "rabbitmq", "sqs"] as const;
/** Calls to another service over the network. */
export const REMOTE = ["http.client", "grpc"] as const;

/** The kinds a call tree groups when repeated, as it groups queries. */
export const CALL_KINDS: ReadonlySet<string> = new Set([
  "sql",
  "redis",
  "cache",
  ...DATASTORES,
  ...MESSAGING,
  ...REMOTE,
]);
