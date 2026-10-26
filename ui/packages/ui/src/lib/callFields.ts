// A call's own fields, in its system's words: a Kafka publish's topic, partition and offset, a Redis command's key, a
// gRPC call's service and method. The span's attributes say the same in OpenTelemetry's general terms
// (messaging.destination.name): they are listed after, all of them, as recorded.
import { bytes, duration } from "../format";
import { COST, money, providerName, usageOf, usageText } from "./llm";
import { plural } from "./plural";
import { type Family, systemOfSpan } from "./systems";

type Attrs = Record<string, unknown>;

/** How a field's value reads, given the call's other attributes. */
type Format = (value: unknown, attrs: Attrs) => string;

/** One field: its label, the attributes that may hold it (the first one present wins), and how it reads. */
type Field = readonly [label: string, keys: readonly string[], format?: Format];

export interface CallField {
  label: string;
  value: string;
}

/** A server with its port: localhost:9092. */
function withPort(value: unknown, attrs: Attrs): string {
  const port = firstOf(attrs, ["server.port", "net.peer.port"]);
  return port === undefined ? String(value) : `${value}:${port}`;
}

const SERVER: Field = ["Server", ["server.address", "net.peer.name"], withPort];
const COMMAND: Field = ["Command", ["db.operation.name", "db.operation"]];
const OPERATION: Field = [
  "Operation",
  ["messaging.operation.type", "messaging.operation", "db.operation.name", "db.operation"],
];
const DATABASE: Field = ["Database", ["db.namespace", "db.name"]];

/** The template a query ran in as it rendered, with its line when the SDK knows it: `blog/list.html:4`. */
export function templatePlace(attrs: Readonly<Attrs>): string | null {
  const name = attrs["code.template"];
  if (typeof name !== "string" || !name) return null;
  const line = attrs["code.template_line"];
  return typeof line === "number" ? `${name}:${line}` : name;
}

/** A storage by its alias in STORAGES; one a FileField made has none, and is named by its class. */
function storageName(value: unknown, attrs: Attrs): string {
  return attrs["storage.alias"] ? String(value) : (String(value).split(".").at(-1) ?? String(value));
}

/** What a listing found: "2 directories, 14 files". */
function listed(_: unknown, attrs: Attrs): string {
  const dirs = plural(Number(attrs["storage.dirs"] ?? 0), "directory", "directories");
  return `${dirs}, ${plural(Number(attrs["storage.files"] ?? 0), "file", "files")}`;
}

/** The model asked for, and the one that answered when it is another (a dated snapshot): `gpt-5 → gpt-5-2025-08-07`. */
function models(value: unknown, attrs: Attrs): string {
  const answered = attrs["gen_ai.response.model"];
  return typeof answered === "string" && answered !== value ? `${value} → ${answered}` : String(value);
}

/** "12 in · 5 out · 4 cached": the call's tokens. */
function tokensOf(_: unknown, attrs: Attrs): string {
  const usage = usageOf(attrs);
  return usage ? usageText(usage) : "";
}

const LLM_FIELDS: readonly Field[] = [
  ["Provider", ["gen_ai.provider.name", "gen_ai.system"], (value) => providerName(String(value))],
  ["Model", ["gen_ai.request.model", "gen_ai.response.model"], models],
  ["Operation", ["gen_ai.operation.name"]],
  ["Tokens", ["gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens"], tokensOf],
  ["Cost", [COST], (value) => `${money(Number(value))} (estimate, at list price)`],
  // Seconds, as the conventions have it.
  ["Time to first token", ["gen_ai.response.time_to_first_chunk"], (value) => duration(Number(value) * 1e6)],
  ["Finish reason", ["gen_ai.response.finish_reasons"]],
  ["Tool calls", ["gen_ai.response.tool_calls"]],
  ["Error", ["error.type"]],
  ["Max tokens", ["gen_ai.request.max_tokens"]],
  ["Temperature", ["gen_ai.request.temperature"]],
  ["Reasoning", ["gen_ai.request.reasoning.level"]],
  SERVER,
];

