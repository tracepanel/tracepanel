//! What each app said about itself in its hello (`app`): its settings, masked by its SDK, and the versions of what
//! it runs on. Per service, not per request: the latest hello of a service wins, and it stays after the app goes, so
//! the console still shows an app that restarts or stopped. Kept in memory, as the tasks in flight are: an agent
//! started anew learns it again from each app's next hello.

use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

#[derive(Default)]
struct Told {
    /// Setting name -> its value as the app's SDK wrote it (repr-ed, cut, masked).
    settings: Option<Value>,
    /// `[{"name", "version", "kind"}]`: the runtime, the framework, the packages that matter.
    versions: Option<Value>,
    /// When the agent had it (µs), the latest hello that said anything.
    received: Option<i64>,
    /// The app's connections open now.
    open: usize,
}

/// The apps' own accounts of themselves, by service.
#[derive(Clone, Default)]
pub struct About {
    apps: Arc<Mutex<HashMap<String, Told>>>,
}

impl About {
    /// A hello of `service`: its `app` (settings and versions) when it has one, and one more connection.
    pub(crate) fn hello(&self, service: &str, app: Option<&Value>, now: i64) {
        if service.is_empty() {
            return;
        }
        let mut apps = self.apps.lock().unwrap_or_else(PoisonError::into_inner);
        let told = apps.entry(service.to_owned()).or_default();
        told.open += 1;
        let Some(app) = app else { return };
        let settings = app.get("settings").filter(|value| value.is_object());
        let versions = app.get("versions").filter(|value| value.is_array());
        if settings.is_none() && versions.is_none() {
            return;
        }
        told.settings = settings.cloned();
        told.versions = versions.cloned();
        told.received = Some(now);
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
                   "settings": {"DEBUG": "True"}, "versions": [{"name": "Python", "version": "3.13.1"}]})
        );

        about.left("shop");
        let second = json!({"settings": {"DEBUG": "False"}});
        about.hello("shop", Some(&second), 30);
        about.left("shop");

        assert_eq!(
            about.of("shop", "0.4.2"),
            json!({"service": "shop", "agent": "0.4.2", "connected": false, "received": 30,
                   "settings": {"DEBUG": "False"}, "versions": null})
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
                   "settings": null, "versions": null})
        );
        assert_eq!(
            about.of("", "0.4.2"),
            json!({"service": "", "agent": "0.4.2", "connected": false, "received": null,
                   "settings": null, "versions": null})
        );
    }
}
