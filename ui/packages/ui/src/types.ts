// Types of the tracepanel API and trace documents, all generated from the contract (schema/openapi.yaml and
// schema/trace.schema.json in tracepanel-python) into api.gen.ts: run `pnpm api` after the contract changes.
// biome-ignore-all lint/style/useNamingConvention: field names follow the JSON wire format.
import type { components } from "./api.gen";

type Schemas = components["schemas"];
type TraceDefs = Schemas["trace.schema"]["$defs"];

/* ---------- trace documents (trace.schema.json) ---------- */

export type Trace = Omit<Schemas["trace.schema"], "$defs">;
export type Span = TraceDefs["span"];
export type Log = TraceDefs["log"];
export type Frame = TraceDefs["frame"];
export type TraceError = TraceDefs["error"];
export type ChainedError = TraceDefs["chained_error"];
export type Issue = TraceDefs["issue"];
export type Attrs = TraceDefs["attrs"];
export type Scalar = string | number | boolean | null;
export type Status = TraceDefs["status"];
export type SpanKind = Span["kind"];
export type IssueKind = Schemas["IssueKind"];

/* ---------- API responses (openapi.yaml) ---------- */

export type TraceSummary = Schemas["TraceSummary"];
export type LogRow = Schemas["LogRow"];
export type LogBucket = Schemas["LogBucket"];
export type MailRow = Schemas["MailRow"];
export type CallRow = Schemas["CallRow"];
export type CallsSummary = Schemas["CallsSummary"];
export type ExplainPlan = Schemas["ExplainPlan"];
export type EndpointRow = Schemas["EndpointRow"];
export type TaskRow = Schemas["TaskRow"];
/** Tasks in flight and the workers seen (GET /tasks/live). */
export type LiveTasks = Schemas["LiveTasks"];
export type LiveTask = Schemas["LiveTask"];
export type LiveWorker = Schemas["LiveWorker"];
export type WebsocketRow = Schemas["WebsocketRow"];
export type GraphqlRow = Schemas["GraphqlRow"];
export type GraphqlDetail = Schemas["GraphqlDetail"];
export type ResolverStats = Schemas["ResolverStats"];
export type TraceGroup = Schemas["TraceGroup"];
export type JobRow = Schemas["JobRow"];
export type RpcRow = Schemas["RpcRow"];
export type PageRow = Schemas["PageRow"];
export type Related = Schemas["Related"];
/** Where a trace hangs in its chain of calls (GET /traces/{id}/chain), with the trace on the chain's clock. */
export type ChainTrace = Schemas["ChainTrace"];
export type ServiceApp = Schemas["ServiceApp"];
export type ServiceNode = Schemas["ServiceNode"];
export type ServiceEdge = Schemas["ServiceEdge"];
/** The AWS service a server is, in its region. */
export type CloudService = Schemas["CloudService"];
/** Calls to AWS by service and operation (GET /aws), and one call (GET /aws/calls). */
export type AwsOperation = Schemas["AwsOperation"];
export type AwsCall = Schemas["AwsCall"];
/** What the project's web, workers and commands call (GET /services). */
export type AppLink = Schemas["AppLink"];
export interface ServiceMap {
  apps: ServiceApp[];
  /** One app calling another (the W3C trace context its call carried). */
  links: AppLink[];
  services: ServiceNode[];
  edges: ServiceEdge[];
}
export type EndpointDetail = Schemas["EndpointDetail"];
export type IssueGroup = Schemas["IssueGroup"];
export type IssueRow = Schemas["IssueRow"];
export type IssueDetail = Schemas["IssueDetail"];
export type TracesOverview = Schemas["TracesOverview"];
export type OperationStats = Schemas["OperationStats"];
export type KindStats = Schemas["KindStats"];
export type StatsSummary = Schemas["StatsSummary"];
export type SeriesBucket = Schemas["SeriesBucket"];
export type HistogramBucket = Schemas["HistogramBucket"];
export type Counts = Schemas["Counts"];
export type KnownValues = Schemas["KnownValues"];
export type Capabilities = Schemas["Capabilities"];
/** What an app said about itself in its hello: its settings, masked, and its versions (GET /app). */
export type App = Schemas["App"];
export type AppVersion = Schemas["AppVersion"];
export type SearchSpec = Schemas["SearchSpec"];
export type User = Schemas["User"];
export type SearchResource = keyof SearchSpec;

/** One page of a cursor-paged list (traces, logs, mails): pass `next` as `before` for the following page. */
export interface Page<T> {
  items: T[];
  next: number | null;
}
