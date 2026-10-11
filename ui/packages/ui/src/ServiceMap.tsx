import type { ServiceNode } from "./types";

const SYSTEMS: Record<string, string> = {
  postgresql: "PostgreSQL",
  mysql: "MySQL",
  sqlite: "SQLite",
  oracle: "Oracle",
  redis: "Redis",
  valkey: "Valkey",
  memcached: "Memcached",
  locmem: "Local memory",
  file: "File cache",
  database: "Database cache",
  dummy: "Dummy cache",
  smtp: "SMTP",
  console: "Console",
  filebased: "File",
  rabbitmq: "RabbitMQ",
  sqs: "Amazon SQS",
  memory: "In-memory broker",
  filesystem: "Filesystem broker",
  http: "HTTP",
  https: "HTTPS",
};

export const SERVICE_KINDS: Record<ServiceNode["kind"], string> = {
  database: "Database",
  cache: "Cache",
  mail: "Mail",
  queue: "Broker",
  http: "HTTP API",
};

export function systemName(node: ServiceNode): string {
  const name = SYSTEMS[node.system] ?? node.system;
  // A mail backend named like a cache backend (locmem) reads better with its kind.
  return node.kind === "mail" && node.system !== "smtp" ? `${name} mail` : name;
}

/** `db.internal:5432 / blog`, `/run/redis.sock`, or the alias of an in-process cache. */
export function serviceWhere(node: ServiceNode): string {
  const host = node.address ? (node.port ? `${node.address}:${node.port}` : node.address) : "";
  return [host, node.namespace].filter(Boolean).join(" / ") || "in process";
}
