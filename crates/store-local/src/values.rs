//! Attribute values as the store keeps them, which the console's filters and columns compare against.

use super::*;

pub(crate) use tracepanel_protocol::values::{or_default, py_str, truthy};

/// An attribute bound as sqlite3 binds the Python value (bool as 0/1).
pub(crate) fn sql(value: Option<&Value>) -> Sql {
    match value {
        None | Some(Value::Null) => Sql::Null,
        Some(Value::Bool(flag)) => Sql::Integer(i64::from(*flag)),
        Some(Value::Number(number)) => number
            .as_i64()
            .map_or_else(|| Sql::Real(number.as_f64().unwrap_or(0.0)), Sql::Integer),
        Some(Value::String(text)) => Sql::Text(text.clone()),
        Some(other) => Sql::Text(other.to_string()),
    }
}

pub(crate) fn alias_list(aliases: &BTreeSet<String>) -> String {
    if aliases.is_empty() {
        String::new()
    } else {
        format!(
            ",{},",
            aliases.iter().cloned().collect::<Vec<_>>().join(",")
        )
    }
}

/// `_text`: the value as text, None for None and "".
pub(crate) fn text(value: Option<&Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.is_empty() => None,
        other => Some(py_str(other)),
    }
}

/// `_port`: an int, not a bool.
pub(crate) fn port(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64)
}
