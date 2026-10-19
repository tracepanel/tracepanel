//! Attribute values as the store keeps them: Python's truthiness and `str()`, which the console's filters and columns compare against.

use super::*;

/// Python's truthiness, for `attrs.get(key) or default`.
pub(crate) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64() != Some(0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(map)) => !map.is_empty(),
    }
}

/// Python's `str()` of an attribute value.
pub(crate) fn py_str(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Null => "None".into(),
        Value::Number(number) => match (number.as_i64(), number.as_f64()) {
            (Some(int), _) => int.to_string(),
            (None, Some(float)) if float.fract() == 0.0 && float.abs() < 1e16 => {
                format!("{float:.1}")
            }
            _ => number.to_string(),
        },
        other => other.to_string(),
    }
}

/// `str(attrs.get(key) or default)`.
pub(crate) fn or_default(attrs: &Attrs, key: &str, default: &str) -> String {
    let value = attrs.get(key);
    if truthy(value) {
        py_str(value.unwrap_or(&Value::Null))
    } else {
        default.into()
    }
}

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
        Some(other) => Some(py_str(other)),
    }
}

/// `_port`: an int, not a bool.
pub(crate) fn port(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64)
}
