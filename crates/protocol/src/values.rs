//! Attribute values as Python sees them: truthiness and `str()`.
//!
//! The first agent was a port of the Python SDK's code, and these rules stayed, whichever SDK sent the trace: issue
//! keys, fingerprints and the store's columns are built from them, so changing a rule splits the groups already
//! stored. `true` reads "True" from every SDK, and 1.0 reads "1.0".

use crate::Attrs;
use serde_json::Value;

/// Python's truthiness, for `attrs.get(key) or default`.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64() != Some(0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(map)) => !map.is_empty(),
    }
}

/// Python's `str()` of an attribute value, a missing one as `None`'s.
pub fn py_str(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "None".into(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(true)) => "True".into(),
        Some(Value::Bool(false)) => "False".into(),
        Some(Value::Number(number)) => match (number.as_i64(), number.as_f64()) {
            (Some(int), _) => int.to_string(),
            (None, Some(float)) if float.fract() == 0.0 && float.abs() < 1e16 => {
                format!("{float:.1}")
            }
            _ => number.to_string(),
        },
        Some(other) => other.to_string(),
    }
}

/// `str(attrs.get(key) or default)`.
pub fn or_default(attrs: &Attrs, key: &str, default: &str) -> String {
    let value = attrs.get(key);
    if truthy(value) {
        py_str(value)
    } else {
        default.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn python_views() {
        assert!(!truthy(None));
        assert!(!truthy(Some(&json!(0))));
        assert!(!truthy(Some(&json!(""))));
        assert!(truthy(Some(&json!("x"))));

        assert_eq!(py_str(None), "None");
        assert_eq!(py_str(Some(&json!(true))), "True");
        assert_eq!(py_str(Some(&json!(1.0))), "1.0");
    }
}
