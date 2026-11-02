//! A statement's words, read outside its quoted strings and names and its comments, so a keyword in a string or a
//! name changes nothing: what EXPLAIN's rule (`schema/explainable.json`) and a WITH statement's name both read.
//!
//! A WITH is named by what it does, its CTEs included: by its first INSERT, UPDATE, DELETE or MERGE (a data-modifying
//! CTE's, or its final statement's), else by its final statement (a SELECT).

/// The words that change data.
pub const CHANGING: [&str; 4] = ["INSERT", "UPDATE", "DELETE", "MERGE"];
/// What can follow a WITH's CTEs: the statement they are for.
pub const MAIN: [&str; 7] = [
    "SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "VALUES", "TABLE",
];

/// A word (upper-cased) or any other token (a quoted string or name, a number, a sign), with its depth in parentheses
/// and where in the statement it starts (a byte offset).
#[derive(Debug)]
pub struct Token {
    pub text: String,
    pub word: bool,
    pub depth: usize,
    pub at: usize,
}

/// The tokens' words, an empty one for a token that isn't a word.
pub fn words(tokens: &[Token]) -> Vec<&str> {
    tokens
        .iter()
        .map(|token| if token.word { token.text.as_str() } else { "" })
        .collect()
}

/// Whether the word at `at` is a lock's (FOR UPDATE, FOR NO KEY UPDATE, FOR KEY SHARE), not a statement's.
pub fn locking(words: &[&str], at: usize) -> bool {
    at.checked_sub(1)
        .is_some_and(|before| matches!(words[before], "FOR" | "KEY"))
}

/// The first word that changes data (INSERT, UPDATE, DELETE, MERGE; not a lock's UPDATE).
pub fn change(words: &[&str]) -> Option<usize> {
    words.iter().enumerate().position(|(at, word)| {
        CHANGING.contains(word) && !(*word == "UPDATE" && locking(words, at))
    })
}

/// The statement a WITH's CTEs are for: the first of `MAIN` outside parentheses. What comes before it is inside the
/// WITH.
pub fn main(tokens: &[Token]) -> Option<usize> {
    tokens
        .iter()
        .position(|token| token.word && token.depth == 0 && MAIN.contains(&token.text.as_str()))
}

/// What a WITH statement does, as its name says it.
#[derive(Debug, PartialEq)]
pub struct With {
    /// Its first word that changes data, else its final statement's (SELECT).
    pub verb: String,
    /// Where that word starts (a byte offset).
    pub at: usize,
    /// Where the words naming its table start (`FROM`, `INTO`, `UPDATE`, `JOIN`; a byte offset), outside strings,
    /// names and comments: the first after a verb that changes data, else the first of the statement.
    pub table: Option<usize>,
}

/// Whether a statement may be a WITH, cheaply, before reading its tokens: its first word past spaces and comments is
/// WITH, or a MySQL `/*! … */` comes first (MySQL runs what is inside it). Every SQL span is named through `with`: most
/// are no WITH, and are told so here without a token read.
pub fn may_be_with(statement: &str) -> bool {
    let mut rest = statement;
    loop {
        rest = rest.trim_start();
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.split_once('\n').map_or("", |(_, next)| next);
        } else if rest.starts_with("/*!") {
            return true;
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.split_once("*/").map_or("", |(_, next)| next);
        } else {
            break;
        }
    }
    rest.get(..4)
        .is_some_and(|word| word.eq_ignore_ascii_case("WITH"))
        && !rest[4..].starts_with(|next: char| next.is_alphanumeric() || next == '_')
}

/// What a WITH statement does. None for a statement that isn't a WITH, or one with no final statement.
pub fn with(statement: &str) -> Option<With> {
    if !may_be_with(statement) {
        return None;
    }
    let tokens = tokens(statement);
    let words = words(&tokens);
    if words.first() != Some(&"WITH") {
        return None;
    }
    let (at, from) = match change(&words) {
        Some(at) => (at, at),
        None => (main(&tokens)?, 0),
    };
    let table = words[from..]
        .iter()
        .position(|word| matches!(*word, "FROM" | "INTO" | "UPDATE" | "JOIN"))
        .map(|found| tokens[from + found].at);
    Some(With {
        verb: tokens[at].text.clone(),
        at: tokens[at].at,
        table,
    })
}

/// The statement's tokens, without its comments and spaces: a quoted string or name (`'…'` with `''`, `E'…'` with
/// backslashes too, `"…"`, `` `…` ``, `[…]`, PostgreSQL's `$tag$…$tag$`) is one token whose text is never read. The
/// inside of MySQL's `/*! … */`, which MySQL runs, is read as the statement.
pub fn tokens(statement: &str) -> Vec<Token> {
    let chars: Vec<char> = statement.chars().collect();
    let offsets: Vec<usize> = statement.char_indices().map(|(at, _)| at).collect();
    let mut tokens: Vec<Token> = Vec::new();
    let mut depth = 0usize;
    let mut at = 0;
    while let Some(&char) = chars.get(at) {
        let start = offsets[at];
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
            let first = at;
            while chars
                .get(at)
                .is_some_and(|&char| char.is_alphanumeric() || char == '_' || char == '$')
            {
                at += 1;
            }
            let word: String = chars[first..at].iter().collect();
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
        let opens = text == "(" && !word;
        tokens.push(Token {
            text,
            word,
            depth,
            at: start,
        });
        if opens {
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
