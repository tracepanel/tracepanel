//! The service map: what each trace's spans called (databases and Redis, caches, file storages, mail, queues, HTTP),
//! and the broker a task came from. A call to AWS is its service's (Amazon S3, AWS Lambda) in its region, and a layer
//! whose call made one (a Django storage on S3, a task queue on SQS) is that service: the call inside is the layer's.

use super::*;
use tracepanel_analysis::aws;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct Peer {
    pub(crate) kind: &'static str,
    pub(crate) system: String,
    pub(crate) address: Option<String>,
    pub(crate) port: Option<i64>,
    pub(crate) namespace: Option<String>,
    pub(crate) alias: Option<String>,
    /// AWS's name of the service it is (S3, Lambda) and its region.
    pub(crate) cloud_service: Option<String>,
    pub(crate) cloud_region: Option<String>,
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
    let mut found = server(span)?;
    if aws::is_call(span) {
        found.cloud_service = aws::service(span);
        found.cloud_region = aws::region(span);
    } else if found.kind == "queue" {
        found.cloud_service = broker_on_aws(&found.system);
    }
    Some(found)
}

/// A broker that is an AWS service, by its system (a Celery broker on SQS, OpenTelemetry's `aws_sqs`).
fn broker_on_aws(system: &str) -> Option<String> {
    match system {
        "sqs" | "aws_sqs" | "aws.sqs" => Some("SQS".into()),
        "sns" | "aws_sns" | "aws.sns" => Some("SNS".into()),
        _ => None,
    }
}

fn server(span: &Span) -> Option<Peer> {
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
        cloud_service: None,
        cloud_region: None,
    };
    match span.kind.as_str() {
        // Any AWS service's API: one endpoint (LocalStack's) serves them all, the service tells them apart.
        "grpc" | "rpc" if aws::is_call(span) => {
            Some(new("http", aws::SYSTEM.into(), aws::service(span), None))
        }
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
        // Redis used directly is a datastore, whatever the app keeps in it; through a cache API it is a cache.
        "redis" => Some(new(
            "database",
            text(attrs.get("db.system")).unwrap_or_else(|| "redis".into()),
            text(attrs.get("db.namespace")),
            Some(or_default(attrs, "redis.alias", "redis")),
        )),
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
        // A file storage by its alias: the local disk, a bucket.
        "storage" => {
            let alias = tracepanel_analysis::storage::target(span);
            Some(new(
                "storage",
                text(attrs.get("storage.system")).unwrap_or_else(|| "storage".into()),
                Some(alias.clone()),
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
        // A message sent to a broker an OpenTelemetry instrumentation saw: Kafka, RabbitMQ, SQS, or any other
        // (`messaging`, its system named in messaging.system).
        "kafka" | "rabbitmq" | "sqs" | "messaging" => Some(new(
            "queue",
            text(attrs.get("messaging.system")).unwrap_or_else(|| span.kind.clone()),
            None,
            None,
        )),
        // An RPC call: gRPC, or any other system (`rpc`, named in rpc.system).
        "grpc" | "rpc" if address.is_some() => Some(new(
            "http",
            text(attrs.get("rpc.system")).unwrap_or_else(|| span.kind.clone()),
            None,
            None,
        )),
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

/// The AWS service and region each layer's call reached (by the layer's span id): a call to AWS inside it.
fn layers_on_aws(trace: &Trace) -> HashMap<&str, (Option<String>, Option<String>)> {
    trace
        .spans
        .iter()
        .filter(|span| aws::is_call(span) && aws::layer(&trace.spans, span).is_some())
        .filter_map(|span| {
            Some((
                span.parent_id.as_deref()?,
                (aws::service(span), aws::region(span)),
            ))
        })
        .collect()
}

/// Calls per (peer, direction), in the order Python's dict keeps them.
pub(crate) fn dependencies(trace: &Trace) -> Vec<((Peer, &'static str), Usage)> {
    let mut order: Vec<(Peer, &'static str)> = Vec::new();
    let mut usage: HashMap<(Peer, &'static str), Usage> = HashMap::new();
    let on_aws = layers_on_aws(trace);
    for span in &trace.spans {
        // A call to AWS a layer made is the layer's call to that service.
        if aws::is_call(span) && aws::layer(&trace.spans, span).is_some() {
            continue;
        }
        let Some(mut peer) = peer(span) else { continue };
        if let Some((service, region)) = on_aws.get(span.id.as_str())
            && peer.cloud_service.is_none()
        {
            (peer.cloud_service, peer.cloud_region) = (service.clone(), region.clone());
        }
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
        let system = py_str(&trace.attrs["messaging.system"]);
        let broker = Peer {
            kind: "queue",
            cloud_service: broker_on_aws(&system),
            system,
            address: text(trace.attrs.get("server.address")),
            port: port(trace.attrs.get("server.port")),
            namespace: None,
            alias: None,
            cloud_region: None,
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
