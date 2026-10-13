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
        IssueKind: "n+1" | "duplicates" | "slow-sql" | "slow-http" | "error" | "long-transaction" | "in-transaction" | "htmx" | "queue-wait" | "blocking-call" | "large-result";
        /** @description A trace without its document, as in lists. */
        TraceSummary: {
            id: string;
            /** @enum {string} */
            kind: "http" | "task" | "command" | "websocket" | "rpc";
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
            /** @enum {string} */
            trace_kind: "http" | "task" | "command" | "websocket" | "rpc";
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
            trace_kind: "http" | "task" | "command" | "websocket" | "rpc";
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
            kind: "http" | "task" | "command" | "websocket" | "rpc";
        };
        /** @description One operation: a trace kind plus name, e.g. http "GET /posts/<int:pk>/". */
        OperationStats: components["schemas"]["GroupStats"] & {
            /** @enum {string} */
            kind: "http" | "task" | "command" | "websocket" | "rpc";
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
            occurrences: number;
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
            /** @description Issue groups besides errors: N+1, duplicate and slow SQL, transactions, htmx. */
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
        KnownValues: {
            /** @description Celery task names. */
            task: string[];
            /** @description Celery queues tasks ran from. */
            queue: string[];
            /** @description Job names: management commands and tracepanel.trace() blocks. */
            job: string[];
            /** @description RPC methods served, Service/Method. */
            rpc: string[];
            route: string[];
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
            /** @description For the traces in enqueued, connection_events, delivered and calls: the span of this trace each came from (the task.enqueue, channel.send or outgoing call span), by trace id. The call tree shows a task under the span that enqueued it, and a call's trace under the call. */
            via: {
                [key: string]: string;
            };
        };
        /** @description ULID. */
        id: string;
        /** @description Unix epoch microseconds, UTC. */
        time: number;
        /** @description Microseconds. */
        duration: number;
        /** @enum {unknown} */
        status: "ok" | "error";
        /** @description Namespaced attributes (http.*, db.*, cache.*, code.*, user.*, task.*). task.* is shared by every task queue (task.system says which: celery, django, dramatiq, rq). Values are scalars or lists of scalars. */
        attrs: {
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
            kind: "http" | "middleware" | "framework" | "view" | "template" | "sql" | "transaction" | "cache" | "redis" | "mail" | "signal" | "http.client" | "task.enqueue" | "task.run" | "command" | "function" | "event" | "websocket" | "websocket.send" | "channel.send" | "graphql" | "mongodb" | "elasticsearch" | "cassandra" | "dynamodb" | "memcached" | "kafka" | "rabbitmq" | "sqs" | "grpc" | "db" | "messaging" | "rpc" | "otel";
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
            kind: "n+1" | "duplicates" | "slow-sql" | "slow-http" | "error" | "long-transaction" | "in-transaction" | "htmx" | "queue-wait" | "blocking-call" | "large-result";
            title: string;
            /** @description Where in the project code it happens, e.g. "blog/views.py:21 in post_list". */
            culprit: string | null;
            hint: string | null;
            /** @description Occurrences within this trace. */
            count: number;
            span_ids: components["schemas"]["trace.schema"]["$defs"]["id"][];
        };
        /**
         * Trace
         * @description One unit of work: an HTTP request, a background task or a management command, with its spans, logs, errors and detected issues. Times are Unix epoch microseconds (UTC); durations are microseconds.
         */
        "trace.schema": {
            id: components["schemas"]["trace.schema"]["$defs"]["id"];
            /** @enum {unknown} */
            kind: "http" | "task" | "command" | "websocket" | "rpc";
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
            $defs: {
                /** @description ULID. */
                id: string;
                /** @description Unix epoch microseconds, UTC. */
                time: number;
                /** @description Microseconds. */
                duration: number;
                /** @enum {unknown} */
                status: "ok" | "error";
                /** @description Namespaced attributes (http.*, db.*, cache.*, code.*, user.*, task.*). task.* is shared by every task queue (task.system says which: celery, django, dramatiq, rq). Values are scalars or lists of scalars. */
                attrs: {
                    [key: string]: (string | number | boolean | null) | (string | number | boolean | null)[];
                };
                span: {
                    id: components["schemas"]["trace.schema"]["$defs"]["id"];
                    parent_id: components["schemas"]["trace.schema"]["$defs"]["id"] | null;
                    /**
                     * @description otel is an OpenTelemetry span as its instrumentation recorded it, with otel.span_kind and otel.scope among its attributes: the agent maps it to one of the other kinds before it stores the trace, so the console never returns one.
                     * @enum {unknown}
                     */
                    kind: "http" | "middleware" | "framework" | "view" | "template" | "sql" | "transaction" | "cache" | "redis" | "mail" | "signal" | "http.client" | "task.enqueue" | "task.run" | "command" | "function" | "event" | "websocket" | "websocket.send" | "channel.send" | "graphql" | "mongodb" | "elasticsearch" | "cassandra" | "dynamodb" | "memcached" | "kafka" | "rabbitmq" | "sqs" | "grpc" | "db" | "messaging" | "rpc" | "otel";
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
                    kind: "n+1" | "duplicates" | "slow-sql" | "slow-http" | "error" | "long-transaction" | "in-transaction" | "htmx" | "queue-wait" | "blocking-call" | "large-result";
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
