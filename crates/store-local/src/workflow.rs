//! A task run's workflow, from the `task_workflow` rows its attributes made: the runs of the tasks it follows and
//! of those that follow it, its root's, and its group's other tasks.

use super::*;
use rusqlite::OptionalExtension;

/// How many of a group's other tasks a run's related traces list; `tasks` counts them all.
pub(crate) const GROUP_SHOWN: usize = 20;

/// Runs, oldest first, each with its task id (none for a callback, which has none of its own).
type Runs = Vec<(String, Option<String>)>;

/// The latest run of each, in the order their tasks first ran: a retried task is its last attempt.
fn latest(runs: Runs) -> Vec<(String, Option<String>)> {
    let mut order: Vec<String> = Vec::new();
    let mut last: HashMap<String, (String, Option<String>)> = HashMap::new();
    for (trace, task) in runs {
        let key = task.clone().unwrap_or_else(|| trace.clone());
        if !last.contains_key(&key) {
            order.push(key.clone());
        }
        last.insert(key, (trace, task));
    }
    order
        .into_iter()
        .filter_map(|key| last.remove(&key))
        .collect()
}

fn runs(db: &Connection, sql: &str, value: &str) -> rusqlite::Result<Runs> {
    let mut statement = db.prepare(sql)?;
    let rows = statement.query_map([value], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect()
}

/// The runs whose `role` row says `value`, and that `also` holds of, oldest first, with their task ids.
fn runs_where(db: &Connection, role: &str, value: &str, also: &str) -> rusqlite::Result<Runs> {
    runs(
        db,
        &format!(
            "SELECT w.trace_id, i.value FROM task_workflow w JOIN traces t ON t.id = w.trace_id \
             LEFT JOIN task_workflow i ON i.trace_id = w.trace_id AND i.role = 'id' \
             WHERE w.role = '{role}' AND w.value = ?1 AND {also} ORDER BY t.start"
        ),
        value,
    )
}

fn runs_by(db: &Connection, role: &str, value: &str) -> rusqlite::Result<Runs> {
    runs_where(db, role, value, "1 = 1")
}

/// Of a group's rows (`w`), its tasks' runs: not one that follows another of them, as a chord's callback follows
/// its header's last task.
pub(crate) const GROUP_MEMBER: &str = "NOT EXISTS (SELECT 1 FROM task_workflow f \
     JOIN task_workflow s ON s.role = 'id' AND s.value = f.value \
     JOIN task_workflow g ON g.trace_id = s.trace_id AND g.role = 'group' AND g.value = w.value \
     WHERE f.trace_id = w.trace_id AND f.role = 'follows')";

fn group_runs(db: &Connection, group: &str) -> rusqlite::Result<Runs> {
    runs_where(db, "group", group, GROUP_MEMBER)
}

/// The latest stored run of each of these tasks, by task id.
fn runs_of(db: &Connection, tasks: &[String]) -> rusqlite::Result<serde_json::Map<String, Value>> {
    let mut found = serde_json::Map::new();
    for task in tasks {
        let last = runs_by(db, "id", task)?.pop();
        if let Some((trace, _)) = last {
            found.insert(task.clone(), Value::from(trace));
        }
    }
    Ok(found)
}

/// This trace's own rows: its role → values, in the order written.
fn own_rows(db: &Connection, id: &str) -> rusqlite::Result<HashMap<String, Vec<String>>> {
    let mut statement =
        db.prepare("SELECT role, value FROM task_workflow WHERE trace_id = ?1 ORDER BY rowid")?;
    let mut own: HashMap<String, Vec<String>> = HashMap::new();
    for row in statement.query_map([id], |row| Ok((row.get(0)?, row.get(1)?)))? {
        let (role, value): (String, String) = row?;
        own.entry(role).or_default().push(value);
    }
    Ok(own)
}

/// What the links already list: the trace that enqueued this one and those it enqueued.
pub(crate) struct Linked<'a> {
    pub(crate) by: Option<&'a String>,
    pub(crate) enqueued: &'a [String],
}

