// Generated from schema/openapi.yaml by `pnpm api`. Do not edit.
export interface paths {
    "/traces": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Traces matching a search, newest first. */
        get: operations["searchTraces"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/traces/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One trace with its spans, logs, errors and issues. */
        get: operations["getTrace"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/traces/{id}/related": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Traces linked to this one, by kind: task enqueues, WebSocket connections, channel layer messages. */
        get: operations["relatedTraces"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/snapshot/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** A trace to share, with the traces linked to it and the links of each: what the console writes into a snapshot file, which opens without the agent. */
        get: operations["traceSnapshot"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/traces/overview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Monitoring over every trace matching a search, grouped into operations (kind + name). */
        get: operations["tracesOverview"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/logs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Log records matching a search, newest first. */
        get: operations["searchLogs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/logs/series": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * How many log records matching a search were logged over time, by level.
         * @description 60 slices of the period the search's since: and until: give, else of the records' own (at least ten minutes, up to the last one). Each slice counts its records, in all and by level.
         */
        get: operations["logSeries"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/mails": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Sent emails matching a search, newest first. */
        get: operations["searchMails"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/calls": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Calls the app made to other systems (SQL, Redis, cache, HTTP, a datastore, a broker, an RPC system) aggregated per key across stored traces, heaviest first. One list for every system; `system` narrows it to one, as `system:` in q does. */
        get: operations["listCalls"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/calls/summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The calls /calls lists at a glance, over every one of them (not the top groups a list shows): the tiles above a system's page. The same `q` and `system`. */
        get: operations["callsSummary"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/explain": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** EXPLAIN (or EXPLAIN ANALYZE) of one captured SELECT, run on its database. */
        get: operations["explain"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/tasks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Background tasks by name (Celery, Django Tasks; system names the queue), busiest first. */
        get: operations["listTasks"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/tasks/live": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Tasks in flight (queued, running, waiting to be retried) and the workers seen, from the apps' task events.
         * @description A task's trace reaches the store when the task ends; until then the apps' task events say where it is. The agent keeps them in memory, not in the store: a task that finishes leaves this list, and its trace is listed under /tasks. A running task whose worker stopped sending heartbeats for two minutes is dropped, a queued or retrying one after an hour without news, a worker not heard from for an hour too. An app whose events reach the agent says `live_tasks` in its hello (see /capabilities).
         */
        get: operations["liveTasks"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/graphql": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** GraphQL operations (Strawberry) by name, with calls, errors, latency and queries, busiest first. */
        get: operations["listGraphqlOperations"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/traces/summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Any group of traces named by a search (task:x, operation:"query X", kind:command name:y): percentiles, series, histogram, issues, slowest and recent calls. Every group page in the console is one of these. */
        get: operations["summarizeTraces"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Jobs (management commands and tracepanel.trace() blocks) by name, busiest first. */
        get: operations["listJobs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/rpc": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** RPC calls served (gRPC and other RPC systems' servers) by method, Service/Method, busiest first. */
        get: operations["listRpcs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Pages viewed in a browser (tracepanel-js's browser recording) by path, busiest first. */
        get: operations["listPages"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ingest": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Traces a page recorded in the browser, sent as an SDK sends them: a JSON array of traces. */
        post: operations["ingestTraces"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/graphql/detail": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One GraphQL operation, like an endpoint (percentiles, series, issues, calls), plus its resolvers. */
        get: operations["getGraphqlOperation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/websockets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** WebSocket consumers (Channels) with their connections, messages, errors and handler time, busiest first. */
        get: operations["listWebsockets"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/services": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** What the project's web, workers and commands talk to (databases, caches, mail, brokers, HTTP APIs) and how much: the nodes and edges of a service map. */
        get: operations["listServices"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/endpoints": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** HTTP traffic per route. */
        get: operations["listEndpoints"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/endpoints/detail": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One endpoint with percentiles, time series, issues and calls. */
        get: operations["getEndpoint"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/issues": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Issues (errors, N+1, duplicate and slow SQL) by fingerprint, most recent first. */
        get: operations["listIssues"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/issues/detail": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * One issue with its events over time and the requests it happened in.
         * @description With `q`, its series and requests are those within the search (since:, until:); without it, all of them.
         */
        get: operations["getIssue"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/counts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Navigation badges. */
        get: operations["counts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/capabilities": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * What the console's backend can do beyond the store.
         * @description The agent answers it, and it alone, from what the connected apps said in their hello: what an app does down its connection or records in its traces (`capabilities`: `explain`, `profile`, `request`, `live_tasks`), and what it answers at its own console (`console`: `explain`, `users`). The latter are offered only to the console an app serves, which names the app in a `Tracepanel-Console` header: the agent's own console has nowhere to run them. The console shows a feature only where it works.
         */
        get: operations["capabilities"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/app": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * What an app said about itself in its hello, and this agent's version.
         * @description Per app, not per request: the app's settings (masked by its SDK before they leave the app) and the versions of what it runs on, as its latest hello said them (`app`). Kept in the agent's memory after the app goes, so an app that restarts or stopped still shows; an agent started anew knows them again at each app's next hello. An app whose SDK doesn't send them (JavaScript and Java today) has nulls.
         */
        get: operations["app"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/store": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Delete every stored trace, log, query, email and issue.
         * @description A DELETE, so another site can't send it without a CORS preflight, which the console never allows.
         */
        delete: operations["clearStore"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/values": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Distinct routes, loggers, database aliases and extra= keys, for filter menus and hints. */
        get: operations["knownValues"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The search fields of every resource (the same data as schema/search.json). */
        get: operations["searchSpec"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Users to switch to (development only, from this machine). */
        get: operations["searchUsers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/users/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The user logged in to this browser session. */
        get: operations["currentUser"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/users/switch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Log this browser session in as another user, or out (development only, from this machine).
         * @description Needs the X-Tracepanel header and a same-origin request, so another site can't trigger it.
         */
        post: operations["switchUser"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        Error: {
            error: string;
        };
        /** @description Pass as `before` for the next page; null on the last one. */
        Cursor: number | null;
        /** @description Unix epoch microseconds (UTC). */
        Time: number;
        /** @description Microseconds. */
        Duration: number;
        /** @enum {string} */
        IssueKind: "n+1" | "duplicates" | "slow-sql" | "slow-http" | "slow-call" | "error" | "long-transaction" | "in-transaction" | "htmx" | "queue-wait" | "blocking-call" | "large-result";
        /** @description A trace without its document, as in lists. */
        TraceSummary: {
            id: string;
            /** @description The app that recorded it (its trace's service.name). */
            service: string;
            /** @enum {string} */
            kind: "http" | "task" | "command" | "websocket" | "rpc" | "page";
            name: string;
            start: components["schemas"]["Time"];
            duration: components["schemas"]["Duration"];
            /** @enum {string} */
            status: "ok" | "error";
            http_status: number | null;
            method: string | null;
            path: string | null;
            route: string | null;
            view: string | null;
            user_id: string | null;
            queries: number;
            db_time: components["schemas"]["Duration"];
            issues: number;
            errors: number;
            logs: number;
            mails: number;
            issue_kinds: components["schemas"]["IssueKind"][];
            db_aliases: string[];
            cache_aliases: string[];
            /**
             * @description How a Celery task run ended; null for requests and commands.
             * @enum {string|null}
             */
            task_state: "success" | "failure" | "retry" | null;
            /**
             * @description Sent by htmx (HX-Request); boosted when a boosted link or form loaded a whole page.
             * @enum {string|null}
             */
            htmx: "request" | "boosted" | null;
        };
        LogRow: {
            id: number;
            trace_id: string;
            time: components["schemas"]["Time"];
            /** @enum {string} */
            level: "debug" | "info" | "warning" | "error" | "critical";
            logger: string;
            message: string;
            exception: string | null;
            attrs: components["schemas"]["Attrs"];
            /** @description The span it was logged in; null outside every span. */
            span_id: string | null;
            /** @description The span it was logged in and the spans around it, innermost first, up to the trace's own (left out). */
            spans: {
                kind: string;
                /** @description The system a call is to (kafka, sql); a span's kind otherwise. */
                system: string;
                name: string;
            }[];
            /** @enum {string} */
            trace_kind: "http" | "task" | "command" | "websocket" | "rpc" | "page";
            /**
             * @description As the trace's htmx.
             * @enum {string|null}
             */
            trace_htmx: "request" | "boosted" | null;
            trace_name: string;
            method: string | null;
            path: string | null;
            http_status: number | null;
            user_id: string | null;
            /** @description The app that recorded it (its trace's service.name). */
            service: string;
        };
        /** @description Namespaced attributes; values are scalars or lists of scalars. */
        Attrs: {
            [key: string]: components["schemas"]["Scalar"] | components["schemas"]["Scalar"][];
        };
        Scalar: string | number | boolean | null;
        MailRow: {
            trace_id: string;
            span_id: string;
            time: components["schemas"]["Time"];
            subject: string;
            sender: string | null;
            /** @description To and cc. */
            recipients: string[];
            /** @description False when the backend refused it; null when unknown. */
            sent: boolean | null;
            html: boolean;
            /** @enum {string} */
            trace_kind: "http" | "task" | "command" | "websocket" | "rpc" | "page";
            /**
             * @description As the trace's htmx.
             * @enum {string|null}
             */
            trace_htmx: "request" | "boosted" | null;
            method: string | null;
            path: string | null;
            trace_name: string;
        };
        CallsSummary: {
            calls: number;
            /** @description Traces with any of the calls. */
            traces: number;
            /** @description The most calls in one trace; null with no calls. */
            most_per_trace: number | null;
            /** @description Calls that failed. */
            errors: number;
            total: components["schemas"]["Duration"];
            /** @description Null with no calls. */
            p95: components["schemas"]["Duration"] | null;
            /** @description A cache's gets that hit; null for other systems. */
            hits: number | null;
            /** @description A cache's gets that missed; null for other systems. */
            misses: number | null;
        };
        CallRow: {
            /** @description Call id (search traces with call:<key>; for SQL also query:<key>). */
            key: string;
            /** @description What the console lists it under: sql, redis, cache, http, a known datastore, broker or RPC kind (mongodb, kafka, grpc…), or the system's own name for any other (neo4j, nats, thrift). */
            system: string;
            /** @enum {string} */
            family: "sql" | "redis" | "cache" | "datastore" | "messaging" | "rpc" | "http";
            /** @description Where it went: a database alias, an instance, a host, a topic, an RPC service. */
            target: string;
            /** @description The operation: SELECT, GET, get, POST, find, publish, an RPC method. */
            op: string;
            /** @description What its repeats share: the SQL fingerprint, a key or path with ids as {id}, a collection. */
            template: string;
            /** @description The span's name. */
            name: string;
            calls: number;
            traces: number;
            /** @description Operations that failed. */
            errors: number;
            total: components["schemas"]["Duration"];
            slowest: components["schemas"]["Duration"];
            last_seen: components["schemas"]["Time"];
            /** @description The most in one trace. */
            most_per_trace: number;
            /** @description The most common line of code making it. */
            origin: string | null;
            /** @description The latest one's trace. */
            sample_trace: string;
            /** @description The latest one's span. */
            sample_span: string;
            /** @description The operation in full: the SQL statement, the command with its key, the URL. */
            statement: string | null;
            /** @description SQL: the database; a cache: its backend. */
            vendor: string | null;
            /** @description A cache: gets that found their key. */
            hits: number | null;
            /** @description A cache: gets that didn't. */
            misses: number | null;
            /** @description Redis: direct (the app's call), cache or task (sent for one). */
            via: string | null;
        };
        ExplainPlan: {
            vendor: string;
            alias: string;
            analyzed: boolean;
            lines: {
                depth: number;
                text: string;
                warning: string | null;
            }[];
        };
        EndpointRow: {
            method: string;
            route: string;
            calls: number;
            p50: components["schemas"]["Duration"];
            p95: components["schemas"]["Duration"];
            total: components["schemas"]["Duration"];
            avg_queries: number;
            with_issues: number;
            errors: number;
            last_seen: components["schemas"]["Time"];
            /** @description Distinct GraphQL operations served by this endpoint (0 for plain HTTP). */
            graphql_operations: number;
        };
        StatsSummary: {
            calls: number;
            errors: number;
            slow: number;
            p50: components["schemas"]["Duration"];
            p75: components["schemas"]["Duration"];
            p90: components["schemas"]["Duration"];
            p95: components["schemas"]["Duration"];
            p99: components["schemas"]["Duration"];
            max: components["schemas"]["Duration"];
            avg_queries: number;
            avg_db_time: components["schemas"]["Duration"];
            with_issues: number;
            first_seen: components["schemas"]["Time"];
            last_seen: components["schemas"]["Time"];
        };
        SeriesBucket: {
            start: components["schemas"]["Time"];
            end: components["schemas"]["Time"];
            calls: number;
            errors: number;
            slow: number;
            p50: number | null;
            p95: number | null;
        };
        LogBucket: {
            start: components["schemas"]["Time"];
            end: components["schemas"]["Time"];
            count: number;
            /** @description Records by level (debug, info, warning, error, critical); a level with none is left out. */
            levels: {
                [key: string]: number;
            };
        };
        HistogramBucket: {
            from: components["schemas"]["Duration"];
            to: components["schemas"]["Duration"];
            count: number;
        };
        GroupStats: {
            calls: number;
            errors: number;
            p95: components["schemas"]["Duration"];
            slow: number;
        };
        KindStats: components["schemas"]["GroupStats"] & {
            /** @enum {string} */
            kind: "http" | "task" | "command" | "websocket" | "rpc" | "page";
        };
        /** @description One operation: a trace kind plus name, e.g. http "GET /posts/<int:pk>/". */
        OperationStats: components["schemas"]["GroupStats"] & {
            /** @enum {string} */
            kind: "http" | "task" | "command" | "websocket" | "rpc" | "page";
            name: string;
            /** @description For requests. */
            method: string | null;
            /** @description For requests. */
            route: string | null;
            /** @description For WebSocket events: the consumer, which names their group. */
            view: string | null;
        };
        TracesOverview: {
            summary: components["schemas"]["StatsSummary"] | null;
            series: components["schemas"]["SeriesBucket"][];
            histogram: components["schemas"]["HistogramBucket"][];
            slow_threshold: components["schemas"]["Duration"];
            kinds: components["schemas"]["KindStats"][];
            /** @description Highest p95 first. */
            slowest: components["schemas"]["OperationStats"][];
            /** @description Most errors first. */
            failing: components["schemas"]["OperationStats"][];
        };
        IssueGroup: {
            fingerprint: string;
            fingerprint_version: number;
            kind: components["schemas"]["IssueKind"];
            title: string;
            culprit: string | null;
            hint: string | null;
            /** @description Every time it happened */
            occurrences: number;
            /** @description How many of its traces the store still holds: 0 when all rotated out. */
            stored?: number;
            first_seen: components["schemas"]["Time"];
            last_seen: components["schemas"]["Time"];
            last_trace_id: string;
        };
        IssueRow: components["schemas"]["IssueGroup"] & {
            /** @description "METHOD route" of the requests it happened in. */
            endpoints: string[];
        };
        IssueDetail: components["schemas"]["IssueGroup"] & {
            endpoints: string[];
            series: components["schemas"]["SeriesBucket"][];
            /** @description Newest first. */
            traces: components["schemas"]["TraceSummary"][];
        };
        EndpointIssue: components["schemas"]["IssueGroup"] & {
            /** @description Calls of this endpoint it happened in. */
            calls: number;
        };
        EndpointDetail: {
            method: string;
            route: string;
            summary: components["schemas"]["StatsSummary"];
            series: components["schemas"]["SeriesBucket"][];
            histogram: components["schemas"]["HistogramBucket"][];
            issues: components["schemas"]["EndpointIssue"][];
            slowest: components["schemas"]["TraceSummary"][];
            recent: components["schemas"]["TraceSummary"][];
        };
        Counts: {
            /** @description Tasks in flight or workers seen (api/tasks/live), or a connected app that sends task events: the console shows Tasks before any task's trace is stored. */
            live_tasks: boolean;
            /** @description Issue groups besides errors: N+1, duplicates, slow queries and calls, blocking calls, transactions, htmx. */
            issues: number;
            /** @description Error groups. */
            errors: number;
            /** @description Stored traces per entry point; the console hides entry points with none. */
            sections: {
                /** @description HTTP requests that are not GraphQL operations. */
                http: number;
                graphql: number;
                tasks: number;
                websockets: number;
                /** @description Management commands and tracepanel.trace() blocks. */
                jobs: number;
                /** @description RPC calls served: gRPC and other RPC systems' servers. */
                rpc: number;
                /** @description Pages viewed in a browser. */
                pages: number;
                /** @description Emails sent: the console hides Emails without any. */
                mails: number;
                /** @description The systems with operations, by family then name: the console lists a page for each. */
                systems: {
                    system: string;
                    /** @description Its name in the console: MongoDB, NATS, Google Pub/Sub, or the system's own. */
                    label: string;
                    /** @enum {string} */
                    family: "sql" | "redis" | "cache" | "datastore" | "messaging" | "rpc" | "http";
                }[];
            };
        };
        Capabilities: {
            /** @description An app sends task events (Celery, RQ, Dramatiq and Django Tasks, from the Python SDK): the Tasks page lists the tasks in flight (api/tasks/live). */
            live_tasks: boolean;
            /** @description The app runs EXPLAIN of a recorded query on its database (api/explain). */
            explain: boolean;
            /** @description The app profiles a request when asked (the tracepanel_profile cookie or the X-Tracepanel-Profile header): the console offers to record the next one with a profile. */
            profile: boolean;
            /** @description The app records what its requests carry (query, headers, body, cookies, session). */
            request: boolean;
            /** @description The app can switch the user this browser is logged in as (api/users, api/users/me, api/users/switch). */
            users: boolean;
        };
        App: {
            service: string;
            /** @description This agent's version. */
            agent: string;
            /** @description A process of the app is connected to the agent now. */
            connected: boolean;
            /** @description When the agent had the app's settings and versions (its latest hello that said them). */
            received: number | null;
            /** @description The app's settings by name (Django's settings, Flask's app.config), each value as the SDK wrote it: repr-ed and cut, a secret's value `********`, a URL's credentials `********`. Null when the SDK sends none. */
            settings: {
                [key: string]: string;
            } | null;
            /** @description What the app runs on: the runtime first, then its framework, then the packages that matter (database drivers, task queues, the SDK). Null when the SDK sends none. */
            versions: components["schemas"]["AppVersion"][] | null;
        };
        AppVersion: {
            /** @description As the runtime or the package names itself: "Python", "Django", "psycopg". */
            name: string;
            version: string;
            /** @enum {string} */
            kind?: "runtime" | "framework" | "package";
        };
        KnownValues: {
            /** @description Celery task names. */
            task: string[];
            /** @description What ran the tasks: celery, dramatiq, rq, django, spring, or a broker's listener (rabbitmq, kafka). */
            task_system: string[];
            /** @description Queues tasks ran from. */
            queue: string[];
            /** @description Job names: management commands and tracepanel.trace() blocks. */
            job: string[];
            /** @description RPC methods served, Service/Method. */
            rpc: string[];
            /** @description Paths of pages viewed in a browser. */
            page: string[];
            route: string[];
            /** @description Routes whose requests logged anything. */
            log_route: string[];
            logger: string[];
            /** @description Database aliases. */
            db: string[];
            /** @description Each system's targets (as /counts names the systems): {"mongodb": ["shop"]}. */
            targets: {
                [key: string]: string[];
            };
            /** @description Each system's operations (as /counts names the systems): {"mongodb": ["find", "insert"]}. */
            ops: {
                [key: string]: string[];
            };
            /** @description Kinds and systems of the spans records were logged inside. */
            in: string[];
            /** @description Names of the traces' spans (their roots left out). */
            span: string[];
            /** @description extra.* keys seen in logs. */
            extra: string[];
        };
        SearchField: {
            /** @enum {string} */
            type: "text" | "number" | "duration" | "level" | "has" | "time";
            help: string;
        };
        SearchSpec: {
            tasks: components["schemas"]["SearchFields"];
            services: components["schemas"]["SearchFields"];
            websockets: components["schemas"]["SearchFields"];
            graphql: components["schemas"]["SearchFields"];
            jobs: components["schemas"]["SearchFields"];
            rpc: components["schemas"]["SearchFields"];
            pages: components["schemas"]["SearchFields"];
            traces: components["schemas"]["SearchFields"];
            logs: components["schemas"]["SearchFields"];
            mails: components["schemas"]["SearchFields"];
            calls: components["schemas"]["SearchFields"];
            endpoints: components["schemas"]["SearchFields"];
            issues: components["schemas"]["SearchFields"];
        };
        /** @description Field name to its type and help; names ending in ".*" accept any key under that prefix. */
        SearchFields: {
            [key: string]: components["schemas"]["SearchField"];
        };
        User: {
            id: string;
            username: string;
            name: string | null;
            email: string | null;
            is_staff: boolean;
            is_superuser: boolean;
        };
        CurrentUser: {
            user: components["schemas"]["User"] | null;
        };
        TaskRow: {
            /** @description Dotted task name. */
            task: string;
            /** @description task.system: the queue that ran it (celery, django). */
            system: string;
            runs: number;
            failures: number;
            /** @description Runs that ended in a retry. */
            retries: number;
            p50: components["schemas"]["Duration"];
            p95: components["schemas"]["Duration"];
            total: components["schemas"]["Duration"];
            /** @description Time in the queue before a worker took it (microseconds). */
            wait_p50: number | null;
            wait_p95: number | null;
            avg_queries: number;
            with_issues: number;
            queues: string[];
            last_seen: components["schemas"]["Time"];
        };
        LiveTasks: {
            /** @description The agent's clock: how long a task has waited or run is now minus its time. */
            now: components["schemas"]["Time"];
            /** @description Newest first. */
            tasks: components["schemas"]["LiveTask"][];
            /** @description By name. */
            workers: components["schemas"]["LiveWorker"][];
        };
        LiveTask: {
            /** @description The task's id in its queue. */
            id: string;
            /** @description What runs it: celery (the task queues that send task events). */
            system: string;
            /** @description Dotted task name. */
            name: string;
            /** @description service.name of the app that last told of it. */
            service: string;
            /**
             * @description queued: sent, no worker took it yet; running; retrying: an attempt failed, the next one waits.
             * @enum {string}
             */
            state: "queued" | "running" | "retrying";
            queue: string | null;
            /** @description The worker that runs it or ran its last attempt (celery@host). */
            worker: string | null;
            /** @description When it was last sent to its queue (a retry sends it again). */
            enqueued_at: number | null;
            /** @description When its current or last attempt started. */
            started_at: number | null;
            /** @description How many times it was retried: the attempt is retries + 1. */
            retries: number;
            /** @description Its positional arguments as the SDK wrote them (cut short */
            args: string | null;
            kwargs: string | null;
            /** @description Why the last attempt failed (retrying). */
            error: string | null;
            /** @description The trace and span that sent it, when it was sent inside one. */
            enqueued_by: null | {
                trace_id: string;
                span_id: string;
            };
        };
        LiveWorker: {
            /** @description The worker's name (Celery's node name: celery@host). */
            name: string;
            system: string;
            service: string;
            last_seen: components["schemas"]["Time"];
            /** @description The tasks it runs now; one between two tasks while tasks of its queues wait. */
            in_flight: number;
        };
        GraphqlRow: {
            /** @description Type and name: query PostList; an unnamed operation by its root fields, query { posts }. */
            operation: string;
            /** @description query */
            type: string | null;
            /** @description operationName; null for an anonymous operation. */
            name: string | null;
            calls: number;
            /** @description Calls with an error (a resolver exception or a 5xx). */
            errors: number;
            p50: components["schemas"]["Duration"];
            p95: components["schemas"]["Duration"];
            total: components["schemas"]["Duration"];
            avg_queries: number;
            with_issues: number;
            last_seen: components["schemas"]["Time"];
        };
        TraceGroup: {
            /** @description The search that names the group. */
            query: string;
            summary: components["schemas"]["StatsSummary"];
            series: components["schemas"]["SeriesBucket"][];
            histogram: components["schemas"]["HistogramBucket"][];
            issues: components["schemas"]["EndpointIssue"][];
            slowest: components["schemas"]["TraceSummary"][];
            recent: components["schemas"]["TraceSummary"][];
        };
        JobRow: {
            /** @description manage.py migrate, or the name given to tracepanel.trace(). */
            job: string;
            /** @enum {string} */
            source: "manage.py" | "custom";
            runs: number;
            failures: number;
            p50: components["schemas"]["Duration"];
            p95: components["schemas"]["Duration"];
            total: components["schemas"]["Duration"];
            avg_queries: number;
            with_issues: number;
            last_seen: components["schemas"]["Time"];
        };
        RpcRow: {
            /** @description The method, Service/Method: helloworld.Greeter/SayHello. */
            rpc: string;
            /** @description grpc, or another RPC system's name. */
            system: string | null;
            calls: number;
            failures: number;
            p50: components["schemas"]["Duration"];
            p95: components["schemas"]["Duration"];
            total: components["schemas"]["Duration"];
            avg_queries: number;
            with_issues: number;
            last_seen: components["schemas"]["Time"];
        };
        /** @description A page's view (its load, an SPA's route change) or an action on it (what the user did that called the API: a click, a submit; background when nobody did). A page's view comes first, then its actions. */
        PageRow: {
            /** @description The traces' name, the group's key: /books, or /books › click "Save". */
            name: string;
            /** @description The page's path: /books/42. */
            page: string;
            /** @description What the user did: click "Save". None for a view. */
            action: string | null;
            /** @description load, navigation, click, submit or background. */
            trigger: string | null;
            /** @description Views, or times the action was done. */
            count: number;
            /** @description Views or actions with an error in the page or a failed call. */
            failures: number;
            p50: components["schemas"]["Duration"];
            p95: components["schemas"]["Duration"];
            total: components["schemas"]["Duration"];
            /** @description Requests to the API per view or action. */
            avg_calls: number;
            with_issues: number;
            last_seen: components["schemas"]["Time"];
        };
        GraphqlDetail: {
            operation: string;
            type: string | null;
            name: string | null;
            /** @description The latest query text (whitespace collapsed). */
            document: string | null;
            summary: components["schemas"]["StatsSummary"];
            series: components["schemas"]["SeriesBucket"][];
            histogram: components["schemas"]["HistogramBucket"][];
            /** @description The project's resolvers in this operation, most time first. */
            resolvers: components["schemas"]["ResolverStats"][];
            issues: components["schemas"]["EndpointIssue"][];
            slowest: components["schemas"]["TraceSummary"][];
            recent: components["schemas"]["TraceSummary"][];
        };
        ResolverStats: {
            /** @description Type.field, e.g. PostType.author. */
            field: string;
            /** @description How many times it resolves per operation call (N+1 shows here). */
            per_call: number;
            total: components["schemas"]["Duration"];
            p95: components["schemas"]["Duration"];
            /** @description SQL queries it runs per operation call. */
            queries_per_call: number;
        };
        WebsocketRow: {
            /** @description Dotted consumer class. */
            consumer: string;
            connections: number;
            /** @description Frames received from clients. */
            received: number;
            /** @description Channel layer messages handled (group_send and send). */
            delivered: number;
            disconnects: number;
            errors: number;
            p50: components["schemas"]["Duration"];
            p95: components["schemas"]["Duration"];
            total: components["schemas"]["Duration"];
            avg_queries: number;
            with_issues: number;
            /** @description Up to five paths seen. */
            paths: string[];
            last_seen: components["schemas"]["Time"];
        };
        /** @description The project's own web, workers and commands, each a service of its own. */
        ServiceApp: {
            /** @description service.name: the project (the TRACEPANEL service setting). */
            service: string;
            /** @description web, worker or command. */
            role: string;
            /** @description Requests */
            traces: number;
            /** @description How many of them failed. */
            errors: number;
            total: components["schemas"]["Duration"];
            last_seen: components["schemas"]["Time"];
            /** @description What runs it, as the SDKs label it: "Python 3.12 · Django 6.0", "Go 1.27". */
            runtime: string | null;
        };
        ServiceNode: {
            /** @description kind:system/address:port/namespace, e.g. database:postgresql/db:5432/blog. */
            id: string;
            /** @enum {string} */
            kind: "database" | "cache" | "mail" | "queue" | "http";
            /** @description postgresql, sqlite, redis, locmem, smtp, console, rabbitmq… */
            system: string;
            /** @description Host name */
            address: string | null;
            port: number | null;
            /** @description Database name, Redis database number, or the alias of an in-process cache. */
            namespace: string | null;
            /** @description Django aliases (DATABASES / CACHES) using it. */
            aliases: string[];
            /** @description Calls made to it (for a broker */
            calls: number;
            total: components["schemas"]["Duration"];
            errors: number;
            last_seen: components["schemas"]["Time"];
        };
        ServiceEdge: {
            service: string;
            role: string;
            /** @description ServiceNode id. */
            peer: string;
            /**
             * @description out: the app calls it; in: a worker takes tasks from this broker.
             * @enum {string}
             */
            direction: "out" | "in";
            traces: number;
            calls: number;
            /** @description Time spent in the calls (queue wait for in). */
            total: components["schemas"]["Duration"];
            errors: number;
        };
        /** @description One app's calls to another, linked by the W3C trace context the call carried (a trace's `called_by`): from a role of one to a role of the other. */
        AppLink: {
            /** @description The calling app. */
            service: string;
            role: string | null;
            /** @description The app it called. */
            to_service: string;
            to_role: string | null;
            /** @description The ServiceNode the caller saw it as (its HTTP host, its RPC service), if any. */
            peer: string | null;
            /** @description The called app's traces. */
            traces: number;
            /** @description Their time. */
            total: components["schemas"]["Duration"];
            /** @description How many of them failed. */
            errors: number;
        };
        Snapshot: {
            /** @description The snapshot's layout version. */
            format: number;
            /** @description The agent's version that made it. */
            agent: string;
            /** @description When it was made */
            created: number;
            /** @description Whether what stays local was kept. */
            values: boolean;
            /** @description The id of the trace it was made from. */
            root: string;
            /** @description The trace and those linked to it (at most 100), by id. */
            traces: {
                [key: string]: components["schemas"]["trace.schema"];
            };
            /** @description The links of each trace in `traces`, by id. */
            related: {
                [key: string]: components["schemas"]["Related"];
            };
        };
        Related: {
            /** @description The trace that enqueued this task. */
            enqueued_by: components["schemas"]["TraceSummary"] | null;
            /** @description Tasks this trace enqueued, oldest first. */
            enqueued: components["schemas"]["TraceSummary"][];
            /** @description The connect event of this WebSocket event's connection. */
            connection: components["schemas"]["TraceSummary"] | null;
            /** @description For a connect event, the later events of the connection, oldest first (up to 100). */
            connection_events: components["schemas"]["TraceSummary"][];
            /** @description The trace whose channel layer message this event handles. */
            sent_by: components["schemas"]["TraceSummary"] | null;
            /** @description Events that handled the channel layer messages this trace sent, oldest first. */
            delivered: components["schemas"]["TraceSummary"][];
            /** @description The trace, in another app, whose call this trace served (by the W3C trace context it carried). */
            called_by: components["schemas"]["TraceSummary"] | null;
            /** @description The traces other apps served for this trace's calls, oldest first. */
            calls: components["schemas"]["TraceSummary"][];
            /** @description The traces another project's agent on this machine has for this trace's calls no trace here answered, asked by the W3C ids they carried: each with the call's span here, and that project's console. */
            remote_calls?: {
                /** @description The call's span in this trace. */
                span_id: string;
                trace: components["schemas"]["TraceSummary"];
                /** @description The other project's console, http://127.0.0.1:PORT/. */
                console: string;
                /** @description The other project's folder name. */
                project: string;
            }[];
            /** @description The whole traces of calls and remote_calls (up to 20 of calls), by trace id: the call tree opens each under its call. */
            call_traces?: {
                [key: string]: components["schemas"]["trace.schema"];
            };
            /** @description For the traces in enqueued, connection_events, delivered and calls: the span of this trace each came from (the task.enqueue, channel.send or outgoing call span), by trace id. The call tree shows a task under the span that enqueued it, and a call's trace under the call. */
            via: {
                [key: string]: string;
            };
            /** @description For a task run in a workflow (it has task.parent_id, task.root_id, task.group_id, task.depends_on or task.callback, or another run names its task.id): the runs around it. Absent otherwise. */
            workflow?: components["schemas"]["Workflow"];
        };
        /** @description A task run's workflow, by the task ids its runs record. A step sent from inside the run before it is linked already (enqueued_by and enqueued): it is not listed here again. */
        Workflow: {
            /** @description This run's task.id (a callback has none). */
            task_id: string | null;
            /** @description The latest stored run of each task this run names (task.parent_id, task.depends_on, task.root_id): its trace id, by task id. A task missing here has no run stored. */
            runs: {
                [key: string]: string;
            };
            /** @description The run of the workflow's first task (task.root_id), unless it is this run or listed already. */
            root: components["schemas"]["TraceSummary"] | null;
            /** @description The runs of the tasks this one follows (task.parent_id, task.depends_on), oldest first. */
            follows: components["schemas"]["TraceSummary"][];
            /** @description The runs that follow this one (its task.id is their parent or in their depends_on), oldest first. */
            followed_by: components["schemas"]["TraceSummary"][];
            /** @description The group it runs in (task.group_id). */
            group: null | {
                /** @description The group's id: `group:<id>` finds its tasks' runs. */
                id: string;
                /** @description How many tasks it has. */
                tasks: number;
                /** @description Whether this run is one of them: a run that follows one of them, as a chord's callback does, is not. */
                member: boolean;
                /** @description The latest run of each other task, in the order they first ran (at most 20). */
                runs: components["schemas"]["TraceSummary"][];
            };
            /** @description Which of the runs it led to (enqueued, followed_by) are its callbacks: RQ's on_success, on_failure or on_stopped, by trace id. */
            callbacks: {
                [key: string]: string;
            };
            /** @description The whole workflow it belongs to, as the console draws it: null for a workflow of one task. */
            graph: null | components["schemas"]["WorkflowGraph"];
        };
        /** @description A workflow's runs and how they lead to each other, found from one of them: the tasks it follows and those that follow it, its root and the tasks rooted there, its group, and so on from each. */
        WorkflowGraph: {
            /** @description The traces that started it (a request, a command), then one node per task in the order the tasks first ran: its latest run (a retried task is its last attempt). A callback, which has no task id, is a node of its own. */
            nodes: {
                trace: components["schemas"]["TraceSummary"];
                /** @description Its task.id; null for a callback or a request. */
                task_id: string | null;
                /** @description The group it is one of (task.group_id); not for a run that follows one of them. */
                group: string | null;
                /** @description on_success, on_failure or on_stopped (RQ). */
                callback: string | null;
                /** @description How many runs of its task are stored: more than 1 when it retried. */
                runs: number;
            }[];
            /** @description Which node leads to which, by trace id. */
            edges: {
                from: string;
                to: string;
                /**
                 * @description follows: it follows that task (task.parent_id, task.depends_on); callback: it is that run's callback; sent: that run sent it and it names no parent; enqueued: a trace outside the workflow (a request) enqueued it.
                 * @enum {string}
                 */
                kind: "follows" | "callback" | "sent" | "enqueued";
            }[];
            /** @description True when the workflow has more runs than the graph takes in (100). */
            cut: boolean;
        };
        /** @description ULID. */
        id: string;
        /** @description Unix epoch microseconds, UTC. */
        time: number;
        /** @description Microseconds. */
        duration: number;
        /** @enum {unknown} */
        status: "ok" | "error";
        /** @description Namespaced attributes (http.*, db.*, cache.*, code.*, user.*, task.*, signal.*, exception.*). task.* is shared by every task queue (task.system says which: celery, django, dramatiq, rq). Values are scalars or lists of scalars. */
        attrs: {
            /** @description On a signal span and on each of its receivers' spans: the signal's dotted path, e.g. "django.db.models.signals.post_save". The signal span's name is Django's own signal by its name ("post_save"), any other by this path. */
            "signal.name"?: string;
            /** @description On a signal span: who sent it, a model by its label ("auth.Group"), any other class by its dotted path. Absent for a send with no sender. */
            "signal.sender"?: string;
            /** @description On a signal span: the dotted path of each receiver it ran, in order. Each receiver is a function span under it. */
            "signal.receivers"?: string[];
            /** @description On a signal span: true for send_robust() and asend_robust(), which catch what a receiver raises. A failed receiver's span is then an error while the trace stays ok. */
            "signal.robust"?: boolean;
            /** @description On a trace: the sends nobody received, which make no span, once per signal and sender with how many times it was sent, e.g. "pre_save auth.Group: 3". */
            "signal.unreceived"?: string[];
            /** @description On a span that raised (a signal's receiver): the qualified exception class, e.g. "builtins.ConnectionError". */
            "exception.type"?: string;
            /** @description On a span that raised: the exception's message, cut at 1000 characters. */
            "exception.message"?: string;
        } & {
            [key: string]: (string | number | boolean | null) | (string | number | boolean | null)[];
        };
        frame: {
            /** @description Relative to the project root for application code. */
            filename: string;
            module: string;
            function: string;
            lineno: number;
            /** @description True for project code, false for the standard library and installed packages. */
            in_app: boolean;
            /** @description Line number of the first line in `context`. */
            context_start: number | null;
            /** @description Source lines around `lineno`. */
            context: string[];
            /** @description repr() of local variables, project frames only; sensitive names are masked. */
            locals: {
                [key: string]: string;
            } | null;
        };
        chained_error: {
            /**
             * @description cause: raise ... from; context: raised while handling.
             * @enum {unknown}
             */
            relation: "cause" | "context";
            type: string;
            message: string;
            frames: components["schemas"]["trace.schema"]["$defs"]["frame"][];
        };
        span: {
            id: components["schemas"]["trace.schema"]["$defs"]["id"];
            parent_id: components["schemas"]["trace.schema"]["$defs"]["id"] | null;
            /**
             * @description otel is an OpenTelemetry span as its instrumentation recorded it, with otel.span_kind and otel.scope among its attributes: the agent maps it to one of the other kinds before it stores the trace, so the console never returns one.
             * @enum {unknown}
             */
            kind: "http" | "middleware" | "framework" | "view" | "template" | "sql" | "transaction" | "cache" | "redis" | "mail" | "signal" | "http.client" | "task.enqueue" | "task.run" | "command" | "function" | "event" | "websocket" | "websocket.send" | "channel.send" | "graphql" | "mongodb" | "elasticsearch" | "cassandra" | "dynamodb" | "memcached" | "kafka" | "rabbitmq" | "sqs" | "grpc" | "db" | "messaging" | "rpc" | "otel" | "page";
            name: string;
            start: components["schemas"]["trace.schema"]["$defs"]["time"];
            duration: components["schemas"]["trace.schema"]["$defs"]["duration"];
            status: components["schemas"]["trace.schema"]["$defs"]["status"];
            attrs: components["schemas"]["trace.schema"]["$defs"]["attrs"];
        };
        log: {
            span_id: components["schemas"]["trace.schema"]["$defs"]["id"] | null;
            time: components["schemas"]["trace.schema"]["$defs"]["time"];
            /** @enum {unknown} */
            level: "debug" | "info" | "warning" | "error" | "critical";
            logger: string;
            message: string;
            /** @description Formatted traceback when the record carries exc_info. */
            exception: string | null;
            /** @description Where it was logged (code.*), thread.*, process.*, log.template, and the record's extra fields as extra.*. */
            attrs: components["schemas"]["trace.schema"]["$defs"]["attrs"];
        };
        error: {
            span_id: components["schemas"]["trace.schema"]["$defs"]["id"] | null;
            time: components["schemas"]["trace.schema"]["$defs"]["time"];
            /** @description Qualified exception class, e.g. "builtins.ZeroDivisionError". */
            type: string;
            message: string;
            handled: boolean;
            /** @description Oldest call first. */
            frames: components["schemas"]["trace.schema"]["$defs"]["frame"][];
            /** @description Inner exceptions, nearest first. */
            chain: components["schemas"]["trace.schema"]["$defs"]["chained_error"][];
        };
        link: {
            /**
             * @description enqueued_by: this task trace was enqueued from trace_id/span_id. connection: this WebSocket event belongs to the connection opened in trace_id. sent_by: this event handles a channel layer message sent from trace_id/span_id.
             * @enum {unknown}
             */
            kind: "enqueued_by" | "connection" | "sent_by";
            trace_id: components["schemas"]["trace.schema"]["$defs"]["id"];
            span_id: components["schemas"]["trace.schema"]["$defs"]["id"];
        };
        issue: {
            /** @description Stable group key: the same problem in the same place has the same fingerprint, whichever SDK recorded it. */
            fingerprint: string;
            fingerprint_version: number;
            /** @enum {unknown} */
            kind: "n+1" | "duplicates" | "slow-sql" | "slow-http" | "slow-call" | "error" | "long-transaction" | "in-transaction" | "htmx" | "queue-wait" | "blocking-call" | "large-result";
            title: string;
            /** @description Where in the project code it happens, e.g. "blog/views.py:21 in post_list". */
            culprit: string | null;
            hint: string | null;
            /** @description Occurrences within this trace. */
            count: number;
            span_ids: components["schemas"]["trace.schema"]["$defs"]["id"][];
        };
        call: {
            /** @description The span the call is. */
            span_id: components["schemas"]["trace.schema"]["$defs"]["id"];
            /** @description What groups its repeats: 16 hex, the console's op: and query: key. */
            key: string;
            /** @description What it is listed under: sql, redis, cache, http, mongodb, kafka, grpc, or a system's own name. */
            system: string;
            /** @description The rules its issues follow: sql, redis, cache, http, rpc, datastore, messaging. */
            family: string;
            /** @description Where it went: a database alias, an instance, a host, a topic, an RPC service. */
            target: string;
            /** @description The verb: SELECT, GET, find, publish, the RPC method. */
            op: string;
            /** @description What its repeats share: a SQL fingerprint, a key or path with its ids as {id}. */
            template: string;
            /** @description SQL: the database vendor; a cache: its backend. */
            vendor: string | null;
            /** @description Redis: what sent the command (direct, cache, task). */
            via: string | null;
            /** @description A cache get: whether it found the key. */
            hit: boolean | null;
        };
        profile: {
            /** @description How often a sample was taken, in microseconds: a sample stands for this much time. */
            interval_us: number;
            /** @description Samples taken while the trace ran. */
            samples: number;
            /** @description The functions the stacks name, each once. */
            frames: {
                function: string;
                module?: string | null;
                /** @description As the project sees it: relative to its root for its own code. */
                file: string;
                /** @description Where the function is defined. */
                line: number;
                /** @description The project's own code, not a library's or the runtime's. */
                in_app: boolean;
            }[];
            /** @description Each stack seen, outermost frame first, as indexes into frames, and how many samples saw it. */
            stacks: {
                frames: number[];
                count: number;
            }[];
        };
        /**
         * Trace
         * @description One unit of work: an HTTP request, a background task or a management command, with its spans, logs, errors and detected issues. Times are Unix epoch microseconds (UTC); durations are microseconds.
         */
        "trace.schema": {
            id: components["schemas"]["trace.schema"]["$defs"]["id"];
            /** @enum {unknown} */
            kind: "http" | "task" | "command" | "websocket" | "rpc" | "page";
            /** @description Human-readable name, e.g. "GET /posts/<int:pk>/". */
            name: string;
            start: components["schemas"]["trace.schema"]["$defs"]["time"];
            duration: components["schemas"]["trace.schema"]["$defs"]["duration"];
            status: components["schemas"]["trace.schema"]["$defs"]["status"];
            attrs: components["schemas"]["trace.schema"]["$defs"]["attrs"];
            spans: components["schemas"]["trace.schema"]["$defs"]["span"][];
            logs: components["schemas"]["trace.schema"]["$defs"]["log"][];
            errors: components["schemas"]["trace.schema"]["$defs"]["error"][];
            links: components["schemas"]["trace.schema"]["$defs"]["link"][];
            /** @description Found by the agent: SDKs send an empty list, the console's API returns the trace with its issues. */
            issues: components["schemas"]["trace.schema"]["$defs"]["issue"][];
            /** @description When the agent received it, by its machine's clock: set by the agent, never sent. Against start and duration (the app's clock) it tells a clock that is off. */
            received?: components["schemas"]["trace.schema"]["$defs"]["time"];
            /** @description Its spans that are calls to another system, as the agent's analysis reads them: set by the agent on a trace it sends on, never by an SDK. The rest of each call is its span's. */
            calls?: components["schemas"]["trace.schema"]["$defs"]["call"][];
            /** @description Where the trace's time went in code, sampled: what was running every interval_us while it ran, as stacks of frames. Recorded when asked for (a setting, or a request's X-Tracepanel-Profile header); left out otherwise. */
            profile?: components["schemas"]["trace.schema"]["$defs"]["profile"];
            $defs: {
                profile: {
                    /** @description How often a sample was taken, in microseconds: a sample stands for this much time. */
                    interval_us: number;
                    /** @description Samples taken while the trace ran. */
                    samples: number;
                    /** @description The functions the stacks name, each once. */
                    frames: {
                        function: string;
                        module?: string | null;
                        /** @description As the project sees it: relative to its root for its own code. */
                        file: string;
                        /** @description Where the function is defined. */
                        line: number;
                        /** @description The project's own code, not a library's or the runtime's. */
                        in_app: boolean;
                    }[];
                    /** @description Each stack seen, outermost frame first, as indexes into frames, and how many samples saw it. */
                    stacks: {
                        frames: number[];
                        count: number;
                    }[];
                };
                call: {
                    /** @description The span the call is. */
                    span_id: components["schemas"]["trace.schema"]["$defs"]["id"];
                    /** @description What groups its repeats: 16 hex, the console's op: and query: key. */
                    key: string;
                    /** @description What it is listed under: sql, redis, cache, http, mongodb, kafka, grpc, or a system's own name. */
                    system: string;
                    /** @description The rules its issues follow: sql, redis, cache, http, rpc, datastore, messaging. */
                    family: string;
                    /** @description Where it went: a database alias, an instance, a host, a topic, an RPC service. */
                    target: string;
                    /** @description The verb: SELECT, GET, find, publish, the RPC method. */
                    op: string;
                    /** @description What its repeats share: a SQL fingerprint, a key or path with its ids as {id}. */
                    template: string;
                    /** @description SQL: the database vendor; a cache: its backend. */
                    vendor: string | null;
                    /** @description Redis: what sent the command (direct, cache, task). */
                    via: string | null;
                    /** @description A cache get: whether it found the key. */
                    hit: boolean | null;
                };
                /** @description ULID. */
                id: string;
                /** @description Unix epoch microseconds, UTC. */
                time: number;
                /** @description Microseconds. */
                duration: number;
                /** @enum {unknown} */
                status: "ok" | "error";
                /** @description Namespaced attributes (http.*, db.*, cache.*, code.*, user.*, task.*, signal.*, exception.*). task.* is shared by every task queue (task.system says which: celery, django, dramatiq, rq). Values are scalars or lists of scalars. */
                attrs: {
                    /** @description On a signal span and on each of its receivers' spans: the signal's dotted path, e.g. "django.db.models.signals.post_save". The signal span's name is Django's own signal by its name ("post_save"), any other by this path. */
                    "signal.name"?: string;
                    /** @description On a signal span: who sent it, a model by its label ("auth.Group"), any other class by its dotted path. Absent for a send with no sender. */
                    "signal.sender"?: string;
                    /** @description On a signal span: the dotted path of each receiver it ran, in order. Each receiver is a function span under it. */
                    "signal.receivers"?: string[];
                    /** @description On a signal span: true for send_robust() and asend_robust(), which catch what a receiver raises. A failed receiver's span is then an error while the trace stays ok. */
                    "signal.robust"?: boolean;
                    /** @description On a trace: the sends nobody received, which make no span, once per signal and sender with how many times it was sent, e.g. "pre_save auth.Group: 3". */
                    "signal.unreceived"?: string[];
                    /** @description On a span that raised (a signal's receiver): the qualified exception class, e.g. "builtins.ConnectionError". */
                    "exception.type"?: string;
                    /** @description On a span that raised: the exception's message, cut at 1000 characters. */
                    "exception.message"?: string;
                } & {
                    [key: string]: (string | number | boolean | null) | (string | number | boolean | null)[];
                };
                span: {
                    id: components["schemas"]["trace.schema"]["$defs"]["id"];
                    parent_id: components["schemas"]["trace.schema"]["$defs"]["id"] | null;
                    /**
                     * @description otel is an OpenTelemetry span as its instrumentation recorded it, with otel.span_kind and otel.scope among its attributes: the agent maps it to one of the other kinds before it stores the trace, so the console never returns one.
                     * @enum {unknown}
                     */
                    kind: "http" | "middleware" | "framework" | "view" | "template" | "sql" | "transaction" | "cache" | "redis" | "mail" | "signal" | "http.client" | "task.enqueue" | "task.run" | "command" | "function" | "event" | "websocket" | "websocket.send" | "channel.send" | "graphql" | "mongodb" | "elasticsearch" | "cassandra" | "dynamodb" | "memcached" | "kafka" | "rabbitmq" | "sqs" | "grpc" | "db" | "messaging" | "rpc" | "otel" | "page";
                    name: string;
                    start: components["schemas"]["trace.schema"]["$defs"]["time"];
                    duration: components["schemas"]["trace.schema"]["$defs"]["duration"];
                    status: components["schemas"]["trace.schema"]["$defs"]["status"];
                    attrs: components["schemas"]["trace.schema"]["$defs"]["attrs"];
                };
                log: {
                    span_id: components["schemas"]["trace.schema"]["$defs"]["id"] | null;
                    time: components["schemas"]["trace.schema"]["$defs"]["time"];
                    /** @enum {unknown} */
                    level: "debug" | "info" | "warning" | "error" | "critical";
                    logger: string;
                    message: string;
                    /** @description Formatted traceback when the record carries exc_info. */
                    exception: string | null;
                    /** @description Where it was logged (code.*), thread.*, process.*, log.template, and the record's extra fields as extra.*. */
                    attrs: components["schemas"]["trace.schema"]["$defs"]["attrs"];
                };
                frame: {
                    /** @description Relative to the project root for application code. */
                    filename: string;
                    module: string;
                    function: string;
                    lineno: number;
                    /** @description True for project code, false for the standard library and installed packages. */
                    in_app: boolean;
                    /** @description Line number of the first line in `context`. */
                    context_start: number | null;
                    /** @description Source lines around `lineno`. */
                    context: string[];
                    /** @description repr() of local variables, project frames only; sensitive names are masked. */
                    locals: {
                        [key: string]: string;
                    } | null;
                };
                error: {
                    span_id: components["schemas"]["trace.schema"]["$defs"]["id"] | null;
                    time: components["schemas"]["trace.schema"]["$defs"]["time"];
                    /** @description Qualified exception class, e.g. "builtins.ZeroDivisionError". */
                    type: string;
                    message: string;
                    handled: boolean;
                    /** @description Oldest call first. */
                    frames: components["schemas"]["trace.schema"]["$defs"]["frame"][];
                    /** @description Inner exceptions, nearest first. */
                    chain: components["schemas"]["trace.schema"]["$defs"]["chained_error"][];
                };
                link: {
                    /**
                     * @description enqueued_by: this task trace was enqueued from trace_id/span_id. connection: this WebSocket event belongs to the connection opened in trace_id. sent_by: this event handles a channel layer message sent from trace_id/span_id.
                     * @enum {unknown}
                     */
                    kind: "enqueued_by" | "connection" | "sent_by";
                    trace_id: components["schemas"]["trace.schema"]["$defs"]["id"];
                    span_id: components["schemas"]["trace.schema"]["$defs"]["id"];
                };
                issue: {
                    /** @description Stable group key: the same problem in the same place has the same fingerprint, whichever SDK recorded it. */
                    fingerprint: string;
                    fingerprint_version: number;
                    /** @enum {unknown} */
                    kind: "n+1" | "duplicates" | "slow-sql" | "slow-http" | "slow-call" | "error" | "long-transaction" | "in-transaction" | "htmx" | "queue-wait" | "blocking-call" | "large-result";
                    title: string;
                    /** @description Where in the project code it happens, e.g. "blog/views.py:21 in post_list". */
                    culprit: string | null;
                    hint: string | null;
                    /** @description Occurrences within this trace. */
                    count: number;
                    span_ids: components["schemas"]["trace.schema"]["$defs"]["id"][];
                };
                chained_error: {
                    /**
                     * @description cause: raise ... from; context: raised while handling.
                     * @enum {unknown}
                     */
                    relation: "cause" | "context";
                    type: string;
                    message: string;
                    frames: components["schemas"]["trace.schema"]["$defs"]["frame"][];
                };
            };
        };
    };
    responses: {
        /** @description Nothing with that id. */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description User switching is only for requests from this machine (or INTERNAL_IPS) and from the page itself. */
        NotLocal: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description The search can't be run; `error` explains it to the user. */
        BadSearch: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
    };
    parameters: {
        /** @description Only what this app (service.name) recorded; every app when left out. */
        service: string;
        /** @description Search query: free text plus key:value filters, e.g. route:/api/* status>=500 "timed out". */
        q: string;
        limit: number;
        /** @description The `next` cursor of the previous page. */
        before: number;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    searchTraces: {
        parameters: {
            query?: {
                /** @description Search query: free text plus key:value filters, e.g. route:/api/* status>=500 "timed out". */
                q?: components["parameters"]["q"];
                limit?: components["parameters"]["limit"];
                /** @description The `next` cursor of the previous page. */
                before?: components["parameters"]["before"];
                /** @description Comma-separated trace ids; returns just those (the widget's tab history). */
                ids?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of traces. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        traces: components["schemas"]["TraceSummary"][];
                        next: components["schemas"]["Cursor"];
                    };
                };
            };
            400: components["responses"]["BadSearch"];
        };
    };
    getTrace: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The trace document. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["trace.schema"];
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    relatedTraces: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Linked traces; empty when there are none (or the trace is unknown). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Related"];
                };
            };
        };
    };
    traceSnapshot: {
        parameters: {
            query?: {
                /** @description `1` keeps what otherwise stays on this machine: query parameters, mail bodies, a user's name and email, a log record's own fields and the local variables of errors. */
                values?: "0" | "1";
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The snapshot's data. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Snapshot"];
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    tracesOverview: {
        parameters: {
            query?: {
                /** @description Search query: free text plus key:value filters, e.g. route:/api/* status>=500 "timed out". */
                q?: components["parameters"]["q"];
                /** @description How the slowest and failing lists group traces: `operation` (kind + name: a GraphQL operation, a task) or `endpoint` (an HTTP request by method + route, so all GraphQL operations are one `POST /graphql/`). */
                group?: "operation" | "endpoint";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Summary, time series and worst endpoints. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TracesOverview"];
                };
            };
            400: components["responses"]["BadSearch"];
        };
    };
    searchLogs: {
        parameters: {
            query?: {
                /** @description Search query: free text plus key:value filters, e.g. route:/api/* status>=500 "timed out". */
                q?: components["parameters"]["q"];
                limit?: components["parameters"]["limit"];
                /** @description The `next` cursor of the previous page. */
                before?: components["parameters"]["before"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of log records. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        logs: components["schemas"]["LogRow"][];
                        next: components["schemas"]["Cursor"];
                    };
                };
            };
            400: components["responses"]["BadSearch"];
        };
    };
    logSeries: {
        parameters: {
            query?: {
                /** @description Search query: free text plus key:value filters, e.g. route:/api/* status>=500 "timed out". */
                q?: components["parameters"]["q"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The series. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        series: components["schemas"]["LogBucket"][];
                    };
                };
            };
            400: components["responses"]["BadSearch"];
        };
    };
    searchMails: {
        parameters: {
            query?: {
                /** @description Search query: free text plus key:value filters, e.g. route:/api/* status>=500 "timed out". */
                q?: components["parameters"]["q"];
                limit?: components["parameters"]["limit"];
                /** @description The `next` cursor of the previous page. */
                before?: components["parameters"]["before"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of emails. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        mails: components["schemas"]["MailRow"][];
                        next: components["schemas"]["Cursor"];
                    };
                };
            };
            400: components["responses"]["BadSearch"];
        };
    };
    listCalls: {
        parameters: {
            query?: {
                /** @description Search query: free text plus key:value filters, e.g. route:/api/* status>=500 "timed out". */
                q?: components["parameters"]["q"];
                limit?: components["parameters"]["limit"];
                /** @description One system, as /counts lists them: sql, redis, cache, http, mongodb, kafka, grpc, neo4j… */
                system?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Calls. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        calls: components["schemas"]["CallRow"][];
                    };
                };
            };
            400: components["responses"]["BadSearch"];
        };
    };
    callsSummary: {
        parameters: {
            query?: {
                /** @description Search query: free text plus key:value filters, e.g. route:/api/* status>=500 "timed out". */
                q?: components["parameters"]["q"];
                /** @description One system, as /counts lists them. */
                system?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The totals. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CallsSummary"];
                };
            };
            400: components["responses"]["BadSearch"];
        };
    };
    explain: {
        parameters: {
            query: {
                trace: string;
                span: string;
                /** @description 1 runs the query to measure it (PostgreSQL, MySQL). */
                analyze?: "1";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The query plan. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExplainPlan"];
                };
            };
            404: components["responses"]["NotFound"];
            /** @description The query can't be explained (not a SELECT, no captured parameters, database error). */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listTasks: {
        parameters: {
            query?: {
                /** @description Search query: free text plus key:value filters, e.g. route:/api/* status>=500 "timed out". */
                q?: components["parameters"]["q"];
                limit?: components["parameters"]["limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Tasks. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        tasks: components["schemas"]["TaskRow"][];
                    };
                };
            };
            400: components["responses"]["BadSearch"];
        };
    };
    liveTasks: {
        parameters: {
            query?: {
                /** @description Only what this app (service.name) recorded; every app when left out. */
                service?: components["parameters"]["service"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Tasks in flight and workers. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LiveTasks"];
                };
            };
        };
    };
    listGraphqlOperations: {
        parameters: {
            query?: {
                /** @description Search query: free text plus key:value filters, e.g. route:/api/* status>=500 "timed out". */
                q?: components["parameters"]["q"];
                limit?: components["parameters"]["limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Operations. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        graphql: components["schemas"]["GraphqlRow"][];
                    };
                };
            };
            400: components["responses"]["BadSearch"];
        };
    };
    summarizeTraces: {
        parameters: {
            query?: {
                /** @description Search query: free text plus key:value filters, e.g. route:/api/* status>=500 "timed out". */
                q?: components["parameters"]["q"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The group. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TraceGroup"];
                };
            };
            400: components["responses"]["BadSearch"];
            404: components["responses"]["NotFound"];
        };
    };
    listJobs: {
        parameters: {
            query?: {
                /** @description Search query: free text plus key:value filters, e.g. route:/api/* status>=500 "timed out". */
                q?: components["parameters"]["q"];
                limit?: components["parameters"]["limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Jobs. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        jobs: components["schemas"]["JobRow"][];
                    };
                };
            };
            400: components["responses"]["BadSearch"];
        };
    };
    listRpcs: {
        parameters: {
            query?: {
                /** @description Search query: free text plus key:value filters, e.g. route:/api/* status>=500 "timed out". */
                q?: components["parameters"]["q"];
                limit?: components["parameters"]["limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Methods. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        rpc: components["schemas"]["RpcRow"][];
                    };
                };
            };
            400: components["responses"]["BadSearch"];
        };
    };
    listPages: {
        parameters: {
            query?: {
                /** @description Search query: free text plus key:value filters, e.g. route:/api/* status>=500 "timed out". */
                q?: components["parameters"]["q"];
                limit?: components["parameters"]["limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Pages. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        pages: components["schemas"]["PageRow"][];
                    };
                };
            };
            400: components["responses"]["BadSearch"];
        };
    };
    ingestTraces: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": Record<string, never>[];
            };
        };
        responses: {
            /** @description Taken; the agent stores them as an SDK's. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        taken: number;
                    };
                };
            };
            /** @description Not a JSON array of traces. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Not application/json. */
            415: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getGraphqlOperation: {
        parameters: {
            query: {
                /** @description query PostList */
                operation: string;
                /** @description Only what this app (service.name) recorded; every app when left out. */
                service?: components["parameters"]["service"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The operation. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GraphqlDetail"];
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    listWebsockets: {
        parameters: {
            query?: {
                /** @description Search query: free text plus key:value filters, e.g. route:/api/* status>=500 "timed out". */
                q?: components["parameters"]["q"];
                limit?: components["parameters"]["limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Consumers. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        websockets: components["schemas"]["WebsocketRow"][];
                    };
                };
            };
            400: components["responses"]["BadSearch"];
        };
    };
    listServices: {
        parameters: {
            query?: {
                /** @description Search query: free text plus key:value filters, e.g. route:/api/* status>=500 "timed out". */
                q?: components["parameters"]["q"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Service map. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        apps: components["schemas"]["ServiceApp"][];
                        /** @description One app calling another, most traces first. */
                        links: components["schemas"]["AppLink"][];
                        /** @description By kind, then by total time. */
                        services: components["schemas"]["ServiceNode"][];
                        /** @description Most time first. */
                        edges: components["schemas"]["ServiceEdge"][];
                    };
                };
            };
            400: components["responses"]["BadSearch"];
        };
    };
    listEndpoints: {
        parameters: {
            query?: {
                /** @description Search query: free text plus key:value filters, e.g. route:/api/* status>=500 "timed out". */
                q?: components["parameters"]["q"];
                limit?: components["parameters"]["limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Endpoints. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        endpoints: components["schemas"]["EndpointRow"][];
                    };
                };
            };
            400: components["responses"]["BadSearch"];
        };
    };
    getEndpoint: {
        parameters: {
            query: {
                method: string;
                route: string;
                /** @description Only what this app (service.name) recorded; every app when left out. */
                service?: components["parameters"]["service"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The endpoint. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EndpointDetail"];
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    listIssues: {
        parameters: {
            query?: {
                /** @description Search query: free text plus key:value filters, e.g. route:/api/* status>=500 "timed out". */
                q?: components["parameters"]["q"];
                limit?: components["parameters"]["limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Issues. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        issues: components["schemas"]["IssueRow"][];
                    };
                };
            };
            400: components["responses"]["BadSearch"];
        };
    };
    getIssue: {
        parameters: {
            query: {
                fingerprint: string;
                /** @description Search query: free text plus key:value filters, e.g. route:/api/* status>=500 "timed out". */
                q?: components["parameters"]["q"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The issue. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IssueDetail"];
                };
            };
            400: components["responses"]["BadSearch"];
            404: components["responses"]["NotFound"];
        };
    };
    counts: {
        parameters: {
            query?: {
                /** @description Only what this app (service.name) recorded; every app when left out. */
                service?: components["parameters"]["service"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Counts. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Counts"];
                };
            };
        };
    };
    capabilities: {
        parameters: {
            query?: never;
            header?: {
                /** @description The service of the app whose console forwarded the request. */
                "Tracepanel-Console"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Capabilities. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Capabilities"];
                };
            };
        };
    };
    app: {
        parameters: {
            query: {
                /** @description The app (service.name). */
                service: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The app's account of itself. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["App"];
                };
            };
        };
    };
    clearStore: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deleted. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description How many traces were deleted. */
                        deleted: number;
                    };
                };
            };
        };
    };
    knownValues: {
        parameters: {
            query?: {
                /** @description Only what this app (service.name) recorded; every app when left out. */
                service?: components["parameters"]["service"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Known values. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["KnownValues"];
                };
            };
        };
    };
    searchSpec: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Fields per resource. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SearchSpec"];
                };
            };
        };
    };
    searchUsers: {
        parameters: {
            query?: {
                /** @description Part of the username. */
                q?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Up to 20 users, by username. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        users: components["schemas"]["User"][];
                    };
                };
            };
            403: components["responses"]["NotLocal"];
        };
    };
    currentUser: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The user, or null when anonymous. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CurrentUser"];
                };
            };
            403: components["responses"]["NotLocal"];
        };
    };
    switchUser: {
        parameters: {
            query?: never;
            header: {
                "X-Tracepanel": "1";
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description The user's primary key; null logs out. */
                    user_id: string | number | null;
                };
            };
        };
        responses: {
            /** @description Now logged in as this user (null when logged out); the session cookie is set. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CurrentUser"];
                };
            };
            403: components["responses"]["NotLocal"];
            404: components["responses"]["NotFound"];
        };
    };
}
