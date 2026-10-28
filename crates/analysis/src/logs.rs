//! A log record's text as a terminal would show it: a coloured logger (GraphQL Yoga's, uvicorn's, a Node app's
//! `chalk`) writes ANSI escape sequences into its lines, and they reach the trace as they were written. Stored without
//! them: the console shows the text, and a search for a word finds it whatever colour it was in.

use serde_json::Value;
use tracepanel_protocol::Received;

const ESC: char = '\u{1b}';
/// The 8-bit Control Sequence Introducer, ESC [ in one character.
const CSI: char = '\u{9b}';
const BEL: char = '\u{7}';

/// The text without its ANSI escape sequences: colours and styles (SGR, `ESC[1;32m`), any other control sequence
/// (`ESC[2K`), operating system commands (a hyperlink, `ESC]8;;url ESC\`) and two-character escapes. The rest is
/// left as it was.
pub fn without_ansi(text: &str) -> String {
    if !text.contains([ESC, CSI]) {
        return text.to_owned();
    }
    let mut clean = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            ESC => match chars.next() {
                Some('[') => skip_control(&mut chars),
                Some(']' | 'P' | '_' | '^' | 'X') => skip_string(&mut chars),
                // ESC and one character (ESC 7, ESC =); a lone ESC at the end goes too.
                _ => {}
            },
            CSI => skip_control(&mut chars),
            _ => clean.push(c),
        }
    }
    clean
}

/// A control sequence's parameters and intermediates, up to and with its final byte (@ to ~).
fn skip_control(chars: &mut std::iter::Peekable<impl Iterator<Item = char>>) {
    while let Some(&c) = chars.peek() {
        // Not part of a control sequence: a broken one ends before it, and it stays.
        if !(' '..='~').contains(&c) {
            return;
        }
        chars.next();
        if ('@'..='~').contains(&c) {
            return;
        }
    }
}

/// An operating system command (or another string sequence), up to its terminator: BEL or ESC \.
fn skip_string(chars: &mut std::iter::Peekable<impl Iterator<Item = char>>) {
    while let Some(c) = chars.next() {
        if c == BEL {
            return;
        }
        if c == ESC {
            if chars.peek() == Some(&'\\') {
                chars.next();
            }
            return;
        }
    }
}

fn has_ansi(text: &str) -> bool {
    text.contains([ESC, CSI])
}

/// The trace's log records without ANSI escape sequences in their message, logger and exception, in its rows and in
/// its document. A trace without any is left as it came (most are: its document isn't parsed).
pub fn normalize(received: &mut Received) {
    let found = received.trace.logs.iter().any(|log| {
        has_ansi(&log.message)
            || has_ansi(&log.logger)
            || log.exception.as_deref().is_some_and(has_ansi)
    });
    if !found {
        return;
    }
    for log in &mut received.trace.logs {
        log.message = without_ansi(&log.message);
        log.logger = without_ansi(&log.logger);
        log.exception = log.exception.as_deref().map(without_ansi);
    }
    let Ok(mut doc) = serde_json::from_str::<Value>(&received.doc) else {
        return;
    };
    for log in doc
        .get_mut("logs")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        for key in ["message", "logger", "exception"] {
            if let Some(Value::String(text)) = log.get_mut(key)
                && has_ansi(text)
            {
                *text = without_ansi(text);
            }
        }
    }
    received.doc = doc.to_string();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tracepanel_protocol::Trace;

    #[test]
    fn colours_and_styles_go_and_the_text_stays() {
        assert_eq!(
            without_ansi("\u{1b}[35mGraphQL\u{1b}[39m \u{1b}[1;32mquery\u{1b}[0m Books"),
            "GraphQL query Books"
        );

        assert_eq!(
            without_ansi("\u{1b}[38;5;208mINFO\u{1b}[m done"),
            "INFO done"
        );

        assert_eq!(without_ansi("\u{1b}[38;2;255;0;0mred\u{1b}[0m"), "red");
    }

    #[test]
    fn other_sequences_go_too() {
        // Erase the line, the cursor home, 8-bit CSI, a hyperlink (both terminators), a two-character escape.
        assert_eq!(without_ansi("\u{1b}[2K\u{1b}[Hdone"), "done");

        assert_eq!(without_ansi("\u{9b}31mred\u{9b}0m"), "red");

        assert_eq!(
            without_ansi("see \u{1b}]8;;https://example.com\u{1b}\\docs\u{1b}]8;;\u{1b}\\ now"),
            "see docs now"
        );

        assert_eq!(without_ansi("\u{1b}]0;title\u{7}text"), "text");

        assert_eq!(without_ansi("\u{1b}7saved\u{1b}8"), "saved");
    }

    #[test]
    fn text_without_sequences_and_broken_ones_keep_their_text() {
        assert_eq!(without_ansi("plain [1;32m text"), "plain [1;32m text");

        assert_eq!(without_ansi("ünïcode ✓"), "ünïcode ✓");

        // A sequence cut off: what follows its parameters stays.
        assert_eq!(without_ansi("cut \u{1b}[31\nnext"), "cut \nnext");

        assert_eq!(without_ansi("end \u{1b}"), "end ");
    }

    fn received(doc: serde_json::Value) -> Received {
        let text = doc.to_string();
        Received {
            trace: serde_json::from_str::<Trace>(&text).unwrap(),
            doc: text,
        }
    }

    fn trace(logs: serde_json::Value) -> serde_json::Value {
        json!({
            "id": "01J0000000000000000000000A",
            "kind": "request",
            "name": "POST /graphql",
            "start": 1,
            "duration": 2,
            "attrs": {},
            "spans": [],
            "logs": logs,
            "errors": [],
        })
    }

    #[test]
    fn records_lose_their_sequences_in_their_rows_and_their_document() {
        let mut found = received(trace(json!([{
            "span_id": null,
            "time": 1,
            "level": "INFO",
            "logger": "\u{1b}[2myoga\u{1b}[0m",
            "message": "\u{1b}[35mGraphQL\u{1b}[39m query Books",
            "exception": "\u{1b}[31mError\u{1b}[0m: boom",
            "attrs": {"keep": "\u{1b}[1mas sent\u{1b}[0m"},
        }])));

        normalize(&mut found);

        let log = &found.trace.logs[0];
        assert_eq!(
            (
                log.message.as_str(),
                log.logger.as_str(),
                log.exception.as_deref()
            ),
            ("GraphQL query Books", "yoga", Some("Error: boom"))
        );

        let doc: serde_json::Value = serde_json::from_str(&found.doc).unwrap();
        assert_eq!(
            doc["logs"],
            json!([{
                "span_id": null,
                "time": 1,
                "level": "INFO",
                "logger": "yoga",
                "message": "GraphQL query Books",
                "exception": "Error: boom",
                "attrs": {"keep": "\u{1b}[1mas sent\u{1b}[0m"},
            }])
        );
    }

    #[test]
    fn a_trace_without_sequences_keeps_its_document_as_it_came() {
        let doc = trace(json!([{
            "time": 1, "level": "INFO", "logger": "app", "message": "plain", "exception": null,
        }]));
        let mut found = received(doc.clone());
        let before = found.doc.clone();

        normalize(&mut found);

        assert_eq!(found.doc, before);
    }
}
