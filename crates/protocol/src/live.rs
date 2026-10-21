//! Tasks in flight: queued, running or waiting to be retried, as the apps' task events tell them, and the workers
//! that run them.
//!
//! An SDK sends a task's trace when the task ends; until then only these events say it exists. They come as a frame
//! that is an object, `{"tasks": [event, ...]}`, on the connection the app sends its traces on (an agent from before
//! ignores it). An event is small: `{"event": "enqueued" | "started" | "retried" | "finished" | "heartbeat",
//! "system": "celery", "id": ..., "time": ...}` and what the event knows (see [`TaskEvent`]). Any task queue sends
//! the same events: `system` says which one.
//!
//! They are kept in memory, never in the store: a task in flight is now, and a restarted agent starts empty. An entry
//! nobody spoke of for a while is dropped: a running task whose worker stopped sending heartbeats (killed, gone), a
//! queued one no worker took.

use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex, PoisonError};

/// A running task not seen for this long is gone: its worker sends a heartbeat every 30 seconds while it runs.
pub const RUNNING_STALE_US: i64 = 120_000_000;
/// A queued or retrying task not seen for this long is dropped: no worker takes from its queue, or it was lost.
pub const WAITING_STALE_US: i64 = 3_600_000_000;
/// A worker not heard from for this long leaves the list of workers.
pub const WORKER_STALE_US: i64 = 3_600_000_000;
/// A worker that ended a task this recently, with tasks of its queues still waiting, is still busy: between two
/// tasks it takes the next one (RQ forks a process for each, Celery acknowledges and fetches), and a console that
/// asks now and then would otherwise often find it idle while it works through a queue.
pub const BETWEEN_TASKS_US: i64 = 2_000_000;
/// How long a finished task's id is remembered: its enqueue, sent by another process, may come after it ended.
const FINISHED_KEPT_US: i64 = 600_000_000;
/// The most tasks kept: past it, new queued tasks are not added (a flood of them is still a flood without each).
const MAX_TASKS: usize = 10_000;

/// One event about a task, as the SDKs send it. Times are microseconds since the epoch.
#[derive(Debug, Deserialize)]
pub struct TaskEvent {
    /// `enqueued`, `started`, `retried`, `finished`, or `heartbeat` (a worker alive, with the tasks it runs: `ids`).
    pub event: String,
    #[serde(default)]
    pub system: String,
    /// The task's id; none for a heartbeat.
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    pub time: i64,
    #[serde(default)]
    pub queue: Option<String>,
    /// The worker that runs it (Celery's node name, `celery@host`).
    #[serde(default)]
    pub worker: Option<String>,
    /// How many times it was retried: before this attempt (`started`), with this retry (`retried`).
    #[serde(default)]
    pub retries: Option<i64>,
    /// Its arguments, as the SDK writes them for debugging (already cut short).
    #[serde(default)]
    pub args: Option<String>,
    #[serde(default)]
    pub kwargs: Option<String>,
    /// Why the last attempt failed (`retried`).
    #[serde(default)]
    pub error: Option<String>,
    /// The trace and span that enqueued it (`enqueued`, when sent inside one).
    #[serde(default)]
    pub trace_id: Option<String>,
    #[serde(default)]
    pub span_id: Option<String>,
    /// The tasks a heartbeat's worker process runs now.
    #[serde(default)]
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Queued,
    Running,
    Retrying,
}

impl State {
    fn name(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Retrying => "retrying",
        }
    }

    fn stale_after(self) -> i64 {
        match self {
            Self::Running => RUNNING_STALE_US,
            Self::Queued | Self::Retrying => WAITING_STALE_US,
        }
    }
}

#[derive(Debug, Clone)]
struct Task {
    id: String,
    system: String,
    name: String,
    service: String,
    state: State,
    queue: Option<String>,
    worker: Option<String>,
    enqueued_at: Option<i64>,
    started_at: Option<i64>,
    retries: i64,
    args: Option<String>,
    kwargs: Option<String>,
    error: Option<String>,
    enqueued_by: Option<(String, String)>,
    /// When the agent last heard of it (its own clock).
    seen: i64,
}

