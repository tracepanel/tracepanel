//! The service map: what each trace's spans called (databases, caches, mail, queues, HTTP), and the broker a task came from.

use super::*;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct Peer {
    pub(crate) kind: &'static str,
    pub(crate) system: String,
    pub(crate) address: Option<String>,
    pub(crate) port: Option<i64>,
    pub(crate) namespace: Option<String>,
    pub(crate) alias: Option<String>,
}

impl Peer {
    pub(crate) fn id(&self) -> String {
        let place = match (self.port, &self.address) {
            (Some(port), address) => format!("{}:{port}", address.as_deref().unwrap_or("None")),
            (None, address) => address.clone().unwrap_or_default(),
        };
        [
            format!("{}:{}", self.kind, self.system),
            place,
            self.namespace.clone().unwrap_or_default(),
        ]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/")
    }
}

#[derive(Default)]
pub(crate) struct Usage {
    pub(crate) calls: i64,
    pub(crate) duration: i64,
    pub(crate) errors: i64,
}

pub(crate) fn peer(span: &Span) -> Option<Peer> {
    let attrs = &span.attrs;
    let address = text(attrs.get("server.address"));
    let port = port(attrs.get("server.port"));
    let new = |kind, system, namespace, alias| Peer {
        kind,
        system,
        address: address.clone(),
        port,
        namespace,
        alias,
    };
    match span.kind.as_str() {
        "sql" => {
            let system = text(attrs.get("db.system"))
                .or_else(|| text(attrs.get("db.vendor")))
                .unwrap_or_else(|| "sql".into());
            let alias = text(attrs.get("db.alias")).unwrap_or_else(|| "default".into());
            // In-memory SQLite has neither a server nor a file: the alias tells two of them apart.
            let namespace = text(attrs.get("db.namespace")).or_else(|| {
                if address.is_some() {
                    None
                } else {
                    Some(alias.clone())
                }
            });
            Some(new("database", system, namespace, Some(alias)))
        }
        "cache" => {
            let alias = text(attrs.get("cache.alias")).unwrap_or_else(|| "default".into());
            let namespace = if address.is_some() {
                text(attrs.get("db.namespace"))
            } else {
                Some(alias.clone())
            };
            Some(new(
                "cache",
                text(attrs.get("cache.system")).unwrap_or_else(|| "cache".into()),
                namespace,
                Some(alias),
            ))
        }
        "mail" => Some(new(
            "mail",
            text(attrs.get("mail.system")).unwrap_or_else(|| "mail".into()),
            None,
            None,
        )),
        "task.enqueue" | "channel.send" if truthy(attrs.get("messaging.system")) => {
            Some(new("queue", py_str(&attrs["messaging.system"]), None, None))
        }
        "http.client" if address.is_some() => Some(new(
            "http",
            text(attrs.get("url.scheme")).unwrap_or_else(|| "http".into()),
            None,
            None,
        )),
        _ => text(attrs.get("db.system"))
            .map(|system| new("database", system, text(attrs.get("db.namespace")), None)),
    }
}

/// Calls per (peer, direction), in the order Python's dict keeps them.
pub(crate) fn dependencies(trace: &Trace) -> Vec<((Peer, &'static str), Usage)> {
    let mut order: Vec<(Peer, &'static str)> = Vec::new();
    let mut usage: HashMap<(Peer, &'static str), Usage> = HashMap::new();
    for span in &trace.spans {
        let Some(peer) = peer(span) else { continue };
        let key = (peer, "out");
        if !usage.contains_key(&key) {
            order.push(key.clone());
        }
        let item = usage.entry(key).or_default();
        item.calls += 1;
        item.duration += span.duration;
        item.errors += i64::from(span.status == "error");
    }
    if trace.kind == "task" && truthy(trace.attrs.get("messaging.system")) {
        let broker = Peer {
            kind: "queue",
            system: py_str(&trace.attrs["messaging.system"]),
            address: text(trace.attrs.get("server.address")),
            port: port(trace.attrs.get("server.port")),
            namespace: None,
            alias: None,
        };
        let key = (broker, "in");
        if !usage.contains_key(&key) {
            order.push(key.clone());
        }
        usage.insert(
            key,
            Usage {
                calls: 1,
                duration: port(trace.attrs.get("task.queue_wait")).unwrap_or(0),
                errors: 0,
            },
        );
    }
    order
        .into_iter()
        .map(|key| {
            let item = usage.remove(&key).unwrap_or_default();
            (key, item)
        })
        .collect()
}
