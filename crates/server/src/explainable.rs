//! Which statements EXPLAIN may run, the rule every SDK and the console share (`schema/explainable.json` holds its
//! cases): a SELECT, or a WITH whose CTEs and final statement only read. Its words are read outside quoted strings
//! and names and comments, so a keyword in a string changes nothing.
//!
//! - It starts (after its comments) with SELECT, or with WITH and ends in a SELECT.
//! - It is one statement: nothing follows a `;` but comments.
//! - No INSERT, UPDATE, DELETE or MERGE anywhere (a data-modifying CTE) and no INTO (`SELECT … INTO` makes a table).
//! - ANALYZE runs it, so a SELECT that locks rows (`FOR UPDATE`, `FOR SHARE`, `LOCK IN SHARE MODE`) is explained
//!   but not analyzed. The app runs ANALYZE in a transaction it rolls back.
//!
//! The statement's words are `tracepanel_analysis::sql`'s, which names a WITH statement by what it does too.

use tracepanel_analysis::sql::{change, locking, main, tokens, words};

pub(crate) const NOT_SELECT: &str = "Only SELECT statements can be explained.";
const ONE_STATEMENT: &str = "Only one statement can be explained at a time.";

/// Why a statement isn't explained (or with `analyze`, analyzed), or None when it is.
pub(crate) fn refusal(statement: &str, analyze: bool) -> Option<String> {
    let tokens = tokens(statement);
    let words = words(&tokens);
    let with = match words.first() {
        Some(&"SELECT") => false,
        Some(&"WITH") => true,
        _ => return Some(NOT_SELECT.into()),
    };
    let end = tokens
        .iter()
        .position(|token| token.depth == 0 && !token.word && token.text == ";");
    if end.is_some_and(|end| end + 1 < tokens.len()) {
        return Some(ONE_STATEMENT.into());
    }
    let main = if with { main(&tokens) } else { Some(0) };
    if let Some(at) = change(&words) {
        let inside = if with && main.is_none_or(|main| at < main) {
            " inside WITH"
        } else {
            ""
        };
        return Some(changes(&format!("{}{inside}", words[at])));
    }
    if words.contains(&"INTO") {
        return Some(changes("SELECT INTO"));
    }
    if main.is_none_or(|main| words[main] != "SELECT") {
        return Some(NOT_SELECT.into());
    }
    if !analyze {
        return None;
    }
    words.iter().enumerate().find_map(|(at, word)| {
        let locks = match *word {
            "UPDATE" if locking(&words, at) => "FOR UPDATE",
            "SHARE" if locking(&words, at) => "FOR SHARE",
            "SHARE" if at >= 2 && words[at - 1] == "IN" && words[at - 2] == "LOCK" => {
                "LOCK IN SHARE MODE"
            }
            _ => return None,
        };
        Some(format!(
            "This query locks rows ({locks}): it can be explained, not analyzed."
        ))
    })
}

fn changes(what: &str) -> String {
    format!("This query changes data ({what}): it isn't explained.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn the_shared_cases() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../../schema/explainable.json")).unwrap();

        for case in &cases {
            let sql = case["sql"].as_str().unwrap();
            let expected = (
                case["explain"].as_str().map(str::to_owned),
                case["analyze"].as_str().map(str::to_owned),
            );

            assert_eq!((refusal(sql, false), refusal(sql, true)), expected, "{sql}");
        }
    }
}