#[derive(Debug, Clone, Default)]
struct Worker {
    system: String,
    service: String,
    seen: i64,
    /// When it last ended a task (finished, or to be retried), on the agent's clock.
    ended: Option<i64>,
    /// The queues it took tasks from.
    queues: BTreeSet<String>,
}

#[derive(Default)]
struct Inner {
    tasks: HashMap<String, Task>,
    workers: HashMap<String, Worker>,
    finished: HashMap<String, i64>,
}

/// The tasks in flight and the workers seen, shared by the connections that receive events and the console.
#[derive(Clone, Default)]
pub struct LiveTasks {
    inner: Arc<Mutex<Inner>>,
}

pub fn now_us() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_micros() as i64)
}

impl LiveTasks {
    /// A frame's events, from the app of `service`; `now` is the agent's clock.
    pub fn take(&self, events: Vec<TaskEvent>, service: &str, now: i64) {
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        for event in events {
            inner.apply(event, service, now);
        }
        inner.prune(now);
    }

    /// The events of a frame that is an object, if it holds any (`{"tasks": [...]}`).
    pub fn events(frame: &Value) -> Option<Vec<TaskEvent>> {
        let events = frame.get("tasks")?.as_array()?;
        // One malformed event is skipped, not the frame.
        Some(
            events
                .iter()
                .filter_map(|event| serde_json::from_value(event.clone()).ok())
                .collect(),
        )
    }

    /// What `api/tasks/live` answers: the tasks in flight, newest first, and the workers with how many each runs;
    /// with `service`, that app's only.
    pub fn snapshot(&self, service: &str, now: i64) -> Value {
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        inner.prune(now);
        let mine = |of: &str| service.is_empty() || of == service;
        let mut tasks: Vec<&Task> = inner
            .tasks
            .values()
            .filter(|task| mine(&task.service))
            .collect();
        // Newest first; the id breaks ties, so a list that refreshes doesn't reorder.
        tasks.sort_by(|a, b| {
            let time = |task: &Task| task.started_at.or(task.enqueued_at).unwrap_or(0);
            time(b).cmp(&time(a)).then_with(|| a.id.cmp(&b.id))
        });
        let mut workers: Vec<(&String, &Worker)> = inner
            .workers
            .iter()
            .filter(|(_, worker)| mine(&worker.service))
            .collect();
        workers.sort_by(|a, b| a.0.cmp(b.0));
        json!({
            "now": now,
            "tasks": tasks.iter().map(|task| task.to_json()).collect::<Vec<_>>(),
            "workers": workers.iter().map(|(name, worker)| {
                let in_flight = inner.in_flight(name, worker, now);
                json!({
                    "name": name,
                    "system": worker.system,
                    "service": worker.service,
                    "last_seen": worker.seen,
                    "in_flight": in_flight,
                })
            }).collect::<Vec<_>>(),
        })
    }
    /// Whether there is anything in flight or a worker seen, of `service`'s app (every app's with ""): the console
    /// shows Tasks before a task's trace is stored.
    pub fn any(&self, service: &str, now: i64) -> bool {
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        inner.prune(now);
        let mine = |of: &str| service.is_empty() || of == service;
        inner.tasks.values().any(|task| mine(&task.service))
            || inner.workers.values().any(|worker| mine(&worker.service))
    }
}

impl Task {
    fn new(event: &TaskEvent, service: &str, now: i64) -> Self {
        Self {
            id: event.id.clone(),
            system: event.system.clone(),
            name: event.name.clone().unwrap_or_default(),
            service: service.to_owned(),
            state: State::Queued,
            queue: None,
            worker: None,
            enqueued_at: None,
            started_at: None,
            retries: 0,
            args: None,
            kwargs: None,
            error: None,
            enqueued_by: None,
            seen: now,
        }
    }

