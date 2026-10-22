//! A task run's workflow, from the `task_workflow` rows its attributes made: the runs of the tasks it follows and
//! of those that follow it, its root's, and its group's other tasks.

use super::*;
use rusqlite::OptionalExtension;
use std::collections::{HashSet, VecDeque};

/// How many of a group's other tasks a run's related traces list; `tasks` counts them all.
pub(crate) const GROUP_SHOWN: usize = 20;
/// How many runs a workflow's graph takes in: a bigger workflow is cut there, and its graph says so.
pub(crate) const GRAPH_RUNS: usize = 100;

/// A run's own workflow rows: role → values, in the order written.
type Rows = HashMap<String, Vec<String>>;

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
        let graph = self.graph(db, id)?;
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
            "graph": graph,
        }))
    }

    /// The whole workflow a run belongs to, as a graph: the latest run of each of its tasks (and each callback), the
    /// edges between them, and the traces that started it (a request, a command). Null for a workflow of one task.
    fn graph(&self, db: &Connection, id: &str) -> rusqlite::Result<Value> {
        let (rows, cut) = workflow_runs(db, id)?;
        let ids: Vec<String> = rows.keys().cloned().collect();
        let Value::Array(summaries) = self.summaries(&ids)? else {
            return Ok(Value::Null);
        };
        // Each task's runs as one node, its latest run's; a callback (no task id) is a node of its own.
        let mut order: Vec<String> = Vec::new();
        let mut nodes: HashMap<String, Node> = HashMap::new();
        let mut node_of: HashMap<String, String> = HashMap::new();
        for summary in summaries {
            let Some(trace) = summary["id"].as_str().map(str::to_owned) else {
                continue;
            };
            let own = &rows[&trace];
            let key = first_of(own, "id").unwrap_or(&trace).clone();
            let node = nodes.entry(key.clone()).or_insert_with(|| {
                order.push(key.clone());
                Node::default()
            });
            node.runs.push(trace.clone());
            node.summary = summary;
            node_of.insert(trace, key);
        }
        if nodes.len() < 2 {
            return Ok(Value::Null);
        }
        let latest = |key: &String| nodes[key].runs.last().cloned().unwrap_or_default();
        let mut edges: Vec<Edge> = Vec::new();
        // The tasks each follows: its parent and those it waited for.
        for key in &order {
            let own = &rows[&latest(key)];
            let kind = if own.contains_key("callback") {
                "callback"
            } else {
                "follows"
            };
            for task in own.get("follows").into_iter().flatten() {
                if nodes.contains_key(task) {
                    add_edge(&mut edges, latest(task), latest(key), kind);
                }
            }
        }
        // A run sent from inside another's that names no parent; and what started the workflow, from outside it.
        let mut origins: Vec<String> = Vec::new();
        for key in &order {
            let to = latest(key);
            let followed = edges.iter().any(|(_, b, _)| *b == to);
            for run in &nodes[key].runs {
                for by in enqueued_by(db, run)? {
                    match node_of.get(&by) {
                        Some(from) if from == key => {}
                        Some(from) => {
                            if !followed {
                                add_edge(&mut edges, latest(from), to.clone(), "sent");
                            }
                        }
                        None => {
                            if !followed {
                                if !origins.contains(&by) {
                                    origins.push(by.clone());
                                }
                                add_edge(&mut edges, by, to.clone(), "enqueued");
                            }
                        }
                    }
                }
            }
        }
        // A run that follows one of its group's tasks (a chord's callback) is not one of them.
        let member = |key: &String| -> Option<String> {
            let own = &rows[&latest(key)];
            let group = first_of(own, "group")?;
            let after_member = own.get("follows").into_iter().flatten().any(|task| {
                nodes.contains_key(task) && first_of(&rows[&latest(task)], "group") == Some(group)
            });
            (!after_member).then(|| group.clone())
        };
        let mut shown: Vec<Value> = self
            .summaries(&origins)?
            .as_array()
            .into_iter()
            .flatten()
            .map(|summary| {
                serde_json::json!({"trace": summary, "task_id": null, "group": null, "callback": null, "runs": 1})
            })
            .collect();
        // An origin that is gone from the store has no node: nor its edges.
        let known: HashSet<String> = shown
            .iter()
            .filter_map(|node| node["trace"]["id"].as_str().map(str::to_owned))
            .collect();
        edges.retain(|(from, _, kind)| *kind != "enqueued" || known.contains(from));
        for key in &order {
            let node = &nodes[key];
            let own = &rows[&latest(key)];
            shown.push(serde_json::json!({
                "trace": node.summary,
                "task_id": first_of(own, "id"),
                "group": member(key),
                "callback": first_of(own, "callback"),
                "runs": node.runs.len(),
            }));
        }
        let edges: Vec<Value> = edges
            .into_iter()
            .map(|(from, to, kind)| serde_json::json!({"from": from, "to": to, "kind": kind}))
            .collect();
        Ok(serde_json::json!({"nodes": shown, "edges": edges, "cut": cut}))
    }
}

