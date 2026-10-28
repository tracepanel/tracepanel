# Changelog

## Unreleased

### Added

- An N+1 from a JavaScript app that reads through Prisma, Drizzle,
  TypeORM, Sequelize, Knex or Mongoose gets that ORM's fix: `include` for
  Prisma and Sequelize, `with` or a join for Drizzle, `relations` or
  `leftJoinAndSelect()` for TypeORM, a join or `whereIn()` for Knex,
  `populate()` for Mongoose. The JS SDK names the ORM in `db.client`, as the
  Python SDK names Django and SQLAlchemy. Other queries keep the general
  hint.
- An N+1 from a Java or Kotlin app that reads through Hibernate (JPA,
  Spring Data JPA) or Exposed gets that ORM's fix: `join fetch` or
  `@EntityGraph` for an entity loaded by its key, `@BatchSize` or
  `hibernate.default_batch_fetch_size` for a collection, `.with()` or
  `load()` (or a join) for Exposed. The Java SDK names the ORM in
  `db.client`. A by-key lookup written without spaces around `=`, as
  Hibernate writes it, now counts as one.

## 0.5.1 (2026-10-26)

### Changed

- The console, the in-page panel, the pill and its card and a shared
  snapshot file start dark, whatever your system's theme. To go back to
  light, click the theme button in the console's sidebar or the panel's
  toolbar: it switches to Light, then to Auto, which follows the system. A
  theme you chose before stays, so if you already picked Light or Auto,
  nothing changes for you.
- The panel's Profile button is lit when your app's settings profile every
  request (`profile = true`), with no cookie, and shows the memory dot when
  they profile memory too (`profile_memory = true`). Before, it looked off
  while every request was profiled. Its hint names the setting, and a click
  only adds memory on top, never less than the settings profile. When both
  are set the button offers nothing and its hint says to change the
  settings. `api/capabilities` answers `profile_all` and
  `profile_memory_all` from the app's hello.

## 0.5.0 (2026-10-26)

AWS, LLM calls, file storage and migrations in the console, memory and GC
pauses in profiles, task workflows, Django signals, an app's settings and
warnings, and a new look for the call tree, the lists and the light theme.

The store's format is now version 24. The agent starts a new store file,
`traces.v24.sqlite3`, and doesn't read the old one: the traces and issues an
earlier agent recorded stay in that file, and you can delete it.

### Added

- The agent carries its licenses wherever it goes. `tracepanel-agent
  licenses` prints its license, its notice and the notices of everything it
  is built from, and the console's sidebar has a Licenses link that opens
  them (`/api/licenses`). The notices now also cover what the console's
  bundle takes from its build tools (Tailwind CSS, tw-animate-css, Vite and
  Rolldown), the shadcn/ui components copied into it, Rust's standard
  library and the musl C library of the static Linux builds. On Maven
  Central the license, the notice and the third-party notices are published
  beside the binaries.
- AWS has a page of its own in Data, shown once the app called AWS: every
  call by service and operation (S3 GetObject, DynamoDB Query, Lambda
  Invoke), with its p95, its failures by error code (`NoSuchKey 3`), the
  SDK's retries, the region and where in the code it is called from. A row
  opens to the apps and lines that call it and its latest calls, each a way
  to its trace, and S3's, DynamoDB's and SQS's rows lead to their Storage,
  DynamoDB and Amazon SQS pages, which analyze them. Its search takes
  `aws:`, `op:`, `region:`, `error:` and `failed:`. In the services map each
  AWS service is a box of its own (Amazon S3, AWS Lambda), named as AWS
  names it, all inside one `AWS · <region>` frame per region, as an app's
  roles are framed. A Django storage on S3 or a task queue on SQS is that
  service's box. The API's services have a `cloud` field with the service
  and its region.
- S3's own operations get S3's hints: a HeadObject per key says list the
  prefix once with ListObjectsV2, a DeleteObject per key DeleteObjects, the
  same GetObject twice is a duplicate. A slow storage call over the network
  is an issue (`slow_http_ms`), a slow S3 call with a presigned URL hint. A
  slow DynamoDB Scan says Query with a global secondary index, and a
  FilterExpression to put the attribute in the key condition. SNS reads
  Amazon SNS in titles. A call to AWS made for a storage, a cache or a task
  queue is the layer's issue, as Redis commands under a cache call are, so
  an SDK can send such calls with their own kind.