    /// What every event may tell: the name, the queue, the arguments, the attempt.
    fn learn(&mut self, event: TaskEvent) {
        if let Some(name) = event.name.filter(|name| !name.is_empty()) {
            self.name = name;
        }
        self.queue = event.queue.or(self.queue.take());
        self.args = event.args.or(self.args.take());
        self.kwargs = event.kwargs.or(self.kwargs.take());
        self.retries = event.retries.unwrap_or(self.retries);
        if let (Some(trace), Some(span)) = (event.trace_id, event.span_id) {
            self.enqueued_by = Some((trace, span));
        }
    }

    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "system": self.system,
            "name": self.name,
            "service": self.service,
            "state": self.state.name(),
            "queue": self.queue,
            "worker": self.worker,
            "enqueued_at": self.enqueued_at,
            "started_at": self.started_at,
            "retries": self.retries,
            "args": self.args,
            "kwargs": self.kwargs,
            "error": self.error,
            "enqueued_by": self.enqueued_by.as_ref().map(|(trace, span)| json!({"trace_id": trace, "span_id": span})),
        })
    }
}

impl Inner {
    fn apply(&mut self, event: TaskEvent, service: &str, now: i64) {
        if let Some(name) = &event.worker {
            let worker = self.workers.entry(name.clone()).or_default();
            worker.system.clone_from(&event.system);
            service.clone_into(&mut worker.service);
            worker.seen = now;
        }
        match event.event.as_str() {
            "heartbeat" => self.heartbeat(&event, now),
            "finished" => {
                let ran_on = self.tasks.remove(&event.id).and_then(|task| task.worker);
                self.ended(ran_on.or(event.worker), now);
                self.finished.insert(event.id, now);
            }
            "enqueued" => self.enqueued(event, service, now),
            "started" | "retried" => self.ran(event, service, now),
            _ => {}
        }
    }

    /// The tasks a worker process says it runs are alive, and run on that worker if no event said where.
    fn heartbeat(&mut self, event: &TaskEvent, now: i64) {
        for id in &event.ids {
            if let Some(task) = self.tasks.get_mut(id) {
                task.seen = now;
                if task.worker.is_none() {
                    task.worker.clone_from(&event.worker);
                }
            }
        }
    }

    /// A worker ended a task: it may take the next one from its queues at once (see [`BETWEEN_TASKS_US`]).
    fn ended(&mut self, worker: Option<String>, now: i64) {
        if let Some(worker) = worker.and_then(|name| self.workers.get_mut(&name)) {
            worker.ended = Some(now);
        }
    }

    /// How many tasks a worker runs now: the running tasks that are its own, or one while it goes from the task it
    /// ended to the next of its queues.
    fn in_flight(&self, name: &str, worker: &Worker, now: i64) -> usize {
        let running = self
            .tasks
            .values()
            .filter(|task| task.state == State::Running && task.worker.as_deref() == Some(name))
            .count();
        let between = worker
            .ended
            .is_some_and(|ended| now - ended < BETWEEN_TASKS_US)
            && self.tasks.values().any(|task| {
                task.state == State::Queued
                    && task.system == worker.system
                    && task.queue.as_ref().is_none_or(|queue| {
                        worker.queues.is_empty() || worker.queues.contains(queue)
                    })
            });
        running.max(usize::from(between))
    }

    fn enqueued(&mut self, event: TaskEvent, service: &str, now: i64) {
        // Sent by the process that enqueued it, it may come after the worker's events, even after it finished.
        if event.id.is_empty() || self.finished.contains_key(&event.id) {
            return;
        }
        if !self.tasks.contains_key(&event.id) && self.tasks.len() >= MAX_TASKS {
            return;
        }
        let time = event.time;
        let task = self
            .tasks
            .entry(event.id.clone())
            .or_insert_with(|| Task::new(&event, service, now));
        // A retry enqueues the task again: it is still waiting for its next attempt.
        task.enqueued_at = Some(time);
        task.seen = now;
        task.learn(event);
    }

