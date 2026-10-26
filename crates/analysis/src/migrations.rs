//! A migrate command's migrations: each migration it applied or unapplied a `migration` span, `migrate shop
//! 0012_add_sku`, with its attributes under `migration.` (`app`, `name`, `direction`, `atomic`, `fake`,
//! `operations`); each operation that ran a `migration.operation` span inside, `AddIndex Product.sku_idx`, with the
//! operation's class (`migration.operation`), its `description`, whether it was `atomic`, the `rows` it changed and,
//! when it locks or rewrites a table on the database it ran on or can't be undone, why (`migration.risk`). The SQL it
//! ran is under it. The trace has the plan (`migrate.plan`, `migrate.planned`, `migrate.applied`,
//! `migrate.unapplied`).
//!
//! SDKs that predate the kinds send both as `function` spans: they become the kinds here, before the issues are found
//! and the trace is stored. An operation with a risk in a migration applied for real (not faked, not unapplied) is an
//! issue, `migration-risk`: the migration is about to run the same way where the table is large and busy.

use super::{issue, issue_key, text, truthy};
use std::collections::HashMap;
use tracepanel_protocol::{Attrs, Issue, Received, Span, Trace};

/// The span kind of a migration applied or unapplied.
pub const KIND: &str = "migration";
/// The span kind of one of its operations.
pub const OPERATION: &str = "migration.operation";

/// What marks an older SDK's `function` span as a migration, and as an operation.
const APP: &str = "migration.app";
const OPERATION_ATTR: &str = "migration.operation";
const RISK: &str = "migration.risk";

fn kind_of(attrs: &Attrs) -> Option<&'static str> {
    if attrs.contains_key(APP) {
        Some(KIND)
    } else if attrs.contains_key(OPERATION_ATTR) {
        Some(OPERATION)
    } else {
        None
    }
}

/// Make an older SDK's migrations and operations their kinds, in the trace's rows and in its document.
pub fn normalize(received: &mut Received) {
    super::rekind(received, kind_of);
}

fn is_migration(span: &Span) -> bool {
    span.kind == KIND || (span.kind == "function" && span.attrs.contains_key(APP))
}

fn is_operation(span: &Span) -> bool {
    span.kind == OPERATION || (span.kind == "function" && span.attrs.contains_key(OPERATION_ATTR))
}

/// The migration an operation ran in: its nearest migration span above it (a transaction may be between them).
fn migration_of<'a>(span: &Span, by_id: &HashMap<&str, &'a Span>) -> Option<&'a Span> {
    let mut parent = span.parent_id.as_deref();
    // A broken tree (a cycle) stops at its size.
    for _ in 0..by_id.len() {
        let above = by_id.get(parent?)?;
        if is_migration(above) {
            return Some(above);
        }
        parent = above.parent_id.as_deref();
    }
    None
}

/// Whether the migration ran its operations forwards for real: not faked, not unapplied.
fn applied(migration: &Span) -> bool {
    !truthy(migration.attrs.get("migration.fake"))
        && text(&migration.attrs, "migration.direction").as_deref() != Some("backwards")
}

/// What to do about a risk, by the reason the SDK gives (its words for each).
fn hint(risk: &str) -> &'static str {
    if risk.contains("ALTER COLUMN TYPE") {
        "Every read and write of the table waits until it is rewritten. On a large table add a new column, backfill \
         it in batches and switch to it, or run the migration when the table is quiet."
    } else if risk.contains("SET NOT NULL") {
        "Every read and write of the table waits while it is scanned. Add a CHECK (column IS NOT NULL) NOT VALID \
         constraint, validate it in a migration of its own (VALIDATE CONSTRAINT doesn't block writes), then set NOT \
         NULL: PostgreSQL skips the scan with a valid constraint."
    } else if risk.contains("CREATE INDEX") {
        "Writes to the table wait until the index is built. Use AddIndexConcurrently \
         (django.contrib.postgres.operations) in a migration with `atomic = False`."
    } else if risk.contains("ALGORITHM=COPY") {
        "Writes to the table wait while it is copied. On a large table run the migration when the table is quiet, or \
         with an online schema change tool (gh-ost, pt-online-schema-change)."
    } else if risk.contains("no reverse") {
        "Give the operation its reverse, reverse_code for RunPython, reverse_sql for RunSQL (RunPython.noop or \
         RunSQL.noop when there is nothing to undo), so the migration can be unapplied."
    } else {
        "Check what the operation does to the table before it runs where the table is large or busy."
    }
}