impl Reader {
    /// The traces in this order, oldest first.
    fn summaries(&self, ids: &[String]) -> rusqlite::Result<Value> {
        if ids.is_empty() {
            return Ok(Value::Array(Vec::new()));
        }
        let mut found = self.list_traces(ids, ids.len() as i64)?;
        found.sort_by_key(|item| item["start"].as_i64().unwrap_or_default());
        Ok(Value::Array(found))
    }

    /// A run's group: its id, how many tasks it has, whether this run is one of them (not when it follows them), and
    /// the latest runs of the others.
    fn group(
        &self,
        db: &Connection,
        group: &str,
        id: &str,
        task: Option<&String>,
    ) -> rusqlite::Result<Value> {
        let members = latest(group_runs(db, group)?);
        let this = |(trace, of): &&(String, Option<String>)| {
            trace == id || (of.is_some() && of.as_ref() == task)
        };
        let others: Vec<String> = members
            .iter()
            .filter(|member| !this(member))
            .map(|(trace, _)| trace.clone())
            .take(GROUP_SHOWN)
            .collect();
        Ok(serde_json::json!({
            "id": group,
            "tasks": members.len(),
            "member": members.iter().any(|member| this(&member)),
            "runs": self.summaries(&others)?,
        }))
    }

    /// A task run's workflow beside what its links list (a step sent from inside the run before it is its
    /// `enqueued_by`): the runs of the tasks it follows, of those that follow it and of its root, its group, and
    /// which of the runs it leads to are callbacks. Null when it is in no workflow.
    pub(crate) fn workflow(
        &self,
        db: &Connection,
        id: &str,
        linked: &Linked<'_>,
    ) -> rusqlite::Result<Value> {
        let own = own_rows(db, id)?;
        let first = |role: &str| own.get(role).and_then(|values| values.first());
        let task = first("id");
        let following = match task {
            Some(task) => latest(runs_by(db, "follows", task)?),
            None => Vec::new(),
        };
        let rooted = match task {
            Some(task) => !runs_by(db, "root", task)?.is_empty(),
            None => false,
        };
        if own.keys().all(|role| role == "id") && following.is_empty() && !rooted {
            return Ok(Value::Null);
        }
        let follows = own.get("follows").cloned().unwrap_or_default();
        let root = first("root").filter(|root| Some(*root) != task);
        let named: Vec<String> = follows.iter().chain(root).cloned().collect();
        let runs = runs_of(db, &named)?;
        let shown = |trace: &String| trace != id && Some(trace) != linked.by;
        let before: Vec<String> = follows
            .iter()
            .filter_map(|task| runs.get(task)?.as_str().map(str::to_owned))
            .filter(shown)
            .collect();
        let root_run = root
            .and_then(|root| runs.get(root)?.as_str().map(str::to_owned))
            .filter(|trace| shown(trace) && !before.contains(trace));
        let after: Vec<String> = following
            .into_iter()
            .map(|(trace, _)| trace)
            .filter(|trace| trace != id && !linked.enqueued.contains(trace))
            .take(RELATED_LIMIT as usize)
            .collect();
        let group = match first("group") {
            Some(group) => self.group(db, group, id, task)?,
            None => Value::Null,
        };
        let callbacks = callbacks(db, linked.enqueued.iter().chain(&after))?;
        Ok(serde_json::json!({
            "task_id": task,
            "runs": runs,
            "root": match root_run {
                Some(trace) => self.list_traces(&[trace], 1)?.into_iter().next().unwrap_or(Value::Null),
                None => Value::Null,
            },
            "follows": self.summaries(&before)?,
            "followed_by": self.summaries(&after)?,
            "group": group,
            "callbacks": callbacks,
        }))
    }
}