    fn ran(&mut self, event: TaskEvent, service: &str, now: i64) {
        if event.id.is_empty() {
            return;
        }
        self.finished.remove(&event.id);
        let retried = event.event == "retried";
        let (time, worker, error) = (event.time, event.worker.clone(), event.error.clone());
        let task = self
            .tasks
            .entry(event.id.clone())
            .or_insert_with(|| Task::new(&event, service, now));
        task.service = service.to_owned();
        task.seen = now;
        task.worker = worker.or(task.worker.take());
        task.learn(event);
        if let Some(worker) = task
            .worker
            .as_ref()
            .and_then(|name| self.workers.get_mut(name))
        {
            worker.queues.extend(task.queue.clone());
            if retried {
                worker.ended = Some(now);
            }
        }
        if retried {
            task.state = State::Retrying;
            task.error = error;
        } else {
            task.state = State::Running;
            task.started_at = Some(time);
        }
    }

    fn prune(&mut self, now: i64) {
        self.tasks
            .retain(|_, task| now - task.seen < task.state.stale_after());
        self.workers
            .retain(|_, worker| now - worker.seen < WORKER_STALE_US);
        self.finished
            .retain(|_, finished| now - *finished < FINISHED_KEPT_US);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(value: Value) -> Vec<TaskEvent> {
        LiveTasks::events(&json!({ "tasks": value })).unwrap()
    }

    fn tasks(live: &LiveTasks, now: i64) -> Value {
        live.snapshot("", now)["tasks"].clone()
    }

    const T0: i64 = 1_800_000_000_000_000;

    #[test]
    fn a_task_goes_from_queued_to_running_and_leaves_when_it_finishes() {
        let live = LiveTasks::default();
        live.take(
            events(json!([{
                "event": "enqueued", "system": "celery", "id": "t1", "name": "shop.send_mail", "time": T0,
                "queue": "mail", "args": "(7,)", "kwargs": "{}", "trace_id": "TRACE", "span_id": "SPAN",
            }])),
            "shop",
            T0,
        );

        assert_eq!(
            live.snapshot("", T0 + 5),
            json!({
                "now": T0 + 5,
                "tasks": [{
                    "id": "t1", "system": "celery", "name": "shop.send_mail", "service": "shop", "state": "queued",
                    "queue": "mail", "worker": null, "enqueued_at": T0, "started_at": null, "retries": 0,
                    "args": "(7,)", "kwargs": "{}", "error": null,
                    "enqueued_by": {"trace_id": "TRACE", "span_id": "SPAN"},
                }],
                "workers": [],
            })
        );

        live.take(
            events(json!([{
                "event": "started", "system": "celery", "id": "t1", "name": "shop.send_mail", "time": T0 + 10,
                "worker": "celery@box", "retries": 0,
            }])),
            "shop-worker",
            T0 + 10,
        );
        let snapshot = live.snapshot("", T0 + 20);

        assert_eq!(snapshot["tasks"][0]["state"], "running");
        assert_eq!(snapshot["tasks"][0]["started_at"], T0 + 10);
        assert_eq!(snapshot["tasks"][0]["worker"], "celery@box");
        // What the enqueue told stays.
        assert_eq!(snapshot["tasks"][0]["enqueued_by"]["trace_id"], "TRACE");
        assert_eq!(
            snapshot["workers"],
            json!([{"name": "celery@box", "system": "celery", "service": "shop-worker", "last_seen": T0 + 10, "in_flight": 1}])
        );

        live.take(
            events(json!([{"event": "finished", "system": "celery", "id": "t1", "time": T0 + 30, "worker": "celery@box"}])),
            "shop-worker",
            T0 + 30,
        );
        let snapshot = live.snapshot("", T0 + 40);

        assert_eq!(snapshot["tasks"], json!([]));
        assert_eq!(snapshot["workers"][0]["in_flight"], 0);
    }

    fn in_flight(live: &LiveTasks, now: i64) -> Vec<(String, i64)> {
        live.snapshot("", now)["workers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|worker| {
                (
                    worker["name"].as_str().unwrap().to_owned(),
                    worker["in_flight"].as_i64().unwrap(),
                )
            })
            .collect()
    }

