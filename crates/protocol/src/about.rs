//! What each app said about itself in its hello (`app`): its settings, masked by its SDK, the versions of what it runs
//! on, and what its checks found wrong with it (`checks`, `migrations`: Django's system checks and its migrations not
//! applied or not made). The checks may take a while: an SDK tells what they found in the hello when it knows it
//! already, else in an `{"app": {...}}` frame once they ran. Per service, not per request: the latest hello of a
//! service wins, and it stays after the app goes, so the console still shows an app that restarts or stopped. Kept in
//! memory, as the tasks in flight are: an agent started anew learns it again from each app's next hello.
//!
//! A `migrate` command's trace makes the app's unapplied migrations true again: the migrations it applied go from the
//! list, those it unapplied come back to it, and the console links the warning to it. What a process said before
//! then (a hello, its checks' frame after it) may be from before the migrate: told later, the migrate is applied to
//! it again.

use crate::{Thresholds, Trace};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

#[derive(Default)]
struct Told {
    /// Setting name -> its value as the app's SDK wrote it (repr-ed, cut, masked).
    settings: Option<Value>,
    /// `[{"name", "version", "kind"}]`: the runtime, the framework, the packages that matter.
    versions: Option<Value>,
    /// `[{"id", "level", "message", "hint", "object"}]`: the framework's checks that failed, the most serious first.
    checks: Option<Value>,
    /// `{"unapplied": [{"app", "names"}], "changes": [{"app", "changes"}]}`: migrations not applied, not made.
    migrations: Option<Value>,
    /// When the agent had it (µs), the latest hello or frame that said anything.
    received: Option<i64>,
    /// The app's connections open now.
    open: usize,
    /// The latest migrate command the agent had a trace of.
    migrated: Option<Migrated>,
    /// The limits its latest hello set for finding issues: what the console offers as a page's "Slow".
    thresholds: Option<Thresholds>,
}

/// A migrate command's trace: what it applied and unapplied, `(app, name)` each, in the order it ran them.
struct Migrated {
    trace: String,
    /// When the agent had the trace (µs, the agent's clock, as `received`).
    received: i64,
    applied: Vec<(String, String)>,
    unapplied: Vec<(String, String)>,
}

impl Migrated {
    /// What a migrate trace ran: its migration spans (`migration.app`, `migration.name`, `migration.direction`), a
    /// faked one too (recorded as applied all the same). None for a trace of anything else.
    fn of(trace: &Trace, received: i64) -> Option<Self> {
        let text = |attrs: &crate::Attrs, key: &str| {
            attrs.get(key).and_then(Value::as_str).map(str::to_owned)
        };
        let mut migrated = Self {
            trace: trace.id.clone(),
            received,
            applied: Vec::new(),
            unapplied: Vec::new(),
        };
        for span in &trace.spans {
            let (Some(app), Some(name)) = (
                text(&span.attrs, "migration.app"),
                text(&span.attrs, "migration.name"),
            ) else {
                continue;
            };
            match text(&span.attrs, "migration.direction").as_deref() {
                Some("backwards") => migrated.unapplied.push((app, name)),
                _ => migrated.applied.push((app, name)),
            }
        }
        // A migrate with nothing to do is one all the same: its plan says so.
        let planned = trace.attrs.contains_key("migrate.planned");
        (planned || !migrated.applied.is_empty() || !migrated.unapplied.is_empty())
            .then_some(migrated)
    }

    /// The app's `migrations` as they are after it: its applied ones off the unapplied list (an app with none left
    /// off it too), its unapplied ones back on it, each before the app's others, as migrate would apply them again.
    /// An SDK that couldn't read them (`unapplied` null) still can't.
    fn apply(&self, migrations: &mut Value) {
        let Some(list) = migrations
            .get_mut("unapplied")
            .and_then(Value::as_array_mut)
        else {
            return;
        };
        for (app, name) in &self.applied {
            for entry in list.iter_mut().filter(|entry| entry["app"] == app.as_str()) {
                if let Some(names) = entry.get_mut("names").and_then(Value::as_array_mut) {
                    names.retain(|each| each != name.as_str());
                }
            }
        }
        // Unapplied newest first: each goes before the one unapplied before it.
        for (app, name) in &self.unapplied {
            let at = list.iter().position(|entry| entry["app"] == app.as_str());
            let entry = match at {
                Some(at) => &mut list[at],
                None => {
                    list.push(json!({"app": app, "names": []}));
                    list.last_mut().expect("just pushed")
                }
            };
            if let Some(names) = entry.get_mut("names").and_then(Value::as_array_mut)
                && !names.iter().any(|each| each == name.as_str())
            {
                names.insert(0, Value::from(name.as_str()));
            }
        }
        list.retain(|entry| {
            entry["names"]
                .as_array()
                .is_none_or(|names| !names.is_empty())
        });
    }
}

