# Schemas

The contracts between the SDKs, the agent and the UI.

| File | Contents |
| --- | --- |
| `trace.schema.json` | A trace as an SDK records and sends it, and as the API returns it with the issues the agent found |
| `openapi.yaml` | The console's API. The UI generates its types from it (`pnpm api`) |
| `search.json` | The fields of the search language, which `GET /api/search` serves |
| `store.sql` | The store's tables. Its `-- version:` line names the store's file |
| `examples/` | Traces as the SDKs send them, with the issues each must get (`expected.json`). `crates/server/tests/examples.rs` checks the schema, the analysis and the API against them |

Times are Unix epoch microseconds (UTC), durations are microseconds, and ids
are ULIDs.

## Entities

- **Trace**: an HTTP request, a background task or a management command
  (`kind`). A task is a trace of its own, with a `link` to the span that
  enqueued it.
- **Span**: a unit of work inside a trace. `kind` is one of `http`, `sql`,
  `cache`, `storage`, `llm`, `migration`, `migration.operation`,
  `http.client`, `template`, `signal`, `task.enqueue`, `task.run`, `command`
  and `function`. `attrs` are open and namespaced: `http.route`,
  `db.fingerprint`, `cache.hit`, `code.origin`.
- **Signal**: a send with receivers (a Django signal), a `signal` span with
  `signal.name`, `signal.sender` and `signal.receivers`. Each receiver is a
  `function` span under it. One that raised has status `error` and
  `exception.type` / `exception.message`, while under `signal.robust` the
  trace stays ok. The sends nobody received make no span: the trace's
  `signal.unreceived` counts them.
- **Storage call**: a call a file storage makes to its backend (Django's
  `Storage`: the local disk, S3), a `storage` span with `storage.alias`,
  `storage.system`, `storage.op` and `storage.path`. A `function` span with
  `storage.op`, as SDKs before the kind send them, is made a `storage` span
  when it arrives.
  A call to S3's API (botocore's) is a `storage` span too, with
  `storage.system` `s3`, the API's operation as `storage.op` (`GetObject`,
  `HeadObject`, `ListObjectsV2`) and the bucket and key as `storage.path`.
- **AWS call**: a call to an AWS API, whatever its span's kind (S3 a
  `storage` span, DynamoDB `dynamodb`, SQS's SendMessage `sqs`, SNS's
  Publish `messaging`, any other `rpc`), with `rpc.system` `aws-api`,
  `rpc.service` (`S3`, `Lambda`), `rpc.method`, `cloud.region`,
  `aws.request_id`, `aws.retry_attempts` and, when it failed, its code in
  `error.type`. One whose parent is a `storage`, `cache` or `task.enqueue`
  span was made for that call: its issues are the layer's, as a Redis
  command's under a cache call are, and the services map draws the layer as
  the AWS service it reached.
- **Migration**: a migration a migrate command applied or unapplied, a
  `migration` span with `migration.app`, `migration.name`,
  `migration.direction` and `migration.fake`. Each operation it ran is a
  `migration.operation` span inside, with `migration.operation`,
  `migration.rows` and `migration.risk` when it locks or rewrites a table. A
  `function` span with `migration.app` or `migration.operation`, as SDKs
  before the kinds send them, is made one when it arrives.
- **LLM call**: a call to a model through a provider's API (OpenAI,
  Anthropic), an `llm` span with OpenTelemetry's GenAI attributes:
  `gen_ai.provider.name`, `gen_ai.operation.name`, the request and response
  model, `gen_ai.usage.*` tokens and, when the app captures them, the
  messages. A `function` span with `gen_ai.operation.name` (chat,
  text_completion, generate_content, embeddings), as SDKs before the kind
  send them, is made an `llm` span when it arrives, and the agent adds its
  estimated cost, `tracepanel.cost_usd`.
- **Log**: a log record, bound to a span.
- **Error**: an exception with its frames, bound to a span.
- **Issue**: a problem the agent finds (`n+1`, `duplicates`, `slow-sql`,
  `error` and others), with a stable `fingerprint`. SDKs send traces without
  issues.
- **Task event**: a step of a task in flight (`enqueued`, `started`,
  `retried`, `finished`), a worker's `heartbeat` every 30 seconds, or its
  `worker_stopped` as it stops cleanly, sent before the task's trace
  exists. The agent keeps the tasks in flight in memory, not in the store,
  and serves them at `GET /api/tasks/live`. `crates/protocol/src/live.rs`
  names the fields.
- **App**: what an app says about itself once, in its hello (`app`): its
  settings, masked by its SDK, the versions of what it runs on, and what its
  checks found (`checks`, `migrations`), or in an `{"app": {...}}` frame
  once they ran. Per app, not per request: the agent keeps the latest in
  memory and serves it at `GET /api/app?service=`.
  `crates/protocol/src/about.rs` names the fields.

## Add an example

Run an app against `tracepanel-agent --record DIR`. The agent saves every trace
as it arrives, before the analysis. Copy the traces worth keeping here, with a
name that says what each shows, add them to `expected.json`, and replace the
recording machine's home directory in their paths.
