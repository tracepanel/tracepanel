//! Local SQLite storage: a project's traces, logs, queries, emails and issues, and the console's reads of them. Some
//! conventions come from the store's Python origins and show in the API: "falsy" values fall back to defaults,
//! attribute values are compared as Python's `str()` writes them, booleans are 0/1.

use rusqlite::types::Value as Sql;
use rusqlite::{Connection, params};
use serde_json::Value;
use sha1::{Digest, Sha1};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use tracepanel_protocol::{Attrs, Received, Span, Trace};

pub mod search;
use search::{Compiler, SearchError, Term};

mod groups;
mod read;
mod searches;
mod services;
mod stats;
mod values;
mod write;

use read::*;
use searches::*;
use services::*;
use stats::*;
use values::*;
use write::*;

pub use read::{Page, ReadError, Reader};
/// The store's errors (SQLite's).
pub use rusqlite::Error;
pub use stats::{SLOW_REQUEST_US, stats};
pub use values::query_fingerprint;
pub use write::{DEFAULT_MAX_TRACES, SCHEMA, Store, path_in, version};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_from_the_schema() {
        assert!(version().chars().all(|char| char.is_ascii_digit()));
    }

    #[test]
    fn python_views() {
        assert!(!truthy(Some(&Value::from(0))));
        assert!(!truthy(Some(&Value::from(""))));
        assert!(truthy(Some(&Value::from("x"))));
        assert_eq!(py_str(&Value::from(true)), "True");
        assert_eq!(py_str(&serde_json::json!(1.0)), "1.0");
        assert_eq!(query_fingerprint("SELECT 1", "default").len(), 16);
    }
}