impl Told {
    /// The app's migrations as a process said them, told at `said` (its hello's time): a migrate the agent had after
    /// that ran since, and is applied to them.
    fn set_migrations(&mut self, migrations: Option<&Value>, said: i64) {
        self.migrations = migrations.cloned();
        if let (Some(migrations), Some(migrated)) = (self.migrations.as_mut(), &self.migrated)
            && migrated.received > said
        {
            migrated.apply(migrations);
        }
    }
}

/// The fields of an app's account of itself, each with the JSON type it must have: anything else is left out.
fn fields(app: &Value) -> [Option<&Value>; 4] {
    [
        app.get("settings").filter(|value| value.is_object()),
        app.get("versions").filter(|value| value.is_array()),
        app.get("checks").filter(|value| value.is_array()),
        app.get("migrations").filter(|value| value.is_object()),
    ]
}

/// The apps' own accounts of themselves, by service.
#[derive(Clone, Default)]
pub struct About {
    apps: Arc<Mutex<HashMap<String, Told>>>,
}

impl About {
    /// A hello of `service`: its `app` when it has one (all it says replaces what the app said before), and one more
    /// connection.
    pub(crate) fn hello(&self, service: &str, app: Option<&Value>, now: i64) {
        if service.is_empty() {
            return;
        }
        let mut apps = self.apps.lock().unwrap_or_else(PoisonError::into_inner);
        let told = apps.entry(service.to_owned()).or_default();
        told.open += 1;
        let Some(app) = app else { return };
        let [settings, versions, checks, migrations] = fields(app);
        if settings.is_none() && versions.is_none() && checks.is_none() && migrations.is_none() {
            return;
        }
        told.settings = settings.cloned();
        told.versions = versions.cloned();
        told.checks = checks.cloned();
        told.set_migrations(migrations, now);
        told.received = Some(now);
    }

    /// An `{"app": {...}}` frame of `service`, after its hello at `said`: what its checks found once they ran. It adds
    /// to what the hello said, each field it has replacing the one before.
    pub(crate) fn checked(&self, service: &str, app: &Value, said: i64, now: i64) {
        if service.is_empty() {
            return;
        }
        let mut apps = self.apps.lock().unwrap_or_else(PoisonError::into_inner);
        let told = apps.entry(service.to_owned()).or_default();
        let [settings, versions, checks, migrations] = fields(app);
        let mut anything = false;
        for (field, value) in [
            (&mut told.settings, settings),
            (&mut told.versions, versions),
            (&mut told.checks, checks),
        ] {
            if let Some(value) = value {
                *field = Some(value.clone());
                anything = true;
            }
        }
        if migrations.is_some() {
            told.set_migrations(migrations, said);
            anything = true;
        }
        if anything {
            told.received = Some(now);
        }
    }

    /// A trace the agent had at `now`: a migrate command's (its migration spans, or its plan) makes the unapplied
    /// migrations of its service what they are after it, and is the one the console links them to.
    pub fn migrated(&self, trace: &Trace, now: i64) {
        let service = trace
            .attrs
            .get("service.name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if service.is_empty() {
            return;
        }
        let Some(migrated) = Migrated::of(trace, now) else {
            return;
        };
        let mut apps = self.apps.lock().unwrap_or_else(PoisonError::into_inner);
        let told = apps.entry(service.to_owned()).or_default();
        if let Some(migrations) = told.migrations.as_mut() {
            migrated.apply(migrations);
        }
        told.migrated = Some(migrated);
    }

    /// The limits a hello of `service` set for finding issues: the latest hello's win.
    pub(crate) fn limits(&self, service: &str, thresholds: &Thresholds) {
        if service.is_empty() {
            return;
        }
        let mut apps = self.apps.lock().unwrap_or_else(PoisonError::into_inner);
        apps.entry(service.to_owned()).or_default().thresholds = Some(thresholds.clone());
    }

    /// Each app's limits, as its latest hello set them: an app that sent none (OpenTelemetry's, or before the agent
    /// started) has the defaults.
    pub fn thresholds(&self) -> HashMap<String, Thresholds> {
        let apps = self.apps.lock().unwrap_or_else(PoisonError::into_inner);
        apps.iter()
            .filter_map(|(service, told)| Some((service.clone(), told.thresholds.clone()?)))
            .collect()
    }

    /// A connection of `service` closed.
    pub(crate) fn left(&self, service: &str) {
        let mut apps = self.apps.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(told) = apps.get_mut(service) {
            told.open = told.open.saturating_sub(1);
        }
    }