    fn take(live: &LiveTasks, now: i64, value: Value) {
        live.take(events(value), "shop", now);
    }

    #[test]
    fn an_rq_worker_stays_busy_between_the_jobs_of_its_queue() {
        let live = LiveTasks::default();
        let w = || ("w1".to_owned(), 0);
        take(
            &live,
            T0,
            json!([
                {"event": "heartbeat", "system": "rq", "time": T0, "worker": "w1", "ids": []},
                {"event": "enqueued", "system": "rq", "id": "j1", "name": "a", "time": T0, "queue": "default"},
                {"event": "enqueued", "system": "rq", "id": "j2", "name": "a", "time": T0, "queue": "default"},
            ]),
        );

        assert_eq!(in_flight(&live, T0 + 1), [w()]);

        // A work horse runs j1; the worker's own heartbeat, between, has no ids.
        take(
            &live,
            T0 + 10,
            json!([{"event": "started", "system": "rq", "id": "j1", "time": T0 + 10, "worker": "w1", "queue": "default"}]),
        );
        take(
            &live,
            T0 + 20,
            json!([{"event": "heartbeat", "system": "rq", "time": T0 + 20, "worker": "w1", "ids": []}]),
        );

        assert_eq!(in_flight(&live, T0 + 30), [("w1".to_owned(), 1)]);

        // j1 ends; until the next horse starts j2 the worker goes on with its queue.
        take(
            &live,
            T0 + 40,
            json!([{"event": "finished", "system": "rq", "id": "j1", "time": T0 + 40, "worker": "w1"}]),
        );

        assert_eq!(in_flight(&live, T0 + 50), [("w1".to_owned(), 1)]);
        assert_eq!(in_flight(&live, T0 + 40 + BETWEEN_TASKS_US), [w()]);

        take(
            &live,
            T0 + 60,
            json!([{"event": "started", "system": "rq", "id": "j2", "time": T0 + 60, "worker": "w1", "queue": "default"}]),
        );

        assert_eq!(in_flight(&live, T0 + 70), [("w1".to_owned(), 1)]);

        // The last job of the queue ends: nothing waits, the worker is idle at once.
        take(
            &live,
            T0 + 80,
            json!([{"event": "finished", "system": "rq", "id": "j2", "time": T0 + 80, "worker": "w1"}]),
        );

        assert_eq!(in_flight(&live, T0 + 90), [w()]);
    }

    #[test]
    fn a_worker_is_not_busy_with_another_queue_s_tasks() {
        let live = LiveTasks::default();
        take(
            &live,
            T0,
            json!([
                {"event": "enqueued", "system": "rq", "id": "j1", "name": "a", "time": T0, "queue": "mail"},
                {"event": "enqueued", "system": "rq", "id": "j2", "name": "a", "time": T0, "queue": "reports"},
                {"event": "started", "system": "rq", "id": "j1", "time": T0, "worker": "w1", "queue": "mail"},
                {"event": "finished", "system": "rq", "id": "j1", "time": T0 + 1, "worker": "w1"},
            ]),
        );

        assert_eq!(in_flight(&live, T0 + 2), [("w1".to_owned(), 0)]);
    }