/// An edge of a workflow's graph: from, to, and why (follows, callback, sent, enqueued).
type Edge = (String, String, &'static str);

/// An edge, once: two runs are linked by one edge, the first reason found.
fn add_edge(edges: &mut Vec<Edge>, from: String, to: String, kind: &'static str) {
    if from != to && !edges.iter().any(|(a, b, _)| *a == from && *b == to) {
        edges.push((from, to, kind));
    }
}

/// A node of a workflow's graph: its task's runs, oldest first, and the latest one's summary.
#[derive(Default)]
struct Node {
    runs: Vec<String>,
    summary: Value,
}

fn first_of<'a>(own: &'a Rows, role: &str) -> Option<&'a String> {
    own.get(role).and_then(|values| values.first())
}

/// The traces a run was enqueued by (its enqueued_by links).
fn enqueued_by(db: &Connection, trace: &str) -> rusqlite::Result<Vec<String>> {
    let mut statement = db.prepare_cached(
        "SELECT linked_trace FROM links WHERE trace_id = ?1 AND kind = 'enqueued_by'",
    )?;
    let rows = statement.query_map([trace], |row| row.get(0))?;
    rows.collect()
}

/// Every run of the workflow a run belongs to, each with its own rows, found from it: the runs of the tasks it
/// follows and of those that follow it, of its root and of the tasks rooted there, of its group. At most
/// GRAPH_RUNS of them; true when there were more.
fn workflow_runs(db: &Connection, id: &str) -> rusqlite::Result<(HashMap<String, Rows>, bool)> {
    let mut queue = VecDeque::from([id.to_owned()]);
    let mut seen = HashSet::from([id.to_owned()]);
    let mut asked: HashSet<(&str, String)> = HashSet::new();
    let mut rows = HashMap::new();
    while let Some(trace) = queue.pop_front() {
        if rows.len() >= GRAPH_RUNS {
            return Ok((rows, true));
        }
        let own = own_rows(db, &trace)?;
        let values = |role: &str| own.get(role).cloned().unwrap_or_default();
        let mut questions: Vec<(&str, String)> = Vec::new();
        for root in values("root") {
            questions.extend([("id", root.clone()), ("root", root)]);
        }
        questions.extend(values("follows").into_iter().map(|task| ("id", task)));
        questions.extend(values("group").into_iter().map(|group| ("group", group)));
        for task in values("id") {
            questions.extend([
                ("id", task.clone()),
                ("follows", task.clone()),
                ("root", task),
            ]);
        }
        for (role, value) in questions {
            if !asked.insert((role, value.clone())) {
                continue;
            }
            for (run, _) in runs_by(db, role, &value)? {
                if seen.insert(run.clone()) {
                    queue.push_back(run);
                }
            }
        }
        rows.insert(trace, own);
    }
    Ok((rows, false))
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

    /// A request: what started a workflow.
    fn request(id: &str, start: i64) -> Received {
        let doc = serde_json::json!({
            "id": id, "kind": "http", "name": "POST /jobs", "start": start, "duration": 1, "status": "ok",
            "attrs": {"service.name": "shop", "http.method": "POST", "http.route": "/jobs"}, "spans": [], "logs": [],
            "errors": [], "links": [], "issues": [],
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
        // The graph has asserts of its own.
        shown.as_object_mut().unwrap().remove("graph");
        shown
    }

    /// A run's workflow graph, its nodes by trace id (with their task, group, callback and runs) and its edges as
    /// [from, to, kind].
    fn graph(reader: &Reader, id: &str) -> Value {
        let related = reader.related(id).unwrap();
        let graph = &related["workflow"]["graph"];
        if graph.is_null() {
            return Value::Null;
        }
        let nodes: Vec<Value> = graph["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|node| {
                serde_json::json!([
                    node["trace"]["id"],
                    node["task_id"],
                    node["group"],
                    node["callback"],
                    node["runs"]
                ])
            })
            .collect();
        let edges: Vec<Value> = graph["edges"]
            .as_array()
            .unwrap()
            .iter()
            .map(|edge| serde_json::json!([edge["from"], edge["to"], edge["kind"]]))
            .collect();
        serde_json::json!({"nodes": nodes, "edges": edges, "cut": graph["cut"]})
    }

    #[test]
    fn a_chains_steps_follow_each_other_beside_their_enqueued_by_links() {
        // Each step is sent from inside the run before it: its enqueued_by link says so already.
        let (reader, dir) = store(
            "chain",
            &[
                request("R", 0),
                run("A", 1, serde_json::json!({"task.id": "a"}), Some("R")),
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

        // Every step's graph is the whole chain, from the request that started it.
        let chain = serde_json::json!({
            "nodes": [["R", null, null, null, 1], ["A", "a", null, null, 1], ["B", "b", null, null, 1],
                      ["C", "c", null, null, 1]],
            "edges": [["A", "B", "follows"], ["B", "C", "follows"], ["R", "A", "enqueued"]],
            "cut": false,
        });
        assert_eq!(graph(&reader, "A"), chain);
        assert_eq!(graph(&reader, "C"), chain);

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

        // One node per task, in the order the tasks first ran, its latest run's; the callback follows the group, not
        // one of its tasks.
        assert_eq!(
            graph(&reader, "G1"),
            serde_json::json!({
                "nodes": [["G1", "g1", "g", null, 1], ["G2R", "g2", "g", null, 2], ["G3", "g3", "g", null, 1],
                          ["CB", "cb", null, null, 1]],
                "edges": [["G3", "CB", "follows"]],
                "cut": false,
            })
        );
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

        assert_eq!(
            graph(&reader, "J0"),
            serde_json::json!({
                "nodes": [["J0", "j0", null, null, 1], ["J1", "j1", null, null, 1], ["J2", "j2", null, null, 1],
                          ["CB", null, null, "on_success", 1]],
                "edges": [["J1", "J2", "follows"], ["J0", "J2", "follows"], ["J1", "CB", "callback"]],
                "cut": false,
            })
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_big_workflows_graph_is_cut() {
        let members: Vec<Received> = (0..GRAPH_RUNS + 20)
            .map(|n| {
                let task = format!("t{n}");
                run(
                    &format!("T{n:03}"),
                    n as i64,
                    serde_json::json!({"task.id": task, "task.group_id": "g"}),
                    None,
                )
            })
            .collect();
        let (reader, dir) = store("cut", &members);
        let related = reader.related("T000").unwrap();
        let graph = &related["workflow"]["graph"];

        assert_eq!(graph["cut"], serde_json::json!(true));
        assert_eq!(graph["nodes"].as_array().unwrap().len(), GRAPH_RUNS);
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