    /// `api/app`: what `service` said about itself, nulls for what it never said (an SDK that doesn't send it).
    pub fn of(&self, service: &str, agent: &str) -> Value {
        let apps = self.apps.lock().unwrap_or_else(PoisonError::into_inner);
        let told = apps.get(service);
        json!({
            "service": service,
            "agent": agent,
            "connected": told.is_some_and(|told| told.open > 0),
            "received": told.and_then(|told| told.received),
            "settings": told.and_then(|told| told.settings.clone()),
            "versions": told.and_then(|told| told.versions.clone()),
            "checks": told.and_then(|told| told.checks.clone()),
            "migrations": told.and_then(|told| told.migrations.clone()),
            "migrate": told.and_then(|told| told.migrated.as_ref()).map(|migrated| {
                json!({"trace": migrated.trace, "received": migrated.received})
            }),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_app_s_limits_are_its_latest_hello_s() {
        let about = About::default();
        about.limits(
            "shop",
            &Thresholds {
                slow_sql_ms: 250,
                ..Thresholds::default()
            },
        );
        about.limits(
            "shop",
            &Thresholds {
                slow_sql_ms: 300,
                ..Thresholds::default()
            },
        );
        // A hello with no service.name, and an app that only said who it is, have none.
        about.limits("", &Thresholds::default());
        about.hello("billing", None, 10);

        let limits = about.thresholds();
        assert_eq!(limits.keys().collect::<Vec<_>>(), ["shop"]);
        assert_eq!(limits["shop"].slow_sql_ms, 300);
    }

    #[test]
    fn the_latest_hello_that_says_anything_wins_and_stays_after_the_app_goes() {
        let about = About::default();
        let first = json!({"settings": {"DEBUG": "True"}, "versions": [{"name": "Python", "version": "3.13.1"}]});
        about.hello("shop", Some(&first), 10);
        // An SDK from before says nothing: what the app said before stays.
        about.hello("shop", None, 20);
        about.left("shop");

        assert_eq!(
            about.of("shop", "0.4.2"),
            json!({"service": "shop", "agent": "0.4.2", "connected": true, "received": 10,
                   "settings": {"DEBUG": "True"}, "versions": [{"name": "Python", "version": "3.13.1"}],
                   "checks": null, "migrations": null, "migrate": null})
        );

        about.left("shop");
        let second = json!({"settings": {"DEBUG": "False"}});
        about.hello("shop", Some(&second), 30);
        about.left("shop");

        assert_eq!(
            about.of("shop", "0.4.2"),
            json!({"service": "shop", "agent": "0.4.2", "connected": false, "received": 30,
                   "settings": {"DEBUG": "False"}, "versions": null, "checks": null, "migrations": null, "migrate": null})
        );
    }

    #[test]
    fn an_app_that_never_said_anything_has_nulls() {
        let about = About::default();
        about.hello(
            "shop-web",
            Some(&json!({"settings": "not an object", "versions": {}})),
            10,
        );
        about.hello("", Some(&json!({"settings": {"DEBUG": "True"}})), 10);

        assert_eq!(
            about.of("shop-web", "0.4.2"),
            json!({"service": "shop-web", "agent": "0.4.2", "connected": true, "received": null,
                   "settings": null, "versions": null, "checks": null, "migrations": null, "migrate": null})
        );
        assert_eq!(
            about.of("", "0.4.2"),
            json!({"service": "", "agent": "0.4.2", "connected": false, "received": null,
                   "settings": null, "versions": null, "checks": null, "migrations": null, "migrate": null})
        );
    }

    #[test]
    fn the_checks_come_in_the_hello_or_in_a_frame_after_it() {
        let about = About::default();
        let versions = json!([{"name": "Python", "version": "3.13.1"}]);
        let checks = json!([{"id": "models.W042", "level": "warning", "message": "Auto-created primary key used",
                             "hint": "Configure DEFAULT_AUTO_FIELD.", "object": "shop.Order"}]);
        let migrations =
            json!({"unapplied": [{"app": "shop", "names": ["0002_order_note"]}], "changes": []});
        about.hello("shop", Some(&json!({"versions": versions})), 10);
        // The checks ran after the hello: their frame adds to it; a field of the wrong type is left out.
        about.checked(
            "shop",
            &json!({"checks": checks, "migrations": "not an object"}),
            10,
            20,
        );
        about.checked("shop", &json!({"migrations": migrations}), 10, 30);
        about.checked("shop", &json!({"nothing": "known"}), 10, 40);

        assert_eq!(
            about.of("shop", "0.4.2"),
            json!({"service": "shop", "agent": "0.4.2", "connected": true, "received": 30,
                   "settings": null, "versions": versions, "checks": checks, "migrations": migrations, "migrate": null})
        );

        // The app restarted: its hello says all it knows, the checks not yet.
        about.left("shop");
        about.hello("shop", Some(&json!({"versions": versions})), 50);

        assert_eq!(
            about.of("shop", "0.4.2"),
            json!({"service": "shop", "agent": "0.4.2", "connected": true, "received": 50,
                   "settings": null, "versions": versions, "checks": null, "migrations": null, "migrate": null})
        );

        // An app whose hello knows them already.
        about.hello(
            "shop-web",
            Some(&json!({"checks": [], "migrations": {"unapplied": null, "changes": []}, "migrate": null})),
            60,
        );

        assert_eq!(
            about.of("shop-web", "0.4.2"),
            json!({"service": "shop-web", "agent": "0.4.2", "connected": true, "received": 60, "settings": null,
                   "versions": null, "checks": [], "migrations": {"unapplied": null, "changes": []}, "migrate": null})
        );
    }

    fn migrate(id: &str, spans: &[(&str, &str, &str)]) -> Trace {
        let spans: Vec<Value> = spans
            .iter()
            .enumerate()
            .map(|(n, (app, name, direction))| {
                json!({"id": format!("{id}{n}"), "kind": "migration", "name": format!("migrate {app} {name}"),
                       "start": 1, "attrs": {"migration.app": app, "migration.name": name,
                                             "migration.direction": direction}})
            })
            .collect();
        serde_json::from_value(json!({
            "id": id, "kind": "command", "name": "manage.py migrate", "start": 0,
            "attrs": {"service.name": "shop", "migrate.planned": spans.len()}, "spans": spans,
        }))
        .unwrap()
    }

    fn unapplied(about: &About) -> Value {
        about.of("shop", "0.4.2")["migrations"]["unapplied"].clone()
    }

    #[test]
    fn a_migrate_trace_makes_the_unapplied_migrations_what_they_are_after_it() {
        let about = About::default();
        let migrations = json!({"unapplied": [{"app": "shop", "names": ["0007_gift", "0008_gift_note"]},
                                              {"app": "blog", "names": ["0002_tags"]}],
                                "changes": []});
        about.hello("shop", Some(&json!({"migrations": migrations})), 10);
        // Another service's trace, and a trace of no migrate, change nothing.
        let mut other = migrate(
            "01M5M1GATHER0000000000000",
            &[("shop", "0007_gift", "forwards")],
        );
        other
            .attrs
            .insert("service.name".into(), json!("shop-worker"));
        about.migrated(&other, 15);
        let mut request = migrate("01M5M1GREQUEST000000000000", &[]);
        request.attrs.remove("migrate.planned");
        about.migrated(&request, 15);

        assert_eq!(unapplied(&about), migrations["unapplied"]);
        assert_eq!(about.of("shop", "0.4.2")["migrate"], Value::Null);

        about.migrated(
            &migrate(
                "01M5M1GFRST00000000000000",
                &[
                    ("shop", "0007_gift", "forwards"),
                    ("blog", "0002_tags", "forwards"),
                ],
            ),
            20,
        );

        assert_eq!(
            unapplied(&about),
            json!([{"app": "shop", "names": ["0008_gift_note"]}])
        );
        assert_eq!(
            about.of("shop", "0.4.2")["migrate"],
            json!({"trace": "01M5M1GFRST00000000000000", "received": 20})
        );

        // Back to 0006: 0007 is unapplied again, before 0008; blog's 0001 too, an app of its own on the list.
        about.migrated(
            &migrate(
                "01M5M1GBACK00000000000000",
                &[
                    ("shop", "0007_gift", "backwards"),
                    ("blog", "0001_initial", "backwards"),
                ],
            ),
            30,
        );

        assert_eq!(
            unapplied(&about),
            json!([{"app": "shop", "names": ["0007_gift", "0008_gift_note"]},
                   {"app": "blog", "names": ["0001_initial"]}])
        );
    }

    #[test]
    fn what_a_process_said_before_the_migrate_has_it_applied_again() {
        let about = About::default();
        let before = json!({"unapplied": [{"app": "shop", "names": ["0007_gift"]}], "changes": []});
        about.hello("shop", None, 10);
        about.migrated(
            &migrate(
                "01M5M1GFRST00000000000000",
                &[("shop", "0007_gift", "forwards")],
            ),
            20,
        );
        // The migrate's own process: its checks' frame, from its hello at 10, comes after its trace.
        about.checked("shop", &json!({"migrations": before}), 10, 30);

        assert_eq!(unapplied(&about), json!([]));

        // A process that started after it knows better: its hello says what the database has now.
        about.hello("shop", Some(&json!({"migrations": before})), 40);

        assert_eq!(unapplied(&about), before["unapplied"]);
    }
}