- LLM calls are a span kind of their own, `llm`: each call an app makes to
  a model through OpenAI's or Anthropic's API, with OpenTelemetry's GenAI
  attributes. A `function` span with `gen_ai.operation.name`, as the Python
  SDK sends them for now, becomes one when it arrives, and so does a model
  call an OpenTelemetry instrumentation records (`gen_ai.*`, the older names
  too). The agent estimates each call's cost from its tokens and a dated
  table of list prices (`tracepanel.cost_usd`): a model without a price has
  none, and an `llm-prices.json` in the store's directory, or
  `--llm-prices FILE`, overrides or adds models. A model's HTTP requests are
  its own: no slow HTTP call, no duplicate for a retry. Calls made one by
  one in a loop are an N+1 with a hint (one embeddings request for every
  text, concurrent requests, the Batch API), but not calls made at once or
  an agent's turns waiting on a tool, and the same prompt sent twice is a
  duplicate. In the call tree they have their badge and colour, an LLM share
  of the time strip and its lane, a chip, and details (Provider, Model asked
  and answered, Tokens, Cost marked as an estimate, Time to first token,
  Finish reason, Tool calls). Captured messages read as a conversation, a
  turn each, the history folded. The trace's header says `2 LLM calls 2.3 s
  · 2,816 tokens · ~$0.00298`, and the console has an LLM page of them by
  provider, operation and model, with their tokens, cost and p95.
- File storage calls are a span kind of their own, `storage`: each call a
  Django storage makes to its backend (save, open, exists, url, listdir...),
  on the local disk or S3. A `function` span with `storage.op`, as the Python
  SDK sends them for now, becomes one when it arrives. The agent finds their
  issues as it does other systems': the same call repeated in a loop is an
  N+1 with a hint for what it asks (one listdir() instead of an exists() per
  file, URLs not signed one by one), the same file asked twice a duplicate,
  and on the local disk only many of them together count. In the call tree
  they have their badge and colour, a Storage share of the time strip and
  its lane, a chip, and details (Storage, Backend, Operation, Path, Bytes).
  A loop's calls fold into one row by directory, `exists avatars/*`. The
  trace's header counts them, `9 storage calls`, the console has a Storage
  page of them, and the services map a node per storage (`Amazon S3`).
- Migrations in the console. A migrate job's first tab says what it did
  (`1 applied · 1 faked · 2 risky operations`) and lists each migration it
  applied or unapplied with its operations, their rows, time and whether
  they ran in a transaction, and the plan's migrations it didn't get to. An
  operation that locks or rewrites a table, or has no reverse, has the
  issue's chip and its reason. Migrations and operations are span kinds of
  their own, `migration` and `migration.operation`, with a badge, a colour,
  a filter and their details in the call tree: the Python SDK's `function`
  spans with `migration.app` or `migration.operation` become them when they
  arrive. A risky operation of a migration applied for real (not faked) is
  an issue of the trace, `migration-risk`, its reason the title, the
  migration and the operation where, with what to do instead. A migrate
  job's trace keeps the app's unapplied migrations true: those it applied
  go from the warning, those it unapplied come back, and the warning links
  to it (`migrate` in `api/app`).
- A `manage.py collectstatic` job's first tab says how many files it
  copied, linked, left unmodified and post-processed, and each phase's time
  with its files (Copy, Post-process, Clear).
- Taskiq is listed among the task systems: `task.system` `taskiq` reads
  Taskiq in the console.
- Profiles show memory and GC pauses. A profile can say what the trace's
  code allocated (`memory`: its peak, what it kept, where the memory was)
  and the garbage collector's runs (`gc`: how many, their pauses and when).
  The schema and the agent take them, and a profile without them stays
  valid. A profiled trace's header says them in one line
  (`↑ 42 MB peak · GC 3× 12 ms`). The Profile tab switches between Time and
  Memory: the trace's peak, what it kept and allocated in all, its memory by
  package, a flame graph of bytes and the sites it was allocated at, with a
  note where the sites are the end's rather than the peak's or other traces
  ran in the process meanwhile. On the time strip the pauses are a GC share
  of their own.
- The panel's Profile button can profile memory too. One flame the size of
  the toolbar's other icons: muted while off, orange while profiling time,
  with a dot at its corner for time and memory (slower). A click, Enter or
  Space moves to the next and round, its hint says the mode and what a click
  does, and a screen reader hears each change. It sets the
  `tracepanel_profile` cookie to `1` or `memory`. Time and memory is there
  only when the app says `profile_memory`, a new field of `api/capabilities`
  (false for an app that doesn't say it). Else the button is Off and Time.
- A profile can say when each stack was seen (`bucket_us`, `stacks[].at`),
  which frames wait rather than compute (`frames[].waiting`, an await's
  `at_line`) and how many samples weren't taken because the trace's thread
  ran other traces too (`dropped`). The schema and the agent take them, and
  a profile without them stays valid. With them, the Profile tab reads in
  the trace's own time, as the time strip does: what wasn't sampled is said
  and filled in from the samples around it. Waiting is a share of its own,
  hatched, and with a range picked it profiles that stretch.
  The time strip, its legend and the call tree split the code's own time
  into what it waited in (`waiting · 1.5 s`, a `wait` row named by the wait:
  `asyncio.sleep in send_digest`, its line on hover) and what it computed,
  and a click opens the profile at that stretch.
- Pick a part of a trace's time in its call tree, by kind or by range. A
  share's stretch of the time strip, or its entry in the legend, says its
  time, its percent and how many calls on hover. A click on it keeps that
  kind's calls in the tree (Database, Templates, View code...), with the rows
  on the way to them dimmed and opened. A drag across the lanes, or across
  the tree's bars, keeps the calls of that stretch of time and shows it as
  `12.4 → 18.9 ms · 6.5 ms`. Both go into the page's URL (`part=` and
  `range=`), so a link opens the tree with them. A click on the share again,
  Show all, Esc or a double click lets them go. The panel does the same, and
  its Console button opens the trace with what was picked.
- A long stretch of a trace's own code with nothing it called traced reads
  as code. On the time strip it is its share's colour, and in the call tree
  it is a row of its own under the span, its bars where it fell, named by
  what ran: with a profile, its functions (`aggregate · render_csv`), else
  `untraced code`. With a profile, the flame of the panel's Profile
  toggle after its name, and a click on the row, open the profile.
  `api/capabilities?service=` says whether an app profiles on request. A
  transaction's time says on hover how long it was open and how much of that
  its SQL took, and a row whose name says its database has no chip saying it
  again.
- Task workflows. A task run's related traces have a Workflow part: the
  workflow's first run, the step before it (the run that sent it, or a job it
  waited for), the steps after it, its callbacks and its group's other tasks,
  each with how it ended and how long it took. A long group lists its first
  five, how many more, and a search for them all. The agent links runs by
  the ids an SDK records: `task.parent_id`, `task.depends_on`,
  `task.root_id` and `task.group_id`. `api/traces/{id}/related` has them in
  `workflow` for a run in one, and the search takes `group:`. A step sent
  from inside the run before it stays its `enqueued_by`, listed once.
- A task's facts say when it was due (`task.eta`, as "Oct 21 15:45:20.345 ·
  2 min late"), its priority, its time limit (`task.timeout`, and "stopped
  by its time limit" when it failed on it) and its workflow: the task it
  follows, what it waits for, its root and its group, each a link to its
  run. A callback (`task.callback`, RQ's `on_success`, `on_failure` and
  `on_stopped`) says whose: Callback of.
- A task workflow drawn whole. Below a run's related traces, the Workflow
  part draws every run of its workflow, left to right as they ran: the
  request that started it, each task's latest run with how it ended, how
  long it took and how many runs it had, a group's tasks in a frame (its
  first five, then a search for the rest), a callback on a dashed line. The
  run on screen is marked, every other box opens its trace. The agent finds
  the runs from the one asked for, by the same ids, at most 100 of them, and
  sends them in `workflow.graph`: the nodes, the edges between them and
  whether it was cut. A snapshot carries every run the graph shows.
- A task's workflow graph is compact: a box is one line, a dot for its
  state, its name and its time, as wide as names need. The run on screen is
  filled, not outlined. The graph starts at the page's left edge, under its
  heading, and its runs are no longer listed again as rows of the related
  traces above it.
- A request's tasks in the panel. A task's row in the call tree and under
  Related traces names what its own trace found (N+1, Long transaction,
  Error…) and its queries, as the lists do. In the panel a task opens in the
  panel itself, with a way back to the request (Back, or Esc). The panel's
  list nests the runs a request sent under it as the workers record them.
  The pill says what a request's tasks ran into as its other numbers do: the
  Tasks icon, then a red "5 failed" chip and the amber "3 issues" one, the
  same chips as its own, and its ring turns red when one failed. The agent
  lists a trace's runs (those it enqueued, and theirs) with
  `api/traces?ids=…&runs=1`.
- Django signals in the call tree. A send's row names its signal
  (`post_save`, or a project signal's dotted path), its sender
  (`auth.Group`), how many receivers it ran and, in red, how many of them
  failed: under `send_robust()` the trace stays ok, so this is where a
  failure shows. Each receiver is a row under it with its file and line, or
  what it raised. Its details list the signal, the sender, whether it was
  robust, the receivers and the line that sent it, and a receiver's its
  function, where it is defined and its exception. The time its receivers
  took is the breakdown's Signals share, a chip that shows the sends with
  all they did. The same send repeated in a loop folds into one row, ×N.
  The sends nobody received are a line among the request's facts, "Sent
  with no receiver". `schema/trace.schema.json` documents the `signal.*`
  and `exception.*` attributes.
- Queries a template made as it rendered say so. In the DB tab and the call
  tree such a query has a chip with its template and line
  (`template blog/list.html:4`), its "Called from" names the view's line it
  was rendered from, and its details have a Template row. An N+1 a template
  made opens its hint with the template and its line, then the fix:
  `select_related()` for a lookup by key, `prefetch_related()` for related
  rows, or for an ORM the agent doesn't know, loading them in the view. The
  line comes from `code.template_line`, which the Python SDK records.
- A template's context in the call tree. A template's details list each
  name it was rendered with and its value, as the Python SDK recorded it:
  repr-ed, cut, secrets masked, a long one folded under "Show all". A
  template's context stays on this machine, as a request's headers do: a
  snapshot shared without its values leaves it out.
- A response's body beside its request's, as Django Silk shows them. A
  request's parts are Headers, Query, Request body, Cookies, Session,
  Response headers and Response body: JSON laid out and coloured as a task's
  arguments are, a form as its fields, a body cut at the SDK's limit laid out
  as far as it goes and marked with how much of it is shown, and one kept by
  its size only (an image, a page) saying so. The same parts show in the
  console, in the panel and on the call tree's request row. A response's body
  stays on this machine, as a request's does.
- An app's settings and versions, as a debug toolbar shows them. The panel
  has an App tab after Request: the settings of the app that served the
  request, a filter above them, secrets masked by the SDK as `********`, and
  the versions of what it runs on, the agent's too. On the Services page an
  app's row opens its page with the same, and a link to its own work, and a
  trace's facts name its app, a link to that page. The SDK says them once,
  in its hello, and the agent serves them at `api/app?service=`. The Python
  SDK sends them from Django and Flask. For an app whose SDK doesn't, the
  page says so and the panel has no App tab.
- An app's warnings on top of its App tab and its page: what its checks
  found wrong with it, the most serious first. Each says its level in the
  colour a log record's has, its id, what it is about, its message and its
  hint. The Python SDK sends Django's system checks, the migrations not
  applied yet and the model changes with no migration. The App tab counts
  them, red with an error among them. An app with none shows nothing more.
  The SDK says them in its hello, or in an `{"app": {...}}` frame once its
  checks ran, and `api/app` serves them in `checks` and `migrations`.

### Changed

- AWS's services are listed under AWS in the sidebar, not as items of their
  own: DynamoDB, Amazon SNS, Amazon SQS and any other system named for AWS
  show, indented, while the AWS page or one of theirs is open. Their pages
  still open from the AWS page's rows, the services map, search and their
  URLs, and without calls to AWS's API they stay items of their own. The
  Data group now reads databases and caches, brokers, the calls out (HTTP
  calls, AWS, LLM), Storage, then Logs.
- Third-party logos show only where their owners allow it. The services map
  draws PostgreSQL, MySQL, SQLite, Redis and RabbitMQ with their kind's icon
  and their name. A runtime (in the panel's pill, the app switcher, an app's
  page and the app chips) shows its owner's mark, unaltered and in its own
  colour, only for Go, Ruby on Rails and Node.js. Every other runtime shows
  the plain app icon and its name. NOTICE says that product names and logos
  are trademarks of their owners and that their use implies no endorsement.
- A trace's time is one strip over its call tree, in the Call tree tab, on
  the console's page and in the panel alike, for every kind of trace: its own
  lane in the colours of where its time went, a lane per system it called
  named by what its marks are (`139 queries`, `1 log record`), and the
  shares of the time and the call tree's filters as its legend. It replaces
  the tiles, the lanes and the bar over the call tree. On the console's page
  the first tab (Request, Task, Job, Page) has the trace's facts only. What
  the trace called is one quiet line in the page's header after its duration
  (`139 queries 29 ms · 3 unique`).
- A call tree and its strip show a trace's warnings and worse, not every
  record: its info and debug records stay out of the tree and the log lane,
  a quiet note on the span they were logged in says how many (`3 logs`),
  and the legend's Logs chip, or a click on the note, shows them all
  (`logs=all` in the URL). The Logs tab and the Logs page show every record,
  as before. A request with no view or handler recorded counts its own time
  as "Your code": it can't be told from the framework's then.
- A wait the app awaited through `sync_to_async` is named as the app wrote
  it, `await sync_to_async(…) in product_feed`. A few ms of code beside a
  long wait (or the reverse) is no longer a row of its own: under 5 ms, or
  under a fifth of the span's own time and a twentieth of the trace's, it
  folds into one row with the rest.
- The call tree has colour and rhythm. A row's kind badge is a soft fill of
  its share's colour, the strip's and its legend's (SQL blue, your code
  purple, templates green, the framework grey), and so is its bar, slimmer
  and rounded. A wait is an outlined badge. Faint guides run down the
  indent, the fold arrows step back, and the selected row is marked at its
  edge. A query's verb and an HTTP call's method (in its colour) stand
  apart from what they act on, and the framework's steps and library code
  read quieter than yours. A call that took a fifth of the trace has its
  time in amber, half of it in red. Rows are a little tighter.
- The call tree's details read as a trace's info tab does: a call's fields,
  its attributes, a template's context and a linked run's facts in the same
  rows under the same headings, with no boxes. A request in a workflow's graph
  shows its method in the call tree's muted badge, and in Tasks a system and
  a worker in Now are the same neutral tag, labels rather than buttons.
- The call tree's request row shows what its Request tab shows: the same parts
  behind the same switch, Headers to Attributes. Every trace has the switch, a
  task run's with its one part, Attributes, and the attributes are one card with
  their namespaces as headings inside it. A task's arguments, keyword arguments,
  result and retry reason sit under its other facts, a line each in the same
  columns, not cut short. Its arguments and result, Python literals as the SDK
  writes them, show as the JSON they stand for, coloured: `{"attempts": 3}`, a
  tuple as an array, None as null. An error's locals copy, and an email's HTML
  and Text switch as a request's parts do.
- The code's own time is "Your code" in every kind of trace, a request's view
  or handler too. A call tree's rows look one way: a task a request enqueued
  has the grey kind box of the other rows, and its bar where it ran, running
  to the right edge and fading there when it outlasts the request. A task's
  run is a "task" and a command a "job" wherever a row names them.
- A trace's first tab is one anatomy for every kind. In the panel it heads
  with the trace's line as the page's header says it (its badge, name, how
  it ended, its time) and what handled it under, quietly: a request's view
  or handler, a task's queue and worker. Its facts follow in one order, its
  kind's own first, then App, Runtime, Started and Trace ID, nothing its head
  says again. A related trace is a row as the call tree draws a linked one:
  a grey kind box, its name, its state and findings, its time.
- A trace's info tab reads as one page, in the console and in the panel: its
  facts, Related traces, Workflow and Attributes share one heading style and one
  row, a name in a muted column and a hairline under it, with no boxes or bands
  of capitals. An attribute's namespace is a quiet heading over its rows. Only
  ids, paths and code are in monospace, and a body or a document keeps its box.
- A trace's facts look like its related traces under them: names in muted
  text, not capitals, a hairline under each row, no grey box around them.
- A trace opened from HTTP, Tasks, Jobs or another entry point's lists, or
  from a group's page, opens on what it was: its Request or Task tab. One
  opened from Traces, a search or ⌘K opens on its call tree. An error still
  comes first, and a link naming its tab still opens that tab.
- A trace's DB, Cache and HTTP calls tabs are tables like the console's
  lists: a head (Query or Call, Time, Share), hairline rows and columns to
  size and hide. Over the table a line says how many, how many unique and
  their time (`4 queries · 4 unique · 11 ms`), with the Grouped and In order
  switch at its end, as the Logs tab has its button there. A repeated query
  says `×13` beside its name as in the call tree, one made once no count,
  and the share of the time is a percent instead of a bar. In order lists
  each query's start. An open row reads as the call tree's details: what it
  is, the statement, its fields, the query plan and where it was called from.
  A query opened in the call tree has the same Query plan.
- Every list of names and values reads one way: a request's headers and
  attributes, a call's fields and all its attributes, a log record's fields,
  an app's settings, a template's context, an error's locals and an email's
  addresses. A list is one item a line (`signal.unreceived`, `db.params`,
  shown as JSON or joined with commas before), JSON and a Python repr are
  laid out and coloured, a long value folds under "Show all", and each one
  copies as it came. A log message that is JSON is coloured as well.
- One badge for a trace's kind and one for a task's state, wherever they show:
  the lists, the call tree, Related traces, the panel, ⌘K and Now. TASK, JOB,
  WS, RPC, GQL, PAGE and a request's method share a shape and a colour, a span's
  kind in the call tree is a muted one of the same, and a failed run says
  "failure" everywhere.
- An entry point opens on its calls: HTTP on All requests, Tasks on All
  runs, Pages on All events, and so on, from the menu, ⌘K or a group's way
  back. Its switch, a smaller one, reads "By task | All runs" on every one
  of them, the groups at `view=overview`. A link that named a list still
  opens it. Its heading is its name in the menu (HTTP, not HTTP
  endpoints), and its Overview is folded over the calls and open over the
  groups, until you fold or open it yourself: that choice stays, as before.
- Every table has a clear head in both themes: on white a quiet cool band
  a step off the rows, its names a touch darker, a hairline under it, as the
  dark theme's band. A header that stays in view as the list scrolls keeps
  its band opaque and casts a soft shadow on the rows under it, only while
  they scroll under it. A log's time shows whole, to the millisecond, and a
  column's name is never cut: a column narrowed by a drag or a narrow page
  stops at its name's width.
- A crisp light theme: a white page and sidebar drawn with hairlines, no
  shadows, near-black text and one grey for labels. Lists have denser rows, a
  white header over a strong rule and smaller filter chips. A method or a
  trace's kind is its colour in monospace and a status a dot before its code,
  the same in lists, a trace's header, its related traces and the panel. Issue
  chips and a call's kind keep a soft square fill. The current page in the
  sidebar is a grey row, the open tab is underlined in near-black and page
  titles are smaller. The dark theme is as it was.
- No outline or ring around a focused control, in the console, the panel or
  the widget's pill: keyboard focus shows as a light tint over the control
  instead.
- Set user in the panel is an outlined button of one size. A logged-in user
  lights its icon with a dot, and their name is in its hint (`Acting as
  alice · click to change`), so a long name no longer stretches the toolbar.
  Docked at the bottom, the list's toolbar row keeps Follow new, Profile and
  Clear in one tight group on the right. As the list narrows, the logo drops
  its wordmark, then Follow new its name, then Set user its label, and the
  row never wraps.
- Tasks from Huey, django-q2 and Channels workers are named as their
  projects name them in a run's System column and filters: Huey, django-q2,
  Channels. The API schema lists them among the task systems.
- The Tasks page's Now shows a task's arguments as the JSON its trace shows,
  `[42] {"to": "ann"}`, not as Python wrote them, and empty ones not at all.
  A long task name is cut at its start, so its handler stays in sight.
- A long task name is cut at its start everywhere it shows, as on Now, so
  the handlers of one consumer no longer read the same. That is the Tasks
  page's lists and its Overview, a task's page and its crumb, a trace's
  heading, the call tree's task rows and the tasks it sent, a request's
  enqueued tasks, the Task filter and ⌘K, in the console and in the panel.
  A cut name starts where a whole one does, after a "…". In the call tree,
  "enqueue" stays whole before it. The whole name shows on hover.

### Fixed

- An N+1 in a GraphQL request names the DataLoader of its server library:
  `strawberry.dataloader` for Strawberry, graphql-sync-dataloaders (sync)
  or aiodataloader (async) for Graphene, and a DataLoader with no library
  named for any other. It said Strawberry's on every GraphQL trace before.
  The library comes from `graphql.library`, which the Python SDK records.
- A model call recorded by an OpenTelemetry GenAI instrumentation counts its
  prompt cache writes in its cost when it names them by the conventions'
  older `gen_ai.usage.cache_creation.input_tokens`. They are stored as
  `gen_ai.usage.cache_write.input_tokens`, the current name, and were left
  out before.
- Menus in the light theme are white, with a hairline border, a soft shadow
  and the item under the pointer a faint grey. A menu took the focus as it
  opened and was greyed over, its shadow gone. Explore is an icon now, its
  name in the hint, and in the panel the first after Console, so the
  toolbar has room for the tabs.
- A call tree says each thing once. A range picked is said by the legend's
  chip alone (`Time 11 ms – 1.6 s`, × lets it go), and its bands over the
  strip and the tree are a hairline and a tint that cover no axis or lane
  label. Only a drag picks a range there: a click on a code row or on the
  strip's code time opens the Profile tab at that stretch, the call tree
  keeps the whole time. Show all shows only with two or more things picked.
  Profile is turned on in the panel's toolbar only, and a trace without a
  profile has no flame. The code's own time has no popup: a wait row says
  where it waited after its name (`tasks.py:108`), and with a profile its
  flame and a click open it. The legend no longer repeats the strip's
  waiting and untraced time, which its share says on hover. A task's trace
  has no Tasks chip that picks only itself, and a query under its
  template's row doesn't name the template again. A task's name cut to fit
  drops its module path first and keeps its last segment readable
  (`build_sales_report`), and in the panel's list a row with no status
  takes that room too. The strip's trace lane is one clear line, each
  moment in its share's colour, hatched only where a timed profile says the
  code waited. A lane of a store's calls (queries, Redis, cache,
  datastores) shows only when one of them is flagged: the trace lane shows
  them in colour. Messages, HTTP and RPC calls, logs and errors keep their
  lanes. The Profile tab's time by package and the strip's legend are one
  look: one bar, an inline legend (name, time, percent), largest first and
  waiting last.
- Library frames are summed up by their packages, on one line: "10 library
  frames · faststream ×9 · sqlalchemy", every module on hover and when opened.
  The list of every module ran past the error's edge.
- An attribute's name gets the room it needs, up to 24rem or 40% of the
  width, and wraps past it: `messaging.rabbitmq.destination.routing_key` was
  cut at 11rem while its value had the rest of the row.
- A task's facts: the copy button of its arguments, keyword arguments and
  result sits right after the value, not at the row's far end, and a result
  of None reads as JSON's null, as the rest of the value does.
- A trace a task or message is linked to in two ways is listed once in
  Related traces, under the first name that fits: a request that enqueued
  and sent a task through a broker, or enqueued it and delivered to it.
- The GraphQL page's By operation table shows an operation's type whole:
  `mutation` and `subscription` were cut short. A row with no type, a
  document that didn't parse, has no type pill and is named as the SDK names
  it (`syntax error`), not `query` and `anonymous`.
- A worker that stopped leaves the Tasks page's Now within 90 seconds, not
  an hour later as an idle worker. Workers beat every 30 seconds, and three
  missed heartbeats drop a worker and the tasks it ran. A worker that stops
  cleanly says so in a `worker_stopped` task event and leaves at once, with
  any task still running on it.
- A trace's tabs never show cut. In the panel, docked at the bottom or on
  the right, and in the console, the tabs that don't fit go into a More menu
  at the row's end, with their counts, and a dot on it when one of them has
  issues or errors. When that would leave less than half of them in the row,
  the tabs but the open one show their icon and count only, their name in
  the tooltip. The open tab always stays in the row.
- A group page's Time button is its own size again, not stretched across
  the page.
- The slowest and failing lists above a section's table no longer widen the
  page sideways when a name is long, as a task's often is: it is cut short.
- A task, a job, a WebSocket or an RPC call in the panel's list reads as
  its row in the console's lists does: its kind's badge, then its name. A
  task's whole name was its badge, in capitals. A GraphQL operation has the
  console's GQL badge too. A row with no status keeps its place, so its time
  and queries stand under a request's.
- A small share no longer reads 0%. One failed call in 389 showed "0%" in
  the error colour on the Database page: a share that is neither none nor
  all now reads "<1%" or ">99%", wherever the console and the panel show a
  percent (the tiles of every page, a cache's hit rate, the time breakdown,
  a profile).
- SQL Server's queries get the issues other databases' get. A lookup by key
  written with SQL Server's `[table].[id]` names, as Django's mssql backend
  writes it, is one: a loop of them in library code is an N+1, and its hint
  says `select_related()`, not `prefetch_related()`. IN lists of `@P1`,
  `@name` and `:1` placeholders collapse, a span's table keeps its schema
  (`SELECT dbo.orders`), and EXPLAIN knows those placeholders. The console
  lays a SQL Server statement out in its own dialect and colours its
  `[names]`, `TOP` and `@P1`.
- A count of one reads as one: a task's group of one says "1 task" in its
  facts and its workflow graph, and an endpoint in the search "1 call".
- Agents started at the same moment on one store, as an app's workers start
  them when they fork together, no longer leave two running: the first holds
  `agent.lock` in the store's directory, the others exit at once with status
  3, and every process sends to that one, which the console shows live.
- A list fits a narrow window. Below 1280 px the sidebar is a rail until the
  reader opens it, a choice kept for narrow windows apart from wide ones. A
  column of numbers, a status or a badge keeps its width, a list's minor columns
  (Queries, Issues, First seen and the like) are left out while there is no room
  for them and come back when there is, and a call's name is cut with an
  ellipsis before its alias. At 1024 px every column was cut mid-word.
- Nothing is cut mid-word at 1440 px. A request's issue chips show the ones that
  fit and how many more, all of them named on hover. A call's alias and template
  chips keep their size while the call's text beside them is cut, in the call
  tree and the DB tab. The WebSockets table's headers are whole, and a dotted
  attribute name such as `db.transaction.savepoint` wraps after a dot, not
  inside a word.
- The sidebar shows its Problems at 1440 × 900. Its items are 32 px tall with
  tighter gaps, a list longer than the column fades at the edge it goes on past
  and keeps the current page in view, and its footer reads "Local ·
  .tracepanel/" on one line, starting where the items' icons do. Errors and
  Issues fell below the fold with nothing to say so.
- Names in a list start at one edge. A method or a trace's kind before a name
  takes one slot, as wide as PATCH, in both themes, in the tables, the overview
  lists, the Logs page's Source and ⌘K: a path after GQL started 14 px left of
  one after PATCH.
- On the trace page the call tree, the Logs tab's table and the loading bar sit
  on the page's content edges, as the trace's head, tiles and tabs do. They
  stuck out 16 px on each side.
- A trace, an issue, a group and an app open with one header: their crumbs at
  one place, the same space above them and the page's full width. The crumbs sat
  at three heights and an app's page was narrower. A headline's method or kind
  is its own width, not a list's slot.
- A call's details in the call tree give its fields, Called from, a template's
  context and all its attributes one column of names, so every value starts at
  one edge. Each list sized its own, and their values started at different
  places.
- Columns share the room by what they hold. On Issues an issue's title has the
  room and Endpoints is narrower, its title wrapping in two lines rather than
  three. On Emails a request's path in Sent from shows whole. The Logs page's
  Source column cuts every source at its start, as a task's name is, and never
  leaves a dot after the ellipsis: "….Thumbnail" reads "…Thumbnail".
- Names in a list start at one edge on Linux too. The slot a method or a
  trace's kind takes is sized in the badge's own font, as wide as DELETE: it
  fit PATCH by half a pixel on macOS and missed it on Linux. In a narrow call
  tree an issue's chip is cut with an ellipsis rather than past the row's
  name.
- The sidebar keeps Errors and Issues in view. With many systems (Kafka,
  RabbitMQ, HTTP calls, Logs, Emails) its list scrolls and the Problems group
  stays below it, above the footer, with its red and amber counts: at
  1440 × 800 they were below the fold again.
- A system that doesn't name itself has a proper name. An RPC call with no
  `rpc.system` was "rpc" in the sidebar beside the RPC entry point: its page
  is RPC calls now, and its issues say "RPC calls". A database or a broker
  that names no system reads Datastore or Broker, and any other system the
  agent doesn't know starts with a capital.
- A request reads its method once. One with no path, from an SDK that sent
  only its URL, read "POST POST /hooks/stripe" in the lists, the panel and
  ⌘K: its name after the method is its path there now.
- Every page's header has one refresh control. Services and Database, which
  refresh on demand only, had a "Refresh" text button where every other page
  has the refresh icon beside its auto-refresh menu: they have the same icon
  button now. Issues' filters start with Time, as every page's do, not with
  Type.
- Nothing to show looks one way everywhere. A trace, an issue or a group
  that isn't stored and a search that matches nothing show what a section
  with nothing stored yet shows: an icon in its tile, a title, what to do,
  and the way back as a button, in the middle of the page. They were bare
  centred text with a link that read as bold text.
- One thing is drawn one way wherever it shows. A request's method is its
  badge in Errors' and Issues' Endpoints, on an issue's page, in a trace's
  HTTP calls tab and in the pill and its hover card, where it was plain text
  or purple. An issue reads its kind in its chip, then its title without it
  ("N+1" and "13 similar queries"), in the lists, on its page and in a
  trace's Issues tab, which had small orange capitals. A page's action reads
  CLICK "Delete" · /books in the lists, as in its header, and a failed one
  says "failed" in Status. A task's error names its task where a request's
  names its endpoint. A failed HTTP call has a failed row's red edge and its
  status's badge. A job's first tab is Job, not Command. What ran a task, a
  queue and a job's source are one quiet tag in their own case.
- A copy button follows its value in every row of names and values: a
  trace's attributes, a request's headers, query, cookies and session, a
  call's details, an app's settings and versions, and related traces, as a
  trace's facts already had it. It sat at the row's far end, a screen away
  from a short value. An attribute's name no longer has a tooltip repeating
  it: it wraps whole.
- One switch for a choice of views. An entry point's By/All lists are the
  pill switch a trace's parts, a profile and the Database tab have, the
  chosen one raised on a muted track, where they were a bordered card with
  the brand's colour. GraphQL's own type switch above the search is gone:
  the Type filter does it, on its calls too. A trace's Workflow and Related
  traces are named on the same full-width pill track as its Attributes, in
  the console and the panel, not in bold headings of another kind.
- An open row's actions are one footer. A log record, an email and a query
  opened in their lists, and a finding in a trace's Issues tab, end with
  their own buttons, then the way to the trace at the right end as an
  outlined button with its arrow: "Open request", "Latest query", "All
  occurrences". Logs had a filled button at the top, Emails an outlined one
  at the left, a query a button and a text link. An email's card lines up
  with the row's edges, not 15 px inside them.
- A trace that called nothing (a task, a WebSocket, a GraphQL operation, a
  job, the latest occurrence of an error) no longer shows Duration as one
  full-width tile with an empty bar: its header says how long it took, and
  the lanes under it draw it.
- A value the SDK masked (`********`: a password, a token, a session id, a
  secret setting) has no copy button anywhere: attributes, a request's
  cookies and session, an app's settings, a trace's facts, a call's details.
  It copied the asterisks.
- A trace loads in its own shape: its name, its tabs and its first rows where
  they will be, not a blank page under a progress line. A trace that isn't
  stored says so after one more look on the console's page, within a second,
  not four. The panel waits longer for a request it has only now seen.
- A list page loads in its own shape: the search, the filters and its first
  rows where they will be, so nothing pops in under a bare progress line.
- Every list's header stays in view as its rows scroll under it, as the
  Logs page's did: a long HTTP or Tasks list no longer scrolls its column
  names away.
- The panel shows what the console's trace page shows. Its Request tab has
  the page's lanes under the request's line (not its tiles: the tabs carry
  the duration and the queries), the request's method
  is its own width there, a request's row in its list counts its findings as
  its Issues tab does (three N+1s read 3, not 1), and docked at the bottom
  of a narrow window the list takes a quarter of the width, so the trace's
  tabs keep their names. Its App tab stays the panel's own: the console
  opens an app's page from the trace's facts.
- On the Services map a call's line leaves its box's right side and arrives
  at the middle of the other's left, an S through the gap between their
  columns. Lines started inside a card, crossed the cards beside them and
  landed on a database's bottom edge.
- A group's page has the seven tiles an entry point's Overview has, in the
  same order (Calls, Errors, Slow, p50, p95, p99, Avg queries): it had eight
  of its own, p75 and p90 among them. An issue's long route and title wrap
  in their row instead of being cut ("/campaigns/{id}/r…"). As a rail the
  sidebar's items are the 32 px rows they are open, so a 1024 px window
  shows more of them and toggling moves nothing up or down.
- Smaller things read one way. A trace's start, an overview's range and an
  app's last word say a moment as "Oct 23 15:13:40", on the 24-hour clock,
  and a list's Last column goes from "5m ago" to "3h ago" to "Oct 21". A
  trace's own lane is named as what it is (task, job, websocket, page), a
  WebSocket's and a page's first tabs are WebSocket and Page, and a task's
  breakdown says Framework, not Framework & middleware. A failed trace's own
  lane is red in both themes. Rows of Errors and Issues have no coloured
  edge, which every one of them had. The hover card's fix line names the
  fix (`select_related()`), not the template twice. The panel's Console
  button is filled in both themes. RabbitMQ has an icon of its own beside
  Kafka's. A trace opened directly has a crumb back to its list.
- A latency chart with one point no longer puts p95 and p50 beside it, where
  they crowded the dot: its legend names them. The Logs chart's legend reads
  debug, info, warning and error, in the case every chart's legend has.
- A profile's Functions list has its column names inside its box, in the
  header row's case and colour every table has, not in sentence case above
  it.
- ⌘K's Go to list, longer than the palette, fades at the edge it goes on
  past, as the sidebar does: its last row was cut in half.
- A trace's facts start their second column's values at one x on every
  trace: its column of names is at least as wide as the first's. With short
  names ("Route", "Task ID") the values moved a few pixels from trace to
  trace.
- The pill's hover card stands on the pill: as wide as it (320 px at least)
  and with its edges on the pill's. Its left edge was 8 to 20 px off.
- The sidebar's items read a little larger, 15 px in 34 px rows in both
  themes (they were 14 px in dark and 13 px in light). Its group titles stay
  small, and Problems stays pinned in view.
- On the Services map a project's roles in one layer sit together in one
  frame, one under another: the shop's worker, web and command were spread
  with a gap and its frame overlapped the blog's. A call past a layer is
  routed around the frames in between, and calls recorded under a role the
  app doesn't list start at the app's box, not at an empty spot.
- A system's operations list shows no failures as a dash and some in red,
  as every list's Errors, Failed and With issues columns do: it was the only
  one to say "0". Counts of what happened (calls, queries, runs) say 0.
- A group's and an entry point's seven summary tiles sit in one row again:
  sharing their last four tiles had made them four columns over two rows.
- An app's traces whose SDK named no `service.role` are one of its roles by
  their kind (a request's its web, a task's its worker, a command its
  command), on the Services map and in its table: they were a second,
  disconnected box of the same app at the bottom of the map, with its calls
  drawn from it. What runs an app comes from its latest trace that says so,
  and an app whose SDK never says has a plain app's mark, not an empty tile.
- The Services page reads its apps and calls as fast as before an app's
  role-less traces became its roles: the roles are merged over the grouped
  rows, and what runs each app is read once a group, not a JSON path a row.
- A trace with nothing to place beside its own lane (no queries, calls, logs
  or errors) has no lanes: a single bar from 0 to its duration said what its
  header says. With other lanes its own stays, their reference, on the
  console's trace page and in the panel's Request tab.

## 0.4.1 (2026-10-21)

### Changed

- The agent reads its cloud settings as `TRACEPANEL_API_KEY`, which was
  `TRACEPANEL_TOKEN`, and `TRACEPANEL_INGEST_URL`, which was
  `TRACEPANEL_CLOUD_URL`. The old names are no longer read.
- The code that answered a request is a handler in Java, Kotlin and
  JavaScript apps, and a view only in Python ones, as Django calls it. The
  request's facts, the call tree, the time breakdown and the widget's card
  say which by the trace's `telemetry.sdk.language`. A handler whose SDK
  keeps a longer name, Spring's `com.shop.BookController.list` behind
  `BookController#list`, shows it on hover. The data keeps `code.view` and
  spans of kind `view`, and the search keeps `view:`.

### Fixed

- A worker on the Tasks page's Now no longer reads idle between two tasks
  while tasks of its queues wait. An RQ worker forks a process for each job,
  and the console often asked in that gap. A worker that ended a task in the
  last 2 seconds, with a task of its queues still queued, counts one running
  in `api/tasks/live`. A heartbeat names the worker of a running task whose
  `started` event did not.
- The p50 column on HTTP and GraphQL, Avg on Services and For in Now's table
  are wide enough for their values at 1280 px and up: "810 ms" was cut to
  "810 …".
- The logs table has no day headings between records. Each record's time
  says its day instead, today's too: "Oct 21 15:45:20.345", the Time column
  wide enough for it. Time of day in the columns menu is Date and time now.
- A column's resize edge is a darker gray on hover, while dragged and when
  focused, not the brand's purple. From the keyboard it is thicker too.

## 0.4.0 (2026-10-21)

### Added

- The search box lists the fields a page searches by, with what each takes,
  when it is empty or after a space: `level:`, `logger:`, `route:`, `in:`,
  `extra.*` and the rest on Logs, each page its own. The arrows and Enter
  take one to type its value.
- An opened record's exception shows as an error's frames: its type and
  message first, the app's frames in view and the libraries' folded into "N
  library frames". It reads Python tracebacks, JVM stack traces and
  JavaScript stacks. Raw shows the text as logged, and copy copies it.
- A message that is a JSON object or array opens indented, with Raw beside
  it. The table keeps it on one line.
- "WARNING and above" and "ERROR and above" in the Level filter, as
  `level>=warning`. The chart's legend shows such a filter, and a click on it
  that leaves a level and those above writes one too.
- Now on the Tasks page, one line above the overview: how many tasks are
  running, queued and retrying, and the workers, each with the tasks it runs.
  The counts open a table of the tasks in flight: how long each has run or
  waited, its attempt, and its last error or its arguments. A row opens the
  trace that sent the task. With nothing in flight the line says idle and
  when the last run ended, and before any worker is seen that none is
  connected. Projects without task events have no Now.
- Now names Spring's scheduled tasks "Spring @Scheduled" and BullMQ's jobs
  "BullMQ". A worker's label says the app it serves, not the system of its
  last task, which flipped for an app that runs several kinds.
- Live on the Tasks page, as on the Logs page: the overview, the list and Now
  reload every 2 seconds, and hold while the list is scrolled down. Runs that
  came in since the last reload are highlighted in All runs for a moment. A
  link to the earlier Live list (`view=live`) opens Tasks with Live on.
- Tasks is in the menu as soon as a worker sends task events, before any task
  has ended. `api/counts` says so in `live_tasks`. With no runs stored yet the
  page shows Now, and its list says runs show up when tasks finish.
- Task events: an app tells the agent of a task's steps before its trace
  exists, in a frame that is an object on its connection (`{"tasks":
  [...]}`): `enqueued`, `started`, `retried`, `finished`, and a worker's
  `heartbeat`. Any task queue can send them. The agent keeps the tasks in
  flight in memory, not in the store, drops a running one whose worker went
  silent for two minutes, and serves them at `api/tasks/live`. An app that
  sends them says `live_tasks` in its hello, and `api/capabilities` says so.
- Live on the Logs page: the records reload every 2 seconds, as a tail does,
  and hold while one is open or the list is scrolled down. The browser keeps
  it on.
- The search's words are marked in the logs' messages. An opened record
  copies as JSON, or as a link to itself. A column's name, focused, moves its
  column with the arrow keys. A trace's Logs tab counts its records and opens
  them in Logs.
- An app says what it offers the console in its hello, the one place it says
  so: `capabilities` for what it does down its connection or records in its
  traces, `console` for what it answers at its own console (EXPLAIN in
  Python and Java, switching users in Django). The agent alone answers
  `api/capabilities` from it, and offers the `console` ones only to the
  console that app serves (named in a `Tracepanel-Console` header).
- The panel lists a form's POST that redirected, before the page it led to:
  the SDK names it in a short-lived cookie, and the next page's widget picks
  it up.
- Profile: the time in code at a glance, then where it went by package
  (your code, `django.db`, `django.template`, …). Click packages to light
  their frames, one or several. A colored flame graph tells each call's path
  and time on hover. The functions table shows each function's whole path.
  "Your code / All frames" switches the frames, and a page spent mostly in
  libraries opens on all frames.
- The Profile button stays lit while it is on, and every request is profiled
  until it is turned off.
- Every list of the console has the logs table's columns: endpoints, calls,
  traces, tasks and Now, jobs, pages, WebSockets, GraphQL, RPC, emails,
  issues, services, a system's calls and a group's. Drag a header's edge to
  resize a column, hide it with the × on its header and bring it back from
  the columns menu, or move it by a drag or with the arrow keys. Each list
  keeps its own columns in the browser. The list's main column (Endpoint,
  Task, Trace and the like) always stays.

### Changed

- The SDKs of 0.4 need this agent: an app says what it offers in its hello,
  not at its own console. The SDKs of 0.3 keep installing an agent of 0.3
  through their pins, so nothing changes for them until they upgrade.
- The logs table and every other list share one header and one text size.
  The logs keep their compact rows. The columns fit the page's width, so a
  list with many columns no longer scrolls sideways, and the main column gets
  the room the short values leave. Tasks shows its queues from the columns
  menu.

- The logs table draws only the rows in view and a screenful around them.
  Thousands of records loaded scroll as lightly as a hundred.
- The Logs page has the Overview of an entry point's page: its records over
  time when open, how many records, errors and warnings when folded. The
  chart no longer folds on its own. Every page folds its Overview with the
  others, as this browser last left it.
- Every table's text is one size, the logs' a step up and the others' a step
  down to meet it.
- Debug records step back in the logs table, and a record opened from a link
  scrolls into view. All attributes (the column) writes lists and objects as
  JSON, as the record's fields do.
- The logs chart and the list agree: a click on the legend filters the list by
  level, as the Level filter does (it hid the level in the chart alone), and
  levels are named in capitals in the table, the chart and the filter alike.
  The count says "50 of 1,204" while older pages hold more. A search that
  finds nothing keeps the chart of its time range and offers to clear it. One
  the store refuses no longer shows a loading bar for ever.
- The logs table reads and moves like a list of records: a message's text
  selects and copies (the row opens the record, unless text was selected),
  the arrow keys go from record to record, Enter opens one and Escape closes
  it. A day's heading tops records of another day than today's, Time and
  Level keep their width in a narrow panel.
- A log record opens the same way everywhere: on the Logs page, in a trace's
  Logs tab and in the call tree, its message and its exception to copy, then
  its fields with their own copy buttons. Its time is local, to the
  millisecond, with the date and the offset (it was UTC).
- One set of proportions across the console: the sidebar at the page's text
  size (it was larger than the pages it leads to), one header style for every
  table, a lower search box, and charts on the tables' 24-hour clock. The
  columns menu lists an attribute column once, under Attribute columns.
- Request tab: the method, URL, status and time on top, the request's facts
  in a card, then its parts in one card with a switch, as browser devtools
  show them: Headers, Query, Body, Cookies, Session, Response and every other
  attribute. The headers every browser sends are folded. A form's body shows
  as fields.
- The panel's icon buttons explain themselves in a tooltip: what they do,
  and their key.
- The panel header is quieter: Explore, the user and Console are plain
  buttons and icons, and the user sits next to the request list.
- With the panel docked at the bottom, the page scrolls to its end above it.
- Logs: one table on the Logs page and in a trace's Logs tab. A record takes
  one line, its message cut short (the whole of it on hover and in its
  details), and an exception's last line follows it in red. The level is a
  colored dot and its name. The header stays in view as the page scrolls.
- Logs columns: drag a header's edge to resize a column, double-click it to
  fit the column to its values, or move it with the arrow keys. The columns
  menu shows and hides columns (App, Trace and Attributes are there too) and
  switches the time between the time of day and how long ago (in a trace:
  since the request started). The browser keeps these choices.
- The density rule applies: the shared styles' own root size won over it,
  so it did nothing. It now sets the size the UI was always shown at, 15px
  at the usual 16px browser size.
- Logs: any attribute can be a column of its own, from the columns menu's
  Attribute columns, or from the attribute's own button in an opened record.
  The column's header takes it off again. A column's name drags onto another
  header to move it there (a grip shows at the header's end on hover), and the
  browser keeps the order. Every column but Message hides from its header's
  ×, as from the columns menu.
- A log record's details say where it was logged ("Logged inside"): the
  spans around it, as one link to the call tree there. The Show logs from row
  adds this call and any call of its kind to this request, logger and path.
  Its fields are a compact list, the same as a request's headers, with their
  buttons lined up.
- Logs: the records over time sit above the table, a bar per slice of the
  period, its levels stacked. A level hides from the legend, and a drag
  across the bars narrows the search to that time, as the calls' chart does.
  `GET /api/logs/series?q=` gives the counts by level. The chart folds to its
  title, and the browser keeps it folded.
- The console's filter buttons (Time, Level, Route…) are smaller, to sit
  with the denser tables.

- The agent is on Maven Central, as `dev.tracepanel:tracepanel-agent`: the
  binary of each platform, with the platform as its classifier
  (`darwin-arm64`, `linux-x64-gnu`, …). The same binaries as on PyPI and npm,
  for the Java SDK, which reaches Maven Central or a company's mirror of it.
- Releases carry signed build provenance: the wheels and the sdist, the npm
  packages, and the agent's binary for each platform. `gh attestation verify
  FILE --repo tracepanel/tracepanel` checks one. The files on PyPI carry PEP
  740 attestations too.
- The Request tab shows what a request carried, as an SDK records it: its
  query, headers, body (JSON indented), cookies and session, and the
  response's headers. They stay on this machine: the cloud and a snapshot
  without values get none of them.
- A trace can carry a profile, sampled by an SDK when asked for: the trace
  view shows it in a Profile tab, a flame graph from the outermost call down
  and the functions by their own time and in all. The panel's Profile button
  asks the app to profile the next request, when the app can. Profiles stay
  on this machine.
- `GET /api/capabilities` says whether a connected app profiles on request
  (`profile`) and records what its requests carry (`request`).

### Fixed

- Pages hold still while they load. The menu shows no entry point it then
  takes away, and keeps its items while another app's load. The filters come
  in one step with the values they offer, in a row that keeps its height. An
  entry point's Now, Overview, switch and list show together, as do the Logs'
  chart and list and a system's tiles and list. A page that may turn out
  empty shows its title until it knows, not a search it then takes away.
  Switching By task and All runs keeps the rows on screen, dimmed, until the
  others come. An issue's requests no longer move down when its latest
  occurrence loads.
- Live is a choice of the one auto-refresh menu, on every page, instead of a
  switch beside it: Live, Off, 5s, 15s, 1m. Chosen, the button says "Live"
  with a pulsing light, or "Live · paused" while a record is open or the
  list is scrolled down.
- A load or a reload shows the console once, whole, and fades it in: the
  menu with its sections and the page with its lists, not piece by piece.
- A system's tiles fill their row when there is no hit rate to show.
- A trace page's tiles have no stray line under them and through their gaps,
  and are the other pages' tiles: their corners and number size. Its tabs sit
  in the page's column, the first at its left edge.
- A menu longer than the sidebar fades out at its foot instead of cutting an
  item in half.
- The Overview is one bar, the same open or folded: its numbers bold with
  their labels quiet and a rule between them, its time range at the end.
  Only its chevron turns, and nothing on it moves. A range over two days
  shows the end's date too. The tiles are smaller, on every page and the
  trace page alike.
- Tasks' Now is the Overview's bar with a light: pulsing while tasks run,
  steady with workers idle, hollow with none. Idle names the last run, how
  it ended and when, so a queue whose tasks take milliseconds still shows it
  works. Each worker says idle or how many it runs instead of a bare count.
- A narrow column's hover buttons no longer sit over its name: the name
  makes room for them and stays where it was.
- Tasks' Now table fits the page: a long worker name, arguments or error are
  cut to one line, whole on hover. Now stands over the Overview, chevron for
  chevron, busy or idle. An overview's time range is on the 24-hour clock,
  as the tables and charts are.
- The widget's pill, hover card and panel edge take their colors from the
  console's palette, in both themes, where they kept a copy of their own: a
  color changed for the console changes them too.
- The chips in dense rows (findings in the request lists, the call tree and
  the issue lists, an email's Sent or Not sent) are the console's badge in a
  compact size, as tall as a line of the row's text. A row with one is no
  taller than a row without.
- A logs table with more columns than room no longer widens the page past
  the window, cutting off the chart and squeezing Message out: its columns
  fit the room again.
- A list's auto-refresh no longer loses rows once older pages are loaded. New
  rows pushed rows out of the first page, while the older pages still began
  where it used to end, and the rows between showed nowhere.
- A time range picked on a chart (drag to zoom) rounds out to whole seconds.
  It rounded the end down, and a record or a call in the range's last second
  dropped out of the list it narrowed.
- In the console, the Request tab no longer repeats the method, URL, status
  and time the trace's own header already shows. The panel, which hides that
  header, keeps them on top of the tab.

## 0.3.7 (2026-10-19)

### Added

- Each trace in a list (`GET /api/traces`) carries its `service`.

### Changed

- With the page recording on, the panel's Follow new opens the view or the
  action a new request belongs to, once the agent has it, and stays there
  while that group's requests arrive. It used to jump to each request.
- When the requests in a tab come from more than one app, each request's row
  in the panel names its app, as the call tree does. A Next.js page and the
  API it calls can both answer `GET /projects`, and the two rows looked
  alike.

## 0.3.6 (2026-10-19)

### Changed

- In the call tree, a click on a row's chevron opens or closes the rows
  under it and nothing else. It used to select the row and open its
  details too. On a focused row the arrow keys do the same.
- The chip naming the app that served a call has the size and shape of the
  row's other chips.

### Fixed

- In the panel, the calls a page view or an action made are listed under
  it, with a tree's corner, also in the narrow list and also when the page
  records itself after the badge loaded. They were listed flat, apart from
  what made them.

## 0.3.5 (2026-10-19)

### Added

- The call tree opens the trace another app served for a call under that
  call: the app's view, queries, calls and issues. A chip names the app and
  its runtime. This works when the apps share an agent and when each project
  runs its own. A call used to show the other app's trace as one row.
- A query plan is in colour, as the statement above it. The operation stands
  out, a full scan's in the warning colour. Tables and indexes read as names,
  and the costs recede.

### Changed

- The panel's list of requests marks a request's issues with one chip and
  their count, so the path keeps its room. The chip's title names them.
- Explain and Explain analyze follow the query plan's heading. On a wide
  statement they were scrolled out of view at the far end.
- The console and the panel are 5% smaller.

### Fixed

- EXPLAIN runs a query that has no parameters, such as one with its values
  written in the SQL. It answered that the parameters were not recorded.
- In the call tree, a row with a long database alias and an issue keeps its
  call's text in view. The alias, the chip and the text ran into each other
  and into the bar.
- On the Services page, an app's calls to itself are a loop on its box. They
  were drawn as a stray line under it.

## 0.3.4 (2026-10-18)

### Fixed

- A Spring Boot app is named Spring Boot in the widget and the console, as
  the Java SDK labels it. It read "Spring", the first word of the name. A
  Spring MVC app seen through OpenTelemetry is still named Spring.

## 0.3.3 (2026-10-17)

### Fixed

- "Show N queries" on an issue scrolls to the group it opens. A group last in
  a long list used to open below the fold.
- The widget's pill shows a request's time as the console does. It read the
  time the app wrote before sending the response, so near half a millisecond
  the two could differ by one: 650 ms in the pill, 649 ms in the console.

## 0.3.2 (2026-10-17)

### Fixed

- An HTTP call that two layers of instrumentation both record, such as
  Next.js's fetch and undici under it, counts as one call. It is no longer
  reported as a duplicate of itself.

## 0.3.1 (2026-10-16)

A lighter console, and highlighted source in more languages.

### Added

- The source around an error's frame is highlighted in JavaScript,
  TypeScript, Java and Kotlin too, as in Python and Go.

### Changed

- The console's script is a fifth smaller (913 KB from 1,172 KB): SQL is
  formatted with the dialects of PostgreSQL, MySQL and SQLite only, and the
  source around a frame is highlighted by a tokenizer of the console's own,
  in place of Prism's grammars.

## 0.3.0 (2026-10-15)

Logs in their context: each record knows the spans it was written in, and
the search finds it by them. EXPLAIN in the agent's own console, run by the
app that recorded the query, and calls to another project's app followed to
its trace. Limits on one trace, and a store that keeps its issues whole.

The store's format changes: a project's local store starts empty after the
upgrade.

### Added

- `span_id:` finds the records logged in a span, and a record's details on
  the Logs page show its span, a filter away.
- A call an app of another project on this machine served shows under it in
  the call tree, opening in that project's console. Agents with a console
  say where they are in the user's cache (with a token only they and this
  user can read), and ask each other which of their traces served a call,
  by the W3C ids the call carried.
- EXPLAIN in the agent's own console: an app that says it can (in its
  hello) runs a recorded query's EXPLAIN on its database when the agent asks
  it, down the connection it sends its traces on. The agent writes the
  statement and reads the plan from the rows, for every SDK alike, and the
  console offers Explain once such an app is connected.
- `span:` finds traces by any of their spans' names, a view, a template or
  the app's own block, with `*` wildcards. Its hints name the spans that
  aren't calls (those have `call:`, `db:` and the rest).
- The agent stores a trace with at most 2,000 spans and 1,000 log records,
  whatever sent it: an SDK without limits of its own or OpenTelemetry. Its
  earliest spans are kept, each with its parent, and its first records. The
  Request tab says how many went (`tracepanel.dropped_spans`, `_logs`).
- A stored trace says when the agent received it (`received`): the Request
  tab says when the app's clock is off this machine's.
- A group's page picks its period, from the same presets and range as a
  list's Time, or by dragging over its calls chart.
- Tasks' System menu offers what ran this project's tasks (Celery, RQ,
  Spring's @Async, a RabbitMQ or Kafka listener), not Python's list.
- Logs: a record a task or a job wrote is found by its name, with the Task
  and Job filters or `task:` and `job:`, and `kind:` finds the records of
  each kind of trace. A task's record says it was a task's, with a button
  for every run of it, and opens the task.
- A search chip can be changed: click it, and it goes back into the box as
  text, Enter makes it a chip again.
- Logs know where in the work they were logged: each record keeps the span
  it was written in and the spans around it. `in:kafka`, `in:sql` or
  `in:view` finds the records logged inside such a call, `span:` inside a
  span by its name, and a record's details show the chain, each step a
  click away. `template:` finds every record written from the same message.
- A call's details in the call tree start with its fields in its system's
  words: a Kafka publish's topic, partition and offset, a RabbitMQ queue or
  exchange and routing key, a Redis command's key, a gRPC call's service and
  method. Every attribute follows, as recorded.
- A request's Request tab lists its own fields first and the traces linked
  to it after them, alike ones as one row: 36 deliveries to one listener are
  `×36`, with how many failed.

### Fixed

- A record's attributes came in another order on the Logs page than in its
  trace (the store keeps them sorted by name). Both list them the same way:
  where it was logged first, then its thread and template, its extra fields
  last.
- A record shows where it was logged, its code, thread, template and extra
  fields: picked in the call tree, or opened by a click on it in a trace's
  Logs tab, which shows it as the call tree does.
- A trace's Logs tab overlapped a record's time and level once the time was
  a clock. The line between the call tree and its pane runs down the whole
  view, however few the rows.
- A span whose parent never reached the agent (cut by a limit, lost on the
  way) was missing from the call tree: it shows under the request.
- An issue whose requests rotation removed pointed at a latest trace that
  was gone, and its page showed it as not found. An issue still counts
  every time it happened (its occurrences and first seen stay), its latest
  trace is the newest still stored, and with none left its page says they
  were rotated out. Links to the traces removed go with them.
- A group with one call, or calls a moment apart, gets a time axis of 10
  minutes, not one moment repeated.
- The services map shows whole, its lines' bends included: it scrolls only
  sideways, and a line routed around the boxes is inside the diagram.
- Stat tiles that don't fit one row split into two even ones, never one
  tile alone on the second.
- Enter in the search box took the first suggestion, not what was typed:
  `logger:org` became the first of the loggers starting with org. Enter
  takes what was typed, a suggestion only when the arrows picked one, and
  Tab the first. Typing the start of several values suggests all of them
  first, with a wildcard (`logger:org*`).
- A filter's menu found nothing when its key was typed in its box too
  (`logger:org` in the Logger menu).
- Typing a filter into the search box with pauses (`logger:o`) could empty
  it: the page took a search that matched nothing for an empty store and
  replaced the box. A filter still being typed stays out of the search.
- The logs' Route menu offers the routes whose requests logged anything,
  not every route. A filter's menu has one Clear.
- Emails is listed only once the app has sent one: only some frameworks
  send them through what an SDK records.
- The console asks what the backend behind it can do (`api/capabilities`):
  Explain shows only where EXPLAIN runs (the app serving the console, or a
  connected app that runs it for the agent), the user switcher only where
  the app can switch users (Django). Nothing asks for what can't answer.
- A stack's frames with no source are one line each, with nothing to open.
- A trace's Logs tab shows when each record was logged (14:03:21.146), the
  time since the request started on hover. The logs and emails lists name
  their last column Source and Sent from: a task's or a job's, not only a
  request's.

## 0.2.0 (2026-10-14)

Pages: what users do in a browser, each view and action over the requests it
made, in the console and in the panel. Apps in many more languages and
frameworks, the JVM's first.

### Added

- A Pages section in the console: each page a browser viewed, then what users
  did on it. A view is the page's load or an SPA's route change. An action is a
  click or a submit that called the API (`click "Save"`), or background calls
  nobody started. Each row has its count, failures, time and the calls it made
  to the API, opens its own page, and `page:` searches them. A trace of kind
  `page` comes from the browser: tracepanel-js records a page's views and
  actions with their `fetch()` calls, errors and console, and sends them to the
  console's address, `POST /api/ingest`, as an SDK sends its traces. A dev
  server (Vite's plugin) serves that address on the page's origin. The console
  takes JSON only, so a page on another site can't send to it.

- The panel lists what the user did in the browser when tracepanel-js
  records the page: each view and action (`click "Save"`) is a row, its
  requests under it, and opens with its calls, errors and console. Before
  the page's first request, the pill shows its view and load time, as it
  shows a server page's own load, and the runtime's mark it learned in the
  tab.

- A browser app in Services: its row opens Pages, the map draws its work as
  coming from Users, and `role:browser` finds it. An app recorded in the browser
  is labelled Browser.

- Apps in more languages and frameworks in the console, the panel and the
  services map. Java by its release (`Java 21 · Spring Boot 4.1`, `Java 8` for
  1.8) and Kotlin by Kotlin's own version. OpenTelemetry's other languages read
  as people write them (.NET, C++, PHP, Ruby, Rust, Swift, Erlang, and Deno by
  its runtime). Marks for Spring, Ktor, Quarkus, Rails, Laravel, Symfony,
  ASP.NET Core, Phoenix, Actix Web, Rocket, Vapor, Fastify, Koa, Hono, Gin,
  aiohttp and Falcon, and for those languages. A trace that comes over OTLP is
  labelled with its framework from the instrumentation that recorded it: these,
  and Micronaut, Vert.x, Javalin, Helidon, Play, Starlette, Tornado, Pyramid,
  hapi, Echo, Fiber, Sinatra, Slim and Axum.

### Changed

- The panel, the console and the services map show the mark of a Node.js
  app's framework: Express, NestJS, Next.js, Nuxt, or Node.js or Bun for a
  plain server. An app the JavaScript SDK traces is labelled Node 26 or Bun
  1.3, not by OpenTelemetry's language name, nodejs.
- A trace's SQL tab is named **DB**: the tabs fit on a narrower panel.
- Search reads a quote escaped inside a quoted value (`name:"/ › click
  \"Save\""`): an action's page, named after a button, lists its calls.
- The page widget shows the framework of the app that answered a page's
  calls when the page's server didn't name one (an SPA from a dev server),
  and the panel names a Node.js trace's runtime Node, not Nodejs.
- The console refreshes every 15 seconds by default, not every 5. A choice
  you made in its refresh menu stays.
- Before a page makes its first traced request (an SPA from a dev server),
  the widget's pill says "Waiting for requests", not `GET /` at 0 ms.
- An error's local variables line up: the names take the width of the
  longest one, not a third of the frame.
- Pages leads the entry points in the sidebar: work comes in from the browser,
  then its requests, then what they start.
- A view's or an action's trace is headed by what was done on which page (CLICK
  "Save" · /books), not by its path's first word.
- A span's attribute values wrap at spaces first, and the mono ones are the size
  of the text beside them.
- The services map's entries have a mark: a globe for Clients, a terminal for
  CLI · cron, people for Users.

### Fixed

- An app's runtime in Services and on the map is its latest trace's. After an
  upgrade it read the largest version string instead (Spring Boot 4.9 over
  4.10, Java 8 over 21), and could take the language and the framework from
  different traces. An upgraded app stays one app, as before.

- The page widget's text on a page that isn't in UTF-8: its arrows and dots
  came out garbled, as the agent served `widget.min.js` without a charset and
  the page read it in its own encoding. The agent names UTF-8 for every text
  file it serves now.

## 0.1.1 (2026-10-13)

### Changed

- The Services map fits the width it has until you pick a zoom yourself: a
  project with several apps no longer opens with its diagram cut off on the
  right.
- The Share dialog says what a file without values keeps: the trace's
  shape, timings and issues.
- The Issues page and the API describe the issues as they are now: N+1 and
  duplicate calls, slow queries and calls, blocking calls, transactions.
- The README and the PyPI page install with `pip install tracepanel`, with
  no `--pre`.

## 0.1.0 (2026-10-13)

### Added

- An RPC section in the console: the calls the app served over gRPC and
  other RPC systems, by method (`helloworld.Greeter/SayHello`), with calls,
  failures, p95 and a page per method, as the other entry points have. An
  OTLP root server span with `rpc.system` is a trace of the new kind `rpc`,
  named `Service/Method`, with `rpc.*` attributes. `GET /api/rpc` lists the
  methods, `/api/counts` counts them, and `rpc:` and `system:` search them.
- A new issue, `slow-call`: a datastore query (MongoDB, Elasticsearch,
  DynamoDB, Cassandra and the like) over `slow_sql_ms`, or an RPC call such
  as gRPC over `slow_http_ms`, which was a `slow-http` until now. A slow
  MongoDB query's hint names the index its filter and sort need, as the
  shell creates it (`db.users.createIndex({"email": 1})`): without one,
  MongoDB reads the whole collection (COLLSCAN in `explain()`).
- Share a trace as one HTML file. **Share** on a trace's page in the console,
  or its icon in the panel's bar, downloads the console itself with the trace
  and the traces linked to it inside: it opens in any browser, read-only, with
  no agent and no network (about 0.7 MB: the console inside is gzipped), for a
  teammate, a pull request or a bug report. By default it leaves out what
  stays local on the way to Tracepanel Cloud: query parameters, email bodies,
  a user's name and email, log fields and the local variables of errors.
  **Include values** keeps them, with the plans of slow queries. The agent
  serves the data at `GET /api/snapshot/{id}`.
- A new issue, `large-result`: a SELECT with no LIMIT that returned
  `large_result_rows` rows or more (1000 by default), as the SDK counts what
  was fetched (`db.response.returned_rows`, OpenTelemetry's name for it, which
  the OpenTelemetry mapping keeps). The hint says how to page or stream it.
- A slow query whose LIKE pattern starts with `%` (Django's `contains` and
  `icontains`) says why no index helps, and what to do instead: match the
  start, or a trigram index or full-text search.
- Two new issues. `queue-wait`: a task that waited in its queue longer
  than `queue_wait_ms` (1 s by default) before a worker took it, a sign the
  workers are all busy. `blocking-call`: SQL, an HTTP call, Redis or a cache
  call made synchronously on an event loop's thread (the SDK marks it), which
  makes every other request on the loop wait. One issue per place in the
  code, once its calls cost 5 ms together, with what to use instead.
- The agent takes OpenTelemetry spans over OTLP/HTTP (`--otlp`, by default
  127.0.0.1:4318, where exporters send them unless told otherwise), protobuf
  or JSON, gzipped or not. A service exporting with any OpenTelemetry SDK
  shows in the console with no Tracepanel SDK: each service's work for one
  request, task or command is a trace, its spans mapped by the semantic
  conventions and analyzed as an SDK's. A port in use is said and skipped.
- A trace links to the trace in another app that its call reached, by the
  W3C trace context the call carried: `called_by` on one, `calls` on the
  other, and the call tree shows the reached app's trace under the call. The
  architecture diagram draws an arrow from app to app in place of the
  server the caller saw (its HTTP host), and an app only other apps call
  has no clients arrow. `/api/services` lists these app links.
- Tiles above a system's page sum up its calls, all of them and with the
  page's filters: how many and in how many requests, their time and p95, how
  many per request (up to the most in one), how many failed (a click shows
  them), and a cache's hit rate. `/api/calls/summary` answers them.
- The Services page draws the project's architecture from its calls: where
  work comes in, the apps' roles framed by project, the servers they call,
  and an arrow per call, laid out left to right in layers (dagre), so a
  broker sits between the app that enqueues and the worker that takes.
  Arrows are thicker for more calls and red with failures, and one opens
  its traces. A box opens where its calls are listed, and hovering it brings
  out its arrows. "Copy as Mermaid" puts the same diagram on the clipboard
  for a README or an issue. A zoom is kept across visits, and the table
  below keeps the numbers.
- The services diagram and table show one card per server (its address and
  port), however many ways the app uses it: Redis as a datastore and as a
  cache backend is one card, "Cache redis · Database 1". Its calls are the
  server's: a cache's commands to Redis count once.
- Spans an OpenTelemetry instrumentation recorded are mapped by the agent,
  from the semantic conventions (older and current attribute names alike),
  so every SDK can send them as they are (kind `otel`). SQL becomes a query
  with its fingerprint and parameters, whichever form the instrumentation
  records them in, and gets the same issues as an SDK's own. So do Redis, HTTP
  calls and gRPC. MongoDB, Elasticsearch and OpenSearch, Cassandra, DynamoDB,
  Memcached, Kafka, RabbitMQ and SQS get a span kind each. A database, broker
  or RPC system the agent doesn't know gets its family's kind (`db`,
  `messaging`, `rpc`) under its own name, so it is never lost.
- One model for every call to another system: SQL, Redis, a cache,
  datastores, brokers, RPC and HTTP. Each system the app called gets a page,
  with the same columns and filters (time, target, operation, failed), and
  issues by its family's rules: N+1 and duplicates for any datastore or RPC
  system, a publish per item for a broker. A new system needs no code.
- The MCP tool `list_calls` lists the calls to any system (`system:redis`,
  `system:sql`) with the key `call:` finds their traces by.
- A trace has a tab for each list a request is most often opened for:
  Database (SQL with its plans), Cache, HTTP calls and Logs, each when the
  request has any. The calls to other systems (Redis used directly,
  MongoDB, a broker) are in the call tree, and the console has a page for
  each. A tile per system shows its calls and time. The Mail tab is gone:
  an email is in the call tree, and the Emails page lists them all.
- The call tree's details pane can be resized: drag its edge, or focus it
  and use the arrow keys. The width is kept, and a double click restores the
  default.
- The call tree's time breakdown and its filters are one row: a share of
  the time with rows in the tree (Database, Templates, Cache…) is a filter
  chip with their count, and Logs, Errors and the other filters follow it.

### Changed

- Repeats of a system's calls get that system's way to batch them: `$in` or
  `$lookup` for MongoDB, `_mget` and `_msearch` for Elasticsearch,
  `BatchGetItem` for DynamoDB, `SendMessageBatch` for SQS, a single flush for
  Kafka, confirms waited for once for RabbitMQ. Other systems keep their
  family's hint.
- A datastore call (MongoDB, Elasticsearch and the like) can keep its
  values apart from its statement, as SQL does: with `db.params_hash` on
  the span, two calls are the same only with the same values too. An SDK
  then puts the query's shape in `db.statement` and its values in
  `db.params`, which stay on this machine.
- Finding a trace's issues costs half what it did: the issues go into its
  document without parsing the whole document into a tree and writing it out
  again, which cost three times the analysis itself (Django's N+1 example:
  928 µs, now 413 µs).
- The console's lists read less. The calls lists (Database, Redis, Cache,
  HTTP and the other systems) count calls from one index, without reading the
  table: on 500 traces, 52 ms became 10 ms. The Services page, and the pages
  that group traces by an attribute (tasks, GraphQL, commands, WebSockets),
  read a trace's attributes from a column of their own rather than from its
  whole document: Services went from 65 ms to 2 ms.
- The store's format is version 19 (a trace's `attrs` column). The agent
  starts a new store file. The traces in the old one aren't carried over.
- Writing traces costs less. Each insert is prepared once rather than for
  every row, and a new trace no longer looks for rows of an earlier copy of
  itself. Rotating a full store deletes the oldest traces' rows by their ids,
  instead of reading every row of every table to find them. 200 traces into a
  store at its 2,000: 552 ms, now 210 ms.
- The store's format is now version 18: one table of calls in place of the
  tables for queries, HTTP calls, Redis and cache calls. A store from an
  earlier version is left as it is, and the agent starts a new, empty one.
- System pages live at `#/calls/<system>`, and `/api/calls?system=` lists any
  system's calls. `/api/queries`, `/api/redis` and `/api/cache` are gone, and
  `/api/calls` answers for every system, not only HTTP.
- The trace search takes `call:<key>` for a call to any system, SQL included.
  `query:`, `redis_call:` and `cache_call:` are gone.
- The MCP tool `list_queries` is now `list_calls`.
- `/api/counts` lists the systems with calls (`sections.systems`) in place of
  the `calls`, `redis` and `cache` flags, and `/api/values` gives each
  system's targets and operations in place of `host`, `redis` and `cache`.

### Fixed

- The panel no longer blinks through an empty pane when a new request
  arrives: the request on screen stays until the next one is loaded.
- The search palette's Go to lists every system's page, as the sidebar does,
  and the sidebar's list scrolls when it is taller than the window.
- The divider between the call tree and its details runs the full height.
- A trace received twice (sent again with late spans) counted its queries,
  calls and services twice.

## 0.0.1a2 (2026-10-12)

### Added

- The agent is on npm too, as `@tracepanel/agent`: `npx tracepanel-agent`
  runs the same binaries as the PyPI wheels, one package per platform.
- Redis is a span kind of its own, `redis`: a datastore, not a cache. A
  cache operation (`cache`, from any cache library) is a span of its own too,
  with its Redis commands as children when its backend is Redis. Issues are
  found on the layer they are fixed on: a cache N+1 on the cache operations,
  not again on their Redis commands.
- Outgoing HTTP calls, Redis commands and cache operations get the same
  analysis as SQL. Calls a loop makes to one endpoint
  (`GET api.example.com/users/{id}`) or one key pattern (`user:{id}`) are an
  N+1. The same read made twice is a duplicate. An HTTP call slower than
  `slow_http_ms` (500 ms by default) is a new issue, `slow-http`. Repeated Redis
  commands and cache operations are an issue only when they cost
  `n_plus_one_min_ms` (5 ms by default) together, by their median call: an
  in-memory store answers in a fraction of a millisecond.
- Three data pages next to Database: Redis, Cache and HTTP calls. Each lists
  what the app called, grouped by key pattern or endpoint, with the same
  columns (calls, requests, most in one request, failures, total and slowest
  time) and the same filters (time, where to, operation, failed). Redis also
  says what sent a command (the app, a cache, a task queue), and Cache its hit
  rate. Each shows in the sidebar once the app has used it, and links to the
  requests that made the call.
- Database gets the same filters: `op:` (SELECT, INSERT…) and `failed:`.
- In a trace: an HTTP calls tab, tiles with the Redis commands and HTTP calls,
  lanes on the timeline, "Redis" and "External calls" in the time breakdown (a
  cache's Redis commands count as Cache), and similar calls folded into one
  row of the call tree, like queries.

### Changed

- The store's format is now version 16. A store from an earlier version is
  left as it is, and the agent starts a new, empty one.

## 0.0.1a1 (2026-10-12)

The first release of the Tracepanel agent. It is an alpha: the store format
and the protocol can still change between versions.

### Added

- The agent receives the traces and logs of a project's processes over a
  local socket, or over TCP with `--listen tcp:HOST:PORT` (the default on
  Windows). There is one agent per project. The first trace starts it, and it
  exits after 30 minutes unused.
- It finds N+1 queries, duplicate and slow SQL, long transactions, work done
  inside a transaction, htmx mistakes and errors. Each issue names the line of
  code it comes from and the fix for the ORM in use.
- It keeps the newest traces in `.tracepanel/` in the project, and serves the
  panel, the console and their API on `127.0.0.1`. Several apps can share one
  store, and the console shows one app or all of them.
- The panel on your pages: a badge with the request's status, time, queries
  and issues, and a hover card. A click opens the panel, docked at the bottom
  or on the right. It lists every request the page made, `fetch()` calls
  included, each with its call tree, SQL, issues and logs. The call tree's
  details open beside a wide tree and under the row in a narrow one.
- The console at `/__tracepanel__/`: HTTP endpoints, GraphQL operations,
  background tasks, commands and WebSockets, the services an app calls, SQL,
  logs, emails, errors and issues, with charts over time. One search covers all
  of them, with filters such as `route:`, `status:`, `level>=warning` or
  `extra.order_id:42`.
- Logs, each line linked to the request, job or command that wrote it.
- `tracepanel-agent mcp` gives AI coding agents the traces over MCP: recent
  traces, one trace in a few lines, the next trace that matches, and a
  comparison of two traces. SQL parameters and local variables stay out unless
  you pass `--values`.
- Wheels for Linux (x86_64, arm64, armv7, armv6, i686, ppc64le, s390x,
  riscv64, glibc and musl), macOS (Apple silicon and Intel) and Windows
  (x86_64, x86, arm64), and an sdist for other platforms.
- The license is the Functional Source License (FSL-1.1-ALv2). This version
  becomes Apache License 2.0 two years after its release.