const BY_SYSTEM = new Map<string, readonly Field[]>([
  [
    "sql",
    [
      DATABASE,
      ["Engine", ["db.system.name", "db.system", "db.vendor"]],
      ["Rows", ["db.response.returned_rows"]],
      SERVER,
      // The template that made the query as it rendered.
      ["Template", ["code.template"], (value, attrs) => templatePlace(attrs) ?? String(value)],
    ],
  ],
  [
    "redis",
    [
      COMMAND,
      ["Key", ["redis.key"]],
      ["Database", ["db.redis.database_index", "db.namespace"]],
      ["Pipeline", ["db.redis.pipeline_length"]],
      ["Connection", ["redis.alias"]],
      SERVER,
    ],
  ],
  [
    "cache",
    [
      ["Cache", ["cache.alias"]],
      ["Operation", ["cache.op"]],
      ["Key", ["cache.key"]],
      ["Result", ["cache.hit"], (hit) => (hit ? "hit" : "miss")],
      ["Backend", ["cache.system", "cache.library"]],
    ],
  ],
  ["mongodb", [COMMAND, ["Collection", ["db.collection.name", "db.mongodb.collection"]], DATABASE, SERVER]],
  ["elasticsearch", [COMMAND, ["Index", ["db.elasticsearch.path_parts.index", "db.collection.name"]], SERVER]],
  [
    "cassandra",
    [
      COMMAND,
      ["Keyspace", ["db.cassandra.keyspace", "db.namespace"]],
      ["Table", ["db.cassandra.table", "db.collection.name"]],
      SERVER,
    ],
  ],
  ["dynamodb", [COMMAND, ["Table", ["db.collection.name", "aws.dynamodb.table_names"]]]],
  ["memcached", [COMMAND, ["Key", ["db.memcached.key", "cache.key"]], SERVER]],
  [
    "kafka",
    [
      OPERATION,
      ["Topic", ["messaging.destination.name", "messaging.destination"]],
      ["Partition", ["messaging.kafka.destination.partition", "messaging.kafka.partition"]],
      ["Offset", ["messaging.kafka.message.offset", "messaging.kafka.offset"]],
      ["Message key", ["messaging.kafka.message.key"]],
      ["Consumer group", ["messaging.kafka.consumer.group", "messaging.consumer.group.name"]],
      SERVER,
    ],
  ],
  ["sqs", [OPERATION, ["Queue", ["messaging.destination.name", "messaging.destination"]]]],
  [
    "storage",
    [
      ["Storage", ["storage.alias", "storage.backend"], storageName],
      ["Backend", ["storage.system"]],
      ["Operation", ["storage.op"]],
      ["Path", ["storage.path"]],
      ["Bytes", ["storage.bytes"], (value) => bytes(Number(value))],
      ["Exists", ["storage.exists"], (exists) => (exists ? "yes" : "no")],
      ["Listed", ["storage.files"], listed],
      ["Saved as", ["storage.saved_as"]],
    ],
  ],
  ["llm", LLM_FIELDS],
  ["grpc", [["Service", ["rpc.service"]], ["Method", ["rpc.method"]], ["Status", ["rpc.grpc.status_code"]], SERVER]],
  [
    "http.client",
    [
      ["Method", ["http.request.method", "http.method"]],
      ["URL", ["url.full", "http.url"]],
      ["Status", ["http.response.status_code", "http.status_code"]],
    ],
  ],
]);

/** A system without its own fields: its family's, in the family's words. */
const BY_FAMILY = new Map<Family, readonly Field[]>([
  ["sql", BY_SYSTEM.get("sql") ?? []],
  ["datastore", [COMMAND, ["Collection", ["db.collection.name"]], DATABASE, SERVER]],
  ["messaging", [OPERATION, ["Destination", ["messaging.destination.name", "messaging.destination"]], SERVER]],
  ["rpc", [["Service", ["rpc.service"]], ["Method", ["rpc.method"]], SERVER]],
]);

const CALLED_FROM: Field = ["Called from", ["code.origin"]];

/** A list, one item a line: a signal's receivers. */
function lines(value: unknown): string {
  return Array.isArray(value) ? value.join("\n") : String(value);
}