/// Which of these runs are callbacks (RQ's on_success, on_failure, on_stopped), by trace id.
fn callbacks<'a>(
    db: &Connection,
    traces: impl Iterator<Item = &'a String>,
) -> rusqlite::Result<serde_json::Map<String, Value>> {
    let mut statement = db.prepare_cached(
        "SELECT value FROM task_workflow WHERE trace_id = ?1 AND role = 'callback'",
    )?;
    let mut found = serde_json::Map::new();
    for trace in traces {
        let kind: Option<String> = statement.query_row([trace], |row| row.get(0)).optional()?;
        if let Some(kind) = kind {
            found.insert(trace.clone(), Value::from(kind));
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A task run: its id, start, workflow attributes and the run or request that enqueued it.
    fn run(id: &str, start: i64, attrs: Value, enqueued_by: Option<&str>) -> Received {
        let links: Vec<Value> = enqueued_by
            .map(|by| serde_json::json!({"kind": "enqueued_by", "trace_id": by, "span_id": "S"}))
            .into_iter()
            .collect();
        let mut all = serde_json::json!({"service.name": "shop", "task.system": "celery", "task.state": "SUCCESS"});
        all.as_object_mut()
            .unwrap()
            .extend(attrs.as_object().unwrap().clone());
        let doc = serde_json::json!({
            "id": id, "kind": "task", "name": format!("jobs.{id}"), "start": start, "duration": 1, "status": "ok",
            "attrs": all, "spans": [], "logs": [], "errors": [], "links": links, "issues": [],
        });
        Received {
            trace: serde_json::from_value(doc.clone()).unwrap(),
            doc: doc.to_string(),
        }
    }

    fn store(name: &str, traces: &[Received]) -> (Reader, PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("tracepanel-workflow-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = path_in(&dir);
        Store::open(&path).unwrap().write(traces).unwrap();
        (Reader::new(&path), dir)
    }

    /// The ids of a list of traces, or of one.
    fn ids(value: &Value) -> Value {
        match value {
            Value::Array(items) => items.iter().map(|item| item["id"].clone()).collect(),
            Value::Object(_) => value["id"].clone(),
            _ => Value::Null,
        }
    }

    /// What a run's workflow says, its traces by id.
    fn workflow(reader: &Reader, id: &str) -> Value {
        let related = reader.related(id).unwrap();
        let Some(workflow) = related.get("workflow") else {
            return Value::Null;
        };
        let mut shown = workflow.clone();
        for key in ["root", "follows", "followed_by"] {
            shown[key] = ids(&workflow[key]);
        }
        if workflow["group"].is_object() {
            shown["group"]["runs"] = ids(&workflow["group"]["runs"]);
        }
        shown
    }

    #[test]
    fn a_chains_steps_follow_each_other_beside_their_enqueued_by_links() {
        // Each step is sent from inside the run before it: its enqueued_by link says so already.
        let (reader, dir) = store(
            "chain",
            &[
                run("A", 1, serde_json::json!({"task.id": "a"}), None),
                run(
                    "B",
                    2,
                    serde_json::json!({"task.id": "b", "task.parent_id": "a", "task.root_id": "a"}),
                    Some("A"),
                ),
                run(
                    "C",
                    3,
                    serde_json::json!({"task.id": "c", "task.parent_id": "b", "task.root_id": "a"}),
                    Some("B"),
                ),
                run("X", 4, serde_json::json!({"task.id": "x"}), None),
            ],
        );

        assert_eq!(
            workflow(&reader, "A"),
            serde_json::json!({"task_id": "a", "runs": {}, "root": null, "follows": [], "followed_by": [],
                               "group": null, "callbacks": {}})
        );
        assert_eq!(
            workflow(&reader, "B"),
            serde_json::json!({"task_id": "b", "runs": {"a": "A"}, "root": null, "follows": [], "followed_by": [],
                               "group": null, "callbacks": {}})
        );
        assert_eq!(
            workflow(&reader, "C"),
            serde_json::json!({"task_id": "c", "runs": {"b": "B", "a": "A"}, "root": "A", "follows": [],
                               "followed_by": [], "group": null, "callbacks": {}})
        );

        // A task in no workflow has none.
        assert_eq!(reader.related("X").unwrap().get("workflow"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_groups_tasks_list_each_other_and_its_chord_callback_follows_them() {
        let member =
            |id: &str, task: &str| serde_json::json!({"task.id": task, "task.group_id": id});
        let (reader, dir) = store(
            "group",
            &[
                run("G1", 1, member("g", "g1"), None),
                // g2 failed, then its retry succeeded: the group shows the retry.
                run("G2", 2, member("g", "g2"), None),
                run("G2R", 5, member("g", "g2"), None),
                run("G3", 3, member("g", "g3"), None),
                run(
                    "CB",
                    6,
                    serde_json::json!({"task.id": "cb", "task.parent_id": "g3", "task.root_id": "g3",
                                       "task.group_id": "g"}),
                    Some("G3"),
                ),
            ],
        );
        let page: Vec<Value> = reader
            .search_traces("group:g", 50, None)
            .unwrap()
            .items
            .iter()
            .map(|trace| trace["id"].clone())
            .collect();

        assert_eq!(
            workflow(&reader, "G1"),
            serde_json::json!({"task_id": "g1", "runs": {}, "root": null, "follows": [], "followed_by": [],
                               "group": {"id": "g", "tasks": 3, "member": true, "runs": ["G3", "G2R"]}, "callbacks": {}})
        );
        // The callback follows the group: it is not one of its tasks.
        assert_eq!(
            workflow(&reader, "CB"),
            serde_json::json!({"task_id": "cb", "runs": {"g3": "G3"}, "root": null, "follows": [], "followed_by": [],
                               "group": {"id": "g", "tasks": 3, "member": false, "runs": ["G1", "G3", "G2R"]}, "callbacks": {}})
        );

        // Its tasks' runs, retries too, newest first: not the callback.
        assert_eq!(page, ["G2R", "G3", "G2", "G1"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_job_that_waited_for_another_follows_it_and_a_callback_says_which_it_is() {
        // RQ: J2 was enqueued by a request with depends_on=[j1, j0]; J1's on_success callback ran from J1's run.
        let (reader, dir) = store(
            "depends",
            &[
                run("J0", 1, serde_json::json!({"task.id": "j0"}), None),
                run("J1", 2, serde_json::json!({"task.id": "j1"}), None),
                run(
                    "J2",
                    3,
                    serde_json::json!({"task.id": "j2", "task.parent_id": "j1", "task.root_id": "j1",
                                       "task.depends_on": ["j1", "j0"]}),
                    None,
                ),
                run(
                    "CB",
                    4,
                    serde_json::json!({"task.parent_id": "j1", "task.root_id": "j1", "task.callback": "on_success"}),
                    Some("J1"),
                ),
            ],
        );
        let related = reader.related("J1").unwrap();

        assert_eq!(
            workflow(&reader, "J2"),
            serde_json::json!({"task_id": "j2", "runs": {"j1": "J1", "j0": "J0"}, "root": null,
                               "follows": ["J0", "J1"], "followed_by": [], "group": null, "callbacks": {}})
        );
        assert_eq!(
            workflow(&reader, "J1"),
            serde_json::json!({"task_id": "j1", "runs": {}, "root": null, "follows": [], "followed_by": ["J2"],
                               "group": null, "callbacks": {"CB": "on_success"}})
        );
        assert_eq!(
            workflow(&reader, "J0"),
            serde_json::json!({"task_id": "j0", "runs": {}, "root": null, "follows": [], "followed_by": ["J2"],
                               "group": null, "callbacks": {}})
        );

        // The callback is listed once: the run it was enqueued from lists it.
        assert_eq!(ids(&related["enqueued"]), serde_json::json!(["CB"]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_snapshot_carries_a_runs_workflow() {
        let (reader, dir) = store(
            "snapshot",
            &[
                run("A", 1, serde_json::json!({"task.id": "a"}), None),
                run(
                    "B",
                    2,
                    serde_json::json!({"task.id": "b", "task.depends_on": ["a"]}),
                    None,
                ),
            ],
        );
        let snapshot = reader.snapshot("B", true).unwrap().unwrap();
        let mut traces: Vec<&String> = snapshot["traces"].as_object().unwrap().keys().collect();
        traces.sort();

        assert_eq!(traces, ["A", "B"]);
        assert_eq!(
            ids(&snapshot["related"]["A"]["workflow"]["followed_by"]),
            serde_json::json!(["B"])
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