/// "shop.0012_add_sku": a migration as migrate names it.
fn migration_name(migration: Option<&Span>) -> Option<String> {
    let migration = migration?;
    let app = text(&migration.attrs, APP)?;
    let name = text(&migration.attrs, "migration.name")?;
    Some(format!("{app}.{name}"))
}

/// The capital the reason's first word lacks, as a title: "changing a column's type…" reads "Changing a column's
/// type…".
fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(chars).collect()
    })
}

/// Each operation with a risk, in a migration applied for real, an issue: its reason the title, the migration and the
/// operation where it is.
pub(crate) fn risk_issues(trace: &Trace) -> Vec<Issue> {
    let by_id: HashMap<&str, &Span> = trace
        .spans
        .iter()
        .map(|span| (span.id.as_str(), span))
        .collect();
    trace
        .spans
        .iter()
        .filter(|span| is_operation(span))
        .filter_map(|span| {
            let risk = text(&span.attrs, RISK).filter(|risk| !risk.is_empty())?;
            let migration = migration_of(span, &by_id);
            if migration.is_some_and(|migration| !applied(migration)) {
                return None;
            }
            let name = migration_name(migration);
            let culprit = match &name {
                Some(name) => format!("{name} · {}", span.name),
                None => span.name.clone(),
            };
            Some(issue(
                issue_key(
                    "migration-risk",
                    &[name.as_deref(), Some(&span.name), Some(&risk)],
                ),
                "migration-risk",
                capitalized(&risk),
                Some(culprit),
                Some(hint(&risk)),
                1,
                vec![span.id.clone()],
            ))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn span(id: &str, parent: Option<&str>, name: &str, attrs: &Value) -> Value {
        json!({"id": id, "parent_id": parent, "kind": "function", "name": name, "start": 1, "duration": 1,
               "status": "ok", "attrs": attrs})
    }

    fn migrate(spans: Vec<Value>) -> Received {
        let mut all = vec![
            json!({"id": "01M5M1GR00T000000000000000", "parent_id": null, "kind": "command",
                                  "name": "migrate", "start": 0, "duration": 10, "status": "ok", "attrs": {}}),
        ];
        all.extend(spans);
        let doc = json!({
            "id": "01M5M1GTRACE00000000000000", "kind": "command", "name": "manage.py migrate", "start": 0,
            "duration": 10, "status": "ok", "attrs": {"command.name": "migrate"},
            "spans": all, "logs": [], "errors": [], "links": [], "issues": [],
        });
        Received {
            trace: serde_json::from_value(doc.clone()).unwrap(),
            doc: doc.to_string(),
        }
    }

    fn migration(id: &str, name: &str, direction: &str, fake: bool) -> Value {
        span(
            id,
            Some("01M5M1GR00T000000000000000"),
            &format!("migrate shop {name}"),
            &json!({"migration.app": "shop", "migration.name": name, "migration.direction": direction,
                    "migration.atomic": true, "migration.fake": fake, "migration.operations": 1}),
        )
    }

    fn operation(id: &str, parent: &str, name: &str, risk: Option<&str>) -> Value {
        let mut attrs = json!({"migration.operation": name.split(' ').next().unwrap(), "migration.atomic": true});
        if let Some(risk) = risk {
            attrs[RISK] = Value::from(risk);
        }
        span(id, Some(parent), name, &attrs)
    }

    #[test]
    fn an_older_sdk_s_migrations_and_operations_become_their_kinds_in_the_rows_and_the_document() {
        let mut received = migrate(vec![
            migration("01M5M1GM100000000000000000", "0002_sku", "forwards", false),
            operation(
                "01M5M1G0P10000000000000000",
                "01M5M1GM100000000000000000",
                "AddField Product.sku",
                None,
            ),
            span(
                "01M5M1GFN10000000000000000",
                Some("01M5M1G0P10000000000000000"),
                "backfill",
                &json!({}),
            ),
        ]);

        normalize(&mut received);

        let rows: Vec<&str> = received
            .trace
            .spans
            .iter()
            .map(|span| span.kind.as_str())
            .collect();
        let stored: Value = serde_json::from_str(&received.doc).unwrap();
        let documented: Vec<&str> = stored["spans"]
            .as_array()
            .unwrap()
            .iter()
            .map(|span| span["kind"].as_str().unwrap())
            .collect();

        assert_eq!(
            rows,
            ["command", "migration", "migration.operation", "function"]
        );
        assert_eq!(documented, rows);
    }

    #[test]
    fn a_risk_is_an_issue_only_in_a_migration_applied_for_real() {
        let index = "CREATE INDEX blocks writes to the table until it is built (AddIndexConcurrently doesn't)";
        let mut received = migrate(vec![
            migration(
                "01M5M1GM100000000000000000",
                "0003_index",
                "forwards",
                false,
            ),
            // The schema editor's transaction between the migration and its operation.
            json!({"id": "01M5M1GTX10000000000000000", "parent_id": "01M5M1GM100000000000000000",
                   "kind": "transaction", "name": "atomic", "start": 1, "duration": 1, "status": "ok", "attrs": {}}),
            operation(
                "01M5M1G0P10000000000000000",
                "01M5M1GTX10000000000000000",
                "AddIndex Product.sku_idx",
                Some(index),
            ),
            migration("01M5M1GM200000000000000000", "0004_fake", "forwards", true),
            operation(
                "01M5M1G0P20000000000000000",
                "01M5M1GM200000000000000000",
                "AddIndex Product.name_idx",
                Some(index),
            ),
            migration(
                "01M5M1GM300000000000000000",
                "0005_back",
                "backwards",
                false,
            ),
            operation(
                "01M5M1G0P30000000000000000",
                "01M5M1GM300000000000000000",
                "AlterField Product.price",
                Some("ALTER COLUMN TYPE rewrites the table under an ACCESS EXCLUSIVE lock"),
            ),
        ]);
        normalize(&mut received);

        let issues = risk_issues(&received.trace);

        assert_eq!(
            issues,
            [Issue {
                fingerprint: issue_key(
                    "migration-risk",
                    &[
                        Some("shop.0003_index"),
                        Some("AddIndex Product.sku_idx"),
                        Some(index)
                    ]
                ),
                fingerprint_version: crate::FINGERPRINT_VERSION,
                kind: "migration-risk".into(),
                title: index.into(),
                culprit: Some("shop.0003_index · AddIndex Product.sku_idx".into()),
                hint: Some(hint(index).into()),
                count: 1,
                span_ids: vec!["01M5M1G0P10000000000000000".into()],
            }]
        );
    }

    #[test]
    fn each_reason_has_its_hint_and_its_title_a_capital() {
        let hints = [
            "ALTER COLUMN TYPE rewrites the table under an ACCESS EXCLUSIVE lock",
            "SET NOT NULL scans the table under an ACCESS EXCLUSIVE lock",
            "CREATE INDEX blocks writes to the table until it is built (AddIndexConcurrently doesn't)",
            "changing a column's type copies the table (ALGORITHM=COPY): writes wait",
            "RunPython with no reverse: the migration can't be unapplied",
            "something new",
        ]
        .map(|risk| hint(risk).split(' ').take(3).collect::<Vec<_>>().join(" "));

        assert_eq!(
            hints,
            [
                "Every read and",
                "Every read and",
                "Writes to the",
                "Writes to the",
                "Give the operation",
                "Check what the",
            ]
        );
        assert_eq!(
            capitalized("changing a column's type copies the table"),
            "Changing a column's type copies the table"
        );
    }
}
