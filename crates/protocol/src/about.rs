//! What each app said about itself in its hello (`app`): its settings, masked by its SDK, the versions of what it runs
//! on, and what its checks found wrong with it (`checks`, `migrations`: Django's system checks and its migrations not
//! applied or not made). The checks may take a while: an SDK tells what they found in the hello when it knows it
//! already, else in an `{"app": {...}}` frame once they ran. Per service, not per request: the latest hello of a
//! service wins, and it stays after the app goes, so the console still shows an app that restarts or stopped. Kept in
//! memory, as the tasks in flight are: an agent started anew learns it again from each app's next hello.

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
        told.migrations = migrations.cloned();
        told.received = Some(now);
    }

    /// An `{"app": {...}}` frame of `service`, after its hello: what its checks found once they ran. It adds to what
    /// the hello said, each field it has replacing the one before.
    pub(crate) fn checked(&self, service: &str, app: &Value, now: i64) {
        if service.is_empty() {
            return;
        }
        let mut apps = self.apps.lock().unwrap_or_else(PoisonError::into_inner);
        let told = apps.entry(service.to_owned()).or_default();
        let [settings, versions, checks, migrations] = fields(app);
        let mut said = false;
        for (field, value) in [
            (&mut told.settings, settings),
            (&mut told.versions, versions),
            (&mut told.checks, checks),
            (&mut told.migrations, migrations),
        ] {
            if let Some(value) = value {
                *field = Some(value.clone());
                said = true;
            }
        }
        if said {
            told.received = Some(now);
        }
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
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
                   "checks": null, "migrations": null})
        );

        about.left("shop");
        let second = json!({"settings": {"DEBUG": "False"}});
        about.hello("shop", Some(&second), 30);
        about.left("shop");

        assert_eq!(
            about.of("shop", "0.4.2"),
            json!({"service": "shop", "agent": "0.4.2", "connected": false, "received": 30,
                   "settings": {"DEBUG": "False"}, "versions": null, "checks": null, "migrations": null})
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
                   "settings": null, "versions": null, "checks": null, "migrations": null})
        );
        assert_eq!(
            about.of("", "0.4.2"),
            json!({"service": "", "agent": "0.4.2", "connected": false, "received": null,
                   "settings": null, "versions": null, "checks": null, "migrations": null})
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
            20,
        );
        about.checked("shop", &json!({"migrations": migrations}), 30);
        about.checked("shop", &json!({"nothing": "known"}), 40);

        assert_eq!(
            about.of("shop", "0.4.2"),
            json!({"service": "shop", "agent": "0.4.2", "connected": true, "received": 30,
                   "settings": null, "versions": versions, "checks": checks, "migrations": migrations})
        );

        // The app restarted: its hello says all it knows, the checks not yet.
        about.left("shop");
        about.hello("shop", Some(&json!({"versions": versions})), 50);

        assert_eq!(
            about.of("shop", "0.4.2"),
            json!({"service": "shop", "agent": "0.4.2", "connected": true, "received": 50,
                   "settings": null, "versions": versions, "checks": null, "migrations": null})
        );

        // An app whose hello knows them already.
        about.hello(
            "shop-web",
            Some(&json!({"checks": [], "migrations": {"unapplied": null, "changes": []}})),
            60,
        );

        assert_eq!(
            about.of("shop-web", "0.4.2"),
            json!({"service": "shop-web", "agent": "0.4.2", "connected": true, "received": 60, "settings": null,
                   "versions": null, "checks": [], "migrations": {"unapplied": null, "changes": []}})
        );
    }
}
