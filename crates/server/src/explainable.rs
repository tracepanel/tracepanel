//! Which statements EXPLAIN may run, the rule every SDK and the console share (`schema/explainable.json` holds its
//! cases): a SELECT, or a WITH whose CTEs and final statement only read. Its words are read outside quoted strings
//! and names and comments, so a keyword in a string changes nothing.
//!
//! - It starts (after its comments) with SELECT, or with WITH and ends in a SELECT.
//! - It is one statement: nothing follows a `;` but comments.
//! - No INSERT, UPDATE, DELETE or MERGE anywhere (a data-modifying CTE) and no INTO (`SELECT … INTO` makes a table).
//! - ANALYZE runs it, so a SELECT that locks rows (`FOR UPDATE`, `FOR SHARE`, `LOCK IN SHARE MODE`) is explained
//!   but not analyzed. The app runs ANALYZE in a transaction it rolls back.

pub(crate) const NOT_SELECT: &str = "Only SELECT statements can be explained.";
const ONE_STATEMENT: &str = "Only one statement can be explained at a time.";
const CHANGING: [&str; 4] = ["INSERT", "UPDATE", "DELETE", "MERGE"];
/// What can follow a WITH's CTEs: the statement they are for.
const MAIN: [&str; 7] = [
    "SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "VALUES", "TABLE",
];

/// A word (upper-cased) or any other token (a quoted string or name, a number, a sign), with its depth in parentheses.
#[derive(Debug)]
struct Token {
    text: String,
    word: bool,
    depth: usize,
}

/// Why a statement isn't explained (or with `analyze`, analyzed), or None when it is.
pub(crate) fn refusal(statement: &str, analyze: bool) -> Option<String> {
    let tokens = tokens(statement);
    let words: Vec<&str> = tokens
        .iter()
        .map(|token| if token.word { token.text.as_str() } else { "" })
        .collect();
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
    let main = if with {
        tokens
            .iter()
            .position(|token| token.word && token.depth == 0 && MAIN.contains(&token.text.as_str()))
    } else {
        Some(0)
    };
    let previous = |at: usize| at.checked_sub(1).map_or("", |before| words[before]);
    let lock = |at: usize| matches!(previous(at), "FOR" | "KEY");
    for (at, word) in words.iter().enumerate() {
        if CHANGING.contains(word) && !(*word == "UPDATE" && lock(at)) {
            let inside = if with && main.is_none_or(|main| at < main) {
                " inside WITH"
            } else {
                ""
            };
            return Some(changes(&format!("{word}{inside}")));
        }
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
            "UPDATE" if lock(at) => "FOR UPDATE",
            "SHARE" if lock(at) => "FOR SHARE",
            "SHARE" if previous(at) == "IN" && at >= 2 && words[at - 2] == "LOCK" => {
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

/// The statement's tokens, without its comments and spaces: a quoted string or name (`'…'` with `''`, `E'…'` with
/// backslashes too, `"…"`, `` `…` ``, `[…]`, PostgreSQL's `$tag$…$tag$`) is one token whose text is never read. The
/// inside of MySQL's `/*! … */`, which MySQL runs, is read as the statement.
fn tokens(statement: &str) -> Vec<Token> {
    let chars: Vec<char> = statement.chars().collect();
    let mut tokens: Vec<Token> = Vec::new();
    let mut depth = 0usize;
    let mut at = 0;
    while let Some(&char) = chars.get(at) {
        let next = chars.get(at + 1).copied().unwrap_or_default();
        let (text, word) = if char.is_whitespace() {
            at += 1;
            continue;
        } else if char == '-' && next == '-' {
            at = past(&chars, at + 2, &['\n']);
            continue;
        } else if char == '/' && next == '*' {
            at = if chars.get(at + 2) == Some(&'!') {
                at + 3
            } else {
                past(&chars, at + 2, &['*', '/'])
            };
            continue;
        } else if char == '\'' {
            // E'…' (PostgreSQL's escape string): a backslash escapes the next character.
            let escapes = at > 0
                && matches!(chars[at - 1], 'E' | 'e')
                && tokens
                    .last()
                    .is_some_and(|last| last.word && last.text == "E");
            at = quoted(&chars, at, '\'', escapes);
            ("'".into(), false)
        } else if char == '"' || char == '`' {
            at = quoted(&chars, at, char, false);
            (char.into(), false)
        } else if char == '[' && (next.is_alphabetic() || next == '_') {
            at = past(&chars, at + 1, &[']']);
            ("[".into(), false)
        } else if let Some(tag) = (char == '$').then(|| dollar_tag(&chars, at)).flatten() {
            at = past(&chars, at + tag.len(), &tag);
            ("$".into(), false)
        } else if char.is_alphabetic() || char == '_' {
            let start = at;
            while chars
                .get(at)
                .is_some_and(|&char| char.is_alphanumeric() || char == '_' || char == '$')
            {
                at += 1;
            }
            let word: String = chars[start..at].iter().collect();
            (word.to_uppercase(), true)
        } else if char.is_ascii_digit() {
            while chars
                .get(at)
                .is_some_and(|&char| char.is_alphanumeric() || char == '_' || char == '.')
            {
                at += 1;
            }
            ("0".into(), false)
        } else {
            at += 1;
            (char.into(), false)
        };
        if text == ")" {
            depth = depth.saturating_sub(1);
        }
        tokens.push(Token { text, word, depth });
        if tokens
            .last()
            .is_some_and(|token| token.text == "(" && !token.word)
        {
            depth += 1;
        }
    }
    tokens
}

/// Where a quote opened at `at` ends: past its closing `quote` (doubled, it is one inside), or the statement's end.
fn quoted(chars: &[char], at: usize, quote: char, escapes: bool) -> usize {
    let mut at = at + 1;
    while let Some(&char) = chars.get(at) {
        // A backslash (where it escapes) or a doubled quote: two characters of the string.
        let pair =
            (escapes && char == '\\') || (char == quote && chars.get(at + 1) == Some(&quote));
        if pair {
            at += 2;
        } else if char == quote {
            return at + 1;
        } else {
            at += 1;
        }
    }
    chars.len()
}

/// Past the first `end` from `from` on, or the statement's end.
fn past(chars: &[char], from: usize, end: &[char]) -> usize {
    (from..chars.len())
        .find(|&at| chars[at..].starts_with(end))
        .map_or(chars.len(), |at| at + end.len())
}

/// PostgreSQL's dollar quote opening at `at`: `$$` or `$tag$` (not a `$1` parameter).
fn dollar_tag(chars: &[char], at: usize) -> Option<Vec<char>> {
    let mut end = at + 1;
    while let Some(&char) = chars.get(end) {
        if char == '$' {
            return Some(chars[at..=end].to_vec());
        }
        let first = end == at + 1;
        if !(char.is_alphabetic() || char == '_' || (!first && char.is_ascii_digit())) {
            return None;
        }
        end += 1;
    }
    None
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