/** A receiver's file and line: shop/receivers.py:12. */
function withLine(value: unknown, attrs: Attrs): string {
  const line = attrs["code.lineno"];
  return typeof line === "number" ? `${value}:${line}` : String(value);
}

/** Library code that sent a signal, when no code of the project's did: marked as the library's. */
function sentFrom(value: unknown, attrs: Attrs): string {
  return attrs["code.origin"] ? String(value) : `${value} (library)`;
}

/**
 * A signal's send and a receiver it ran: no system's call, fields of their own. Robust reads `signal.robust`, which
 * only a robust send has: every send says it.
 */
const BY_KIND = new Map<string, readonly Field[]>([
  [
    "signal",
    [
      ["Signal", ["signal.name"]],
      ["Sender", ["signal.sender"]],
      [
        "Robust",
        ["signal.name"],
        (_, attrs) => (attrs["signal.robust"] === true ? "yes: a receiver's error is caught" : "no"),
      ],
      ["Receivers", ["signal.receivers"], lines],
    ],
  ],
  [
    "receiver",
    [
      ["Function", ["code.function"]],
      ["Defined at", ["code.filepath"], withLine],
    ],
  ],
]);

/** Where a call was made; a send made by no code of the project's names the library's line. */
const ORIGINS = new Map<string, Field>([["signal", ["Called from", ["code.origin", "code.caller"], sentFrom]]]);

function firstOf(attrs: Attrs, keys: readonly string[]): unknown {
  return keys.map((key) => attrs[key]).find((value) => value !== undefined && value !== null && value !== "");
}

function plain(value: unknown): string {
  return Array.isArray(value) ? value.join(", ") : String(value);
}

/**
 * RabbitMQ publishes to an exchange; through the default one, to the queue its routing key names, and then the
 * destination is that queue.
 */
function rabbitFields(attrs: Attrs): readonly Field[] {
  const queue = firstOf(attrs, ["messaging.destination.name"]) === attrs["messaging.rabbitmq.destination.routing_key"];
  return [
    OPERATION,
    [queue ? "Queue" : "Exchange", ["messaging.destination.name", "messaging.destination"]],
    ["Routing key", ["messaging.rabbitmq.destination.routing_key"]],
    SERVER,
  ];
}

/** Every system's and family's fields, a family's under `family <name>`; RabbitMQ's depend on where it sends. */
const FIELDS = new Map<string, (attrs: Attrs) => readonly Field[]>([
  ...[...BY_SYSTEM].map(([kind, fields]) => [kind, () => fields] as const),
  ...[...BY_FAMILY].map(([family, fields]) => [`family ${family}`, () => fields] as const),
  ["rabbitmq", rabbitFields],
]);

/** An HTTP call is an `http` span in some SDKs, `http.client` in others. */
const KINDS = new Map([["http", "http.client"]]);

function kindOf(span: { kind: string }): string {
  return KINDS.get(span.kind) ?? span.kind;
}

function fieldsOf(span: { kind: string; attrs: Attrs }): readonly Field[] {
  return BY_KIND.get(span.kind) ?? systemFields(span);
}

function systemFields(span: { kind: string; attrs: Attrs }): readonly Field[] {
  const system = systemOfSpan({ kind: kindOf(span), attrs: span.attrs });
  const fields = [system?.kind, `family ${system?.family}`].map((key) => FIELDS.get(String(key))).find(Boolean);
  return fields ? fields(span.attrs) : [];
}

/**
 * A call's fields in its system's words, then where in the app it was made; the ones it has, in this order. A
 * receiver's span is a function's: its kind here is `receiver`.
 */
export function callFields(span: { kind: string; attrs: Attrs }, origin = true): CallField[] {
  const fields = origin ? [...fieldsOf(span), ORIGINS.get(span.kind) ?? CALLED_FROM] : fieldsOf(span);
  return fields.flatMap(([label, keys, format = plain]) => {
    const value = firstOf(span.attrs, keys);
    return value === undefined ? [] : [{ label, value: format(value, span.attrs) }];
  });
}