    #[test]
    fn a_celery_worker_counts_the_tasks_its_processes_run() {
        let live = LiveTasks::default();
        take(
            &live,
            T0,
            json!([
                {"event": "started", "system": "celery", "id": "t1", "time": T0, "worker": "celery@box", "queue": "celery"},
                {"event": "started", "system": "celery", "id": "t2", "time": T0, "worker": "celery@box", "queue": "celery"},
                {"event": "started", "system": "celery", "id": "t3", "time": T0, "worker": "celery@box", "queue": "celery"},
                {"event": "enqueued", "system": "celery", "id": "t4", "name": "a", "time": T0, "queue": "celery"},
            ]),
        );

        assert_eq!(in_flight(&live, T0 + 1), [("celery@box".to_owned(), 3)]);

        take(
            &live,
            T0 + 10,
            json!([
                {"event": "heartbeat", "system": "celery", "time": T0 + 10, "worker": "celery@box", "ids": ["t1", "t2"]},
                {"event": "finished", "system": "celery", "id": "t3", "time": T0 + 10, "worker": "celery@box"},
            ]),
        );

        assert_eq!(in_flight(&live, T0 + 11), [("celery@box".to_owned(), 2)]);

        take(
            &live,
            T0 + 20,
            json!([
                {"event": "finished", "system": "celery", "id": "t1", "time": T0 + 20, "worker": "celery@box"},
                {"event": "finished", "system": "celery", "id": "t2", "time": T0 + 20, "worker": "celery@box"},
            ]),
        );

        // t4 waits: the worker is about to take it.
        assert_eq!(in_flight(&live, T0 + 21), [("celery@box".to_owned(), 1)]);

        take(
            &live,
            T0 + 30,
            json!([
                {"event": "started", "system": "celery", "id": "t4", "time": T0 + 30, "worker": "celery@box", "queue": "celery"},
                {"event": "finished", "system": "celery", "id": "t4", "time": T0 + 40, "worker": "celery@box"},
            ]),
        );

        assert_eq!(in_flight(&live, T0 + 41), [("celery@box".to_owned(), 0)]);
    }

    #[test]
    fn a_heartbeat_tells_the_worker_of_a_task_started_without_one() {
        let live = LiveTasks::default();
        take(
            &live,
            T0,
            json!([{"event": "started", "system": "rq", "id": "j1", "name": "a", "time": T0}]),
        );

        assert_eq!(in_flight(&live, T0 + 1), Vec::<(String, i64)>::new());

        take(
            &live,
            T0 + 10,
            json!([{"event": "heartbeat", "system": "rq", "time": T0 + 10, "worker": "w1", "ids": ["j1"]}]),
        );

        assert_eq!(in_flight(&live, T0 + 11), [("w1".to_owned(), 1)]);
        assert_eq!(tasks(&live, T0 + 11)[0]["worker"], "w1");

        // A retry ends the attempt.
        take(
            &live,
            T0 + 20,
            json!([{"event": "retried", "system": "rq", "id": "j1", "time": T0 + 20, "retries": 1}]),
        );

        assert_eq!(in_flight(&live, T0 + 21), [("w1".to_owned(), 0)]);
    }

    #[test]
    fn any_says_whether_an_app_has_tasks_in_flight_or_workers() {
        let live = LiveTasks::default();
        assert!(!live.any("", T0));

        live.take(
            events(json!([{"event": "heartbeat", "system": "rq", "time": T0, "worker": "w1", "ids": []}])),
            "shop",
            T0,
        );

        assert!(live.any("", T0 + 1));
        assert!(live.any("shop", T0 + 1));
        assert!(!live.any("blog", T0 + 1));
        // A worker not heard from for an hour is gone, and with it the app's live data.
        assert!(!live.any("shop", T0 + WORKER_STALE_US));
    }

    #[test]
    fn an_enqueue_that_comes_after_the_task_finished_is_ignored() {
        let live = LiveTasks::default();
        live.take(
            events(json!([
                {"event": "started", "id": "t1", "name": "a", "time": T0, "worker": "w"},
                {"event": "finished", "id": "t1", "time": T0 + 1, "worker": "w"},
            ])),
            "",
            T0,
        );
        live.take(
            events(json!([{"event": "enqueued", "id": "t1", "name": "a", "time": T0}])),
            "",
            T0 + 2,
        );

        assert_eq!(tasks(&live, T0 + 3), json!([]));
    }

