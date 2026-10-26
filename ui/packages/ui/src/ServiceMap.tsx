import {
  DatabaseIcon,
  GlobeIcon,
  HardDriveIcon,
  type LucideIcon,
  MailIcon,
  MemoryStickIcon,
  WorkflowIcon,
  ZapIcon,
} from "lucide-react";
import { cn } from "./lib/utils";
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
  // biome-ignore lint/style/useNamingConvention: the system's name as OpenTelemetry writes it.
  aws_sqs: "Amazon SQS",
  kafka: "Kafka",
  mongodb: "MongoDB",
  elasticsearch: "Elasticsearch",
  opensearch: "OpenSearch",
  cassandra: "Cassandra",
  dynamodb: "DynamoDB",
  mariadb: "MariaDB",
  mssql: "SQL Server",
  clickhouse: "ClickHouse",
  grpc: "gRPC",
  memory: "In-memory broker",
  filesystem: "Filesystem broker",
  http: "HTTP",
  https: "HTTPS",
};

/** File storages by their system: their own names, apart from a broker's of the same (memory, filesystem). */
const STORAGES: Record<string, string> = {
  filesystem: "Local disk",
  memory: "In-memory storage",
  s3: "Amazon S3",
  gcs: "Google Cloud Storage",
  azure: "Azure Blob Storage",
  dropbox: "Dropbox",
  sftp: "SFTP",
  ftp: "FTP",
  libcloud: "Apache Libcloud",
};

export const SERVICE_KINDS: Record<ServiceNode["kind"], string> = {
  database: "Database",
  cache: "Cache",
  storage: "Storage",
  mail: "Mail",
  queue: "Broker",
  http: "HTTP API",
};

/** The names a kind's systems go by: a storage's its own. */
function namesOf(kind: ServiceNode["kind"]): Record<string, string> {
  return kind === "storage" ? STORAGES : SYSTEMS;
}

export function systemName(node: Pick<ServiceNode, "kind" | "system" | "cloud">): string {
  // An AWS service by AWS's name for it: Amazon S3, AWS Lambda.
  if (node.cloud) return node.cloud.name;
  const name = namesOf(node.kind)[node.system] ?? node.system;
  // A mail backend named like a cache backend (locmem) reads better with its kind.
  return node.kind === "mail" && node.system !== "smtp" ? `${name} mail` : name;
}

/** `db.internal:5432 / blog`, `/run/redis.sock`, or the alias of an in-process cache. */
export function serviceWhere(node: ServiceNode): string {
  const host = node.address ? (node.port ? `${node.address}:${node.port}` : node.address) : "";
  return [host, node.namespace].filter(Boolean).join(" / ") || "in process";
}

const KIND_ICONS: Record<ServiceNode["kind"], LucideIcon> = {
  database: DatabaseIcon,
  cache: ZapIcon,
  storage: HardDriveIcon,
  mail: MailIcon,
  queue: WorkflowIcon,
  http: GlobeIcon,
};

/**
 * The system's kind as an icon, its name in text beside it: PostgreSQL, Redis and RabbitMQ keep their logos to
 * themselves. An in-process cache or broker is a memory stick.
 */
export function ServiceIcon({ node, className }: { node: Pick<ServiceNode, "kind" | "system">; className?: string }) {
  const memory = node.kind !== "mail" && (node.system === "locmem" || node.system === "memory");
  const Icon = memory ? MemoryStickIcon : KIND_ICONS[node.kind];
  return <Icon className={cn("size-3.5", className)} aria-hidden="true" />;
}
