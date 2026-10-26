//! AWS: the calls an app makes to AWS's APIs (botocore's clients, an OpenTelemetry AWS SDK instrumentation), whatever
//! kind of span each is: an S3 call is a `storage` span, a DynamoDB one a datastore's, SQS's SendMessage a message,
//! any other service's an `rpc` call. Each says it is one by `rpc.system` aws-api, with the service as AWS names it
//! (`rpc.service`: S3, DynamoDB, Lambda), the operation (`rpc.method`: GetObject), the region (`cloud.region`), and
//! for a failed one the error's code (`error.type`: NoSuchKey) and botocore's retries (`aws.retry_attempts`).
//!
//! A call made for a Django storage, a cache or a task queue (a span of theirs is its parent) is part of that call:
//! its issues are the layer's, as a Redis command's under a cache call are, and the services map draws the layer's
//! node as the AWS service it reached.

use super::text;
use serde_json::Value;
use tracepanel_protocol::Span;

/// The `rpc.system` of a call to an AWS API.
pub const SYSTEM: &str = "aws-api";

/// The kinds of span a call to AWS can be made for: what the app asked a library, which made the call.
pub const LAYERS: &[&str] = &["storage", "cache", "task.enqueue"];

/// AWS's own names of its services, by the id an SDK sends (botocore's `service_id`, as OpenTelemetry's
/// `rpc.service`). One not here is "AWS <id>".
const NAMES: &[(&str, &str)] = &[
    ("S3", "Amazon S3"),
    ("DynamoDB", "Amazon DynamoDB"),
    ("DynamoDB Streams", "Amazon DynamoDB Streams"),
    ("SQS", "Amazon SQS"),
    ("SNS", "Amazon SNS"),
    ("Lambda", "AWS Lambda"),
    ("Secrets Manager", "AWS Secrets Manager"),
    ("SSM", "AWS Systems Manager"),
    ("STS", "AWS STS"),
    ("KMS", "AWS KMS"),
    ("IAM", "AWS IAM"),
    ("SFN", "AWS Step Functions"),
    ("Kinesis", "Amazon Kinesis"),
    ("Firehose", "Amazon Data Firehose"),
    ("SES", "Amazon SES"),
    ("SESv2", "Amazon SES"),
    ("EventBridge", "Amazon EventBridge"),
    ("CloudWatch", "Amazon CloudWatch"),
    ("CloudWatch Logs", "Amazon CloudWatch Logs"),
    ("EC2", "Amazon EC2"),
    ("ECS", "Amazon ECS"),
    ("ECR", "Amazon ECR"),
    ("Athena", "Amazon Athena"),
    ("Glue", "AWS Glue"),
    ("Bedrock Runtime", "Amazon Bedrock"),
    ("Bedrock", "Amazon Bedrock"),
    ("SageMaker Runtime", "Amazon SageMaker"),
    ("Cognito Identity Provider", "Amazon Cognito"),
    ("API Gateway", "Amazon API Gateway"),
    ("ApiGatewayManagementApi", "Amazon API Gateway"),
    ("Route 53", "Amazon Route 53"),
    ("CloudFront", "Amazon CloudFront"),
    ("ElastiCache", "Amazon ElastiCache"),
    ("RDS", "Amazon RDS"),
    ("RDS Data", "Amazon RDS Data API"),
    ("Textract", "Amazon Textract"),
    ("Rekognition", "Amazon Rekognition"),
    ("Comprehend", "Amazon Comprehend"),
    ("Translate", "Amazon Translate"),
    ("Polly", "Amazon Polly"),
];

/// Whether a span is a call to an AWS API.
pub fn is_call(span: &Span) -> bool {
    span.attrs.get("rpc.system").and_then(Value::as_str) == Some(SYSTEM)
}

/// The AWS service a call went to, as AWS names it in its SDKs (`S3`, `DynamoDB`, `Lambda`).
pub fn service(span: &Span) -> Option<String> {
    text(&span.attrs, "rpc.service").filter(|service| !service.is_empty())
}

/// The operation it called: `GetObject`, `Query`, `Invoke`.
pub fn operation(span: &Span) -> String {
    text(&span.attrs, "rpc.method").unwrap_or_default()
}

pub fn region(span: &Span) -> Option<String> {
    text(&span.attrs, "cloud.region").filter(|region| !region.is_empty())
}

/// A failed call's error code (`NoSuchKey`, `ThrottlingException`), else its exception's type.
pub fn error_code(span: &Span) -> Option<String> {
    text(&span.attrs, "error.type")
        .or_else(|| text(&span.attrs, "exception.type"))
        .filter(|code| !code.is_empty())
}

/// How many times botocore retried the call before its answer.
pub fn retries(span: &Span) -> i64 {
    span.attrs
        .get("aws.retry_attempts")
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

/// A service's name as AWS writes it: `Amazon S3`, `AWS Lambda`.
pub fn service_name(id: &str) -> String {
    NAMES
        .iter()
        .find(|(known, _)| *known == id)
        .map_or_else(|| format!("AWS {id}"), |(_, name)| (*name).to_owned())
}

/// The layer a call to AWS was made for (its parent's kind: `storage`, `cache`, `task.enqueue`), None for the app's
/// own call. The SDK records the call inside the layer's span, so its parent says.
pub fn layer<'a>(spans: &'a [Span], span: &Span) -> Option<&'a str> {
    let parent = span.parent_id.as_deref()?;
    spans
        .iter()
        .find(|candidate| candidate.id == parent)
        .map(|parent| parent.kind.as_str())
        .filter(|kind| LAYERS.contains(kind))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_service_is_named_as_aws_writes_it_and_one_unknown_after_aws() {
        let names = ["S3", "Lambda", "SNS", "Transcribe"].map(service_name);

        assert_eq!(
            names,
            ["Amazon S3", "AWS Lambda", "Amazon SNS", "AWS Transcribe"]
        );
    }
}