    #[test]
    fn a_retry_waits_with_its_error_until_the_next_attempt() {
        let live = LiveTasks::default();
        live.take(
            events(json!([
                {"event": "started", "id": "t1", "name": "a", "time": T0, "worker": "w", "retries": 0},
                // Celery sends the task again before it tells of the retry, both from the worker.
                {"event": "enqueued", "id": "t1", "name": "a", "time": T0 + 1, "retries": 1},
                {"event": "retried", "id": "t1", "time": T0 + 2, "worker": "w", "retries": 1, "error": "ConnectionError('down')"},
            ])),
            "",
            T0,
        );
        let waiting = tasks(&live, T0 + 3);

        assert_eq!(
            (
                &waiting[0]["state"],
                &waiting[0]["retries"],
                &waiting[0]["error"]
            ),
            (
                &json!("retrying"),
                &json!(1),
                &json!("ConnectionError('down')")
            )
        );

        live.take(
            events(json!([{"event": "started", "id": "t1", "time": T0 + 4, "worker": "w", "retries": 1}])),
            "",
            T0 + 4,
        );

        assert_eq!(tasks(&live, T0 + 5)[0]["state"], "running");
    }

    #[test]
    fn a_running_task_without_heartbeats_goes_stale() {
        let live = LiveTasks::default();
        live.take(
            events(json!([
                {"event": "started", "id": "kept", "name": "a", "time": T0, "worker": "w"},
                {"event": "started", "id": "lost", "name": "a", "time": T0, "worker": "w"},
            ])),
            "",
            T0,
        );
        // The worker process that runs `kept` still beats; the one that ran `lost` was killed.
        live.take(
            events(json!([{"event": "heartbeat", "time": T0, "worker": "w", "ids": ["kept"]}])),
            "",
            T0 + RUNNING_STALE_US / 2,
        );
        let ids = |now| {
            tasks(&live, now)
                .as_array()
                .unwrap()
                .iter()
                .map(|task| task["id"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        };

        assert_eq!(ids(T0 + RUNNING_STALE_US), ["kept"]);
        assert_eq!(ids(T0 + RUNNING_STALE_US * 2), Vec::<String>::new());
    }

    #[test]
    fn a_queued_task_waits_longer_and_a_silent_worker_leaves() {
        let live = LiveTasks::default();
        live.take(
            events(json!([
                {"event": "enqueued", "id": "t1", "name": "a", "time": T0},
                {"event": "heartbeat", "time": T0, "worker": "w"},
            ])),
            "",
            T0,
        );
        let later = T0 + RUNNING_STALE_US * 2;

        assert_eq!(live.snapshot("", later)["tasks"][0]["state"], "queued");
        assert_eq!(live.snapshot("", later)["workers"][0]["name"], "w");

        let gone = T0 + WAITING_STALE_US.max(WORKER_STALE_US);

        assert_eq!(live.snapshot("", gone)["tasks"], json!([]));
        assert_eq!(live.snapshot("", gone)["workers"], json!([]));
    }

    #[test]
    fn one_app_s_tasks_with_service() {
        let live = LiveTasks::default();
        live.take(
            events(json!([{"event": "enqueued", "id": "t1", "name": "a", "time": T0}])),
            "shop",
            T0,
        );
        live.take(
            events(json!([{"event": "enqueued", "id": "t2", "name": "b", "time": T0}])),
            "blog",
            T0,
        );

        assert_eq!(live.snapshot("blog", T0)["tasks"][0]["id"], "t2");
        assert_eq!(
            live.snapshot("blog", T0)["tasks"].as_array().unwrap().len(),
            1
        );
        assert_eq!(tasks(&live, T0).as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_malformed_event_is_skipped_and_other_objects_are_no_events() {
        assert_eq!(
            events(json!([{"event": "started"}, {"event": "enqueued", "id": "t", "time": 1}]))
                .len(),
            1
        );
        assert!(LiveTasks::events(&json!({"answer": 1})).is_none());
    }
}
