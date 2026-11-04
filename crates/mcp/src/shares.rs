//! Where a trace's time went, moment by moment, in one set of shares: the console's rule
//! (`ui/packages/ui/src/lib/timeShares.ts`), its cases in `schema/waits.json`. Spans say what ran when (a query is the
//! database's time, a pause the collector's); in a span's own code, a timed profile says, bucket by bucket, how much
//! of it waited, ran the project's code, or ran only the framework's. get_profile reads a timed profile by it, so its
//! numbers are the console's: the time strip's legend, the call tree's code rows, the Profile tab.

use crate::compact::int;
use crate::waits;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use tracepanel_analysis::stretches::{OWN_CODE, Stretch, spans_of, stretches};

/// The collector's pauses: a share of their own.
pub(crate) const GC: &str = "gc";
/// The code's waits: a share of their own.
pub(crate) const WAITING: &str = "waiting";
/// A span's own code a timed profile has no samples of (before its first sample): a share of its own, neither the
/// project's code's nor the framework's.
pub(crate) const NOT_PROFILED: &str = "unprofiled";

/// A share's name, as the console's legend says it: "Database", "GC", "Framework & middleware".
pub(crate) fn label(share: &str) -> &'static str {
    match share {
        GC => "GC",
        WAITING => "Waiting",
        NOT_PROFILED => "Not profiled",
        "django" => "Framework & middleware",
        "code" => "Your code",
        "signal" => "Signals",
        "template" => "Templates",
        "sql" => "Database",
        "redis" => "Redis",
        "cache" => "Cache",
        "datastore" => "Datastores",
        "messaging" => "Messaging",
        "http" => "External calls",
        "storage" => "Storage",
        "llm" => "LLM",
        "mail" => "Email",
        _ => "Other",
    }
}

/// The collector's pauses on the trace's clock, within it and in order.
fn gc_pauses(raw: &Value, total: f64) -> Vec<(f64, f64)> {
    let mut pauses: Vec<(f64, f64)> = raw
        .pointer("/gc/pauses")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|pause| {
            let from = pause.get(0)?.as_f64()?;
            let length = pause.get(1)?.as_f64()?;
            Some((from.min(total), (from + length).min(total)))
        })
        .filter(|(from, to)| to > from)
        .collect();
    pauses.sort_by(|a, b| a.0.total_cmp(&b.0));
    pauses
}

/// A stretch cut by the pauses: its parts outside them, and those inside (`true`).
fn cut_by_pauses(from: f64, to: f64, pauses: &[(f64, f64)]) -> Vec<((f64, f64), bool)> {
    let mut edges = vec![from];
    for &(start, end) in pauses {
        let (start, end) = (start.max(from), end.min(to));
        if end > start {
            edges.extend([start, end]);
        }
    }
    edges.push(to);
    edges
        .windows(2)
        .enumerate()
        .map(|(index, pair)| ((pair[0], pair[1]), index % 2 == 1))
        .filter(|((start, end), _)| end > start)
        .collect()
}

/// What a stack of the profile is to the split: whether its innermost frame waits, and whether it ran the
/// project's code (a frame of its on it, and not tracing's own code at its tip).
pub(crate) struct StackKind {
    pub(crate) waits: bool,
    pub(crate) yours: bool,
}

/// A stretch of the trace's time and the share it went to, with the stacks running then and their time in it (µs,
/// by stack index); none where the profile can't say.
pub(crate) struct Segment<'a> {
    pub(crate) from: f64,
    pub(crate) to: f64,
    pub(crate) share: &'static str,
    pub(crate) span: &'a Value,
    pub(crate) stacks: Option<Vec<(usize, f64)>>,
}

/// Each bucket's stacks and how often each was seen; a bucket without samples as the one before it. Before the first
/// sample, none: not profiled (the console's `bucketStacks`).
fn bucket_stacks(raw: &Value, duration: f64, width: f64) -> BTreeMap<i64, Vec<(usize, f64)>> {
    let mut seen: BTreeMap<i64, Vec<(usize, f64)>> = BTreeMap::new();
    for (index, stack) in raw
        .get("stacks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        for pair in stack
            .get("at")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let (Some(bucket), Some(count)) = (
                pair.get(0).and_then(Value::as_i64),
                pair.get(1).and_then(Value::as_f64),
            ) else {
                continue;
            };
            if count > 0.0 {
                seen.entry(bucket).or_default().push((index, count));
            }
        }
    }
    let mut buckets = BTreeMap::new();
    let mut before: Option<Vec<(usize, f64)>> = None;
    let mut bucket = 0;
    while (bucket as f64) * width < duration {
        if let Some(here) = seen.get(&bucket) {
            before = Some(here.clone());
        }
        if let Some(stacks) = &before {
            buckets.insert(bucket, stacks.clone());
        }
        bucket += 1;
    }
    buckets
}

/// Each stack's time, scaled to a stretch `length` long: by how often each was seen.
fn scaled(stacks: &[(usize, f64)], length: f64) -> Vec<(usize, f64)> {
    let total: f64 = stacks.iter().map(|(_, count)| count).sum();
    stacks
        .iter()
        .map(|&(index, count)| (index, length * count / total))
        .collect()
}

/// The categories a stack's own time is split by what it ran: the project's code's, or the framework's.
const BY_STACK: [&str; 2] = ["code", "django"];

/// A span's own code in a bucket in its parts: what waited; in a handler's or a framework's span (a request's root,
/// a middleware), what ran the project's code (Your code) and what ran only the framework's, whichever span it ran
/// under; in a signal's or a template's, its category's. In turn one way in even buckets and the other in odd.
fn own_parts(
    kinds: &[StackKind],
    category: &'static str,
    stacks: &[(usize, f64)],
    bucket: i64,
) -> Vec<(&'static str, Vec<(usize, f64)>)> {
    let mut order: Vec<&'static str> = Vec::new();
    for share in [category, "code", "django", WAITING] {
        if !order.contains(&share) {
            order.push(share);
        }
    }
    let mut groups: Vec<(&'static str, Vec<(usize, f64)>)> =
        order.into_iter().map(|share| (share, vec![])).collect();
    for &(index, count) in stacks {
        let kind = kinds.get(index);
        let share = if kind.is_some_and(|kind| kind.waits) {
            WAITING
        } else if !BY_STACK.contains(&category) {
            category
        } else if kind.is_some_and(|kind| kind.yours) {
            "code"
        } else {
            "django"
        };
        if let Some(group) = groups.iter_mut().find(|(each, _)| *each == share) {
            group.1.push((index, count));
        }
    }
    groups.retain(|(_, group)| !group.is_empty());
    if bucket % 2 != 0 {
        groups.reverse();
    }
    groups
}

/// What each stack of a profile is to the split: whether it waits, whether it ran the project's code (a frame of
/// its on it, and not tracing's own code at its tip): the console's `waits` and `runsYours`.
pub(crate) fn stack_kinds(raw: &Value) -> Vec<StackKind> {
    let frames = raw
        .get("frames")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    let in_app = |frame: &Value| frame.get("in_app").and_then(Value::as_bool) == Some(true);
    raw.get("stacks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|stack| {
            let path: Vec<&Value> = stack
                .get("frames")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|at| frames.get(at.as_u64()? as usize))
                .collect();
            let leaf = path.last();
            let tracing = leaf.is_some_and(|leaf| {
                !in_app(leaf)
                    && tracepanel_analysis::profiles::tracing(
                        leaf.get("module").and_then(Value::as_str).unwrap_or(""),
                        leaf.get("file").and_then(Value::as_str).unwrap_or(""),
                    )
            });
            StackKind {
                waits: leaf
                    .is_some_and(|leaf| leaf.get("waiting").and_then(Value::as_bool) == Some(true)),
                yours: path.iter().any(|frame| in_app(frame)) && !tracing,
            }
        })
        .collect()
}

/// Whether a profile says when its stacks were seen: its buckets' width, and buckets on its stacks (the console's
/// `timed`).
pub(crate) fn timed(raw: &Value) -> bool {
    int(raw, "bucket_us") > 0
        && raw
            .get("stacks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|stack| {
                stack
                    .get("at")
                    .and_then(Value::as_array)
                    .is_some_and(|at| !at.is_empty())
            })
}

/// A profile with no samples at all (a Go request shorter than its profiler's tick): it says when nothing ran.
pub(crate) fn empty(raw: &Value) -> bool {
    raw.get("stacks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .all(|stack| int(stack, "count") <= 0)
}

/// The trace's time in segments, in order (the console's `segmentsOf`): each span's stretches, the collector's
/// pauses cut out as GC's, and, with a timed profile, each bucket of a span's own code in its parts. With a profile
/// that has no samples, a span's own code is not profiled; the spans say the rest.
pub(crate) fn segments<'a>(doc: &'a Value, kinds: &[StackKind]) -> Vec<Segment<'a>> {
    let raw = doc.get("profile").filter(|raw| raw.is_object());
    let duration = int(doc, "duration") as f64;
    let width = match raw {
        Some(raw) if timed(raw) => int(raw, "bucket_us") as f64,
        _ => 0.0,
    };
    let unsampled = width > 0.0 || raw.is_some_and(empty);
    let spans = spans_of(doc);
    let by_id: HashMap<&str, &Value> = spans.iter().map(|span| (span.id, span.raw)).collect();
    let buckets = match raw {
        Some(raw) if width > 0.0 => bucket_stacks(raw, duration, width),
        _ => BTreeMap::new(),
    };
    let pauses = raw.map_or_else(Vec::new, |raw| gc_pauses(raw, duration));
    let mut out = Vec::new();
    for stretch in stretches(doc, &spans) {
        let span = by_id[stretch.span];
        // Only the trace's own time: a span that ends after it (its exporter's clock) counts up to its end.
        let (from, to) = (stretch.from.max(0.0), stretch.to.min(duration));
        if to <= from {
            continue;
        }
        for ((from, to), gc) in cut_by_pauses(from, to, &pauses) {
            let plain = if gc { GC } else { stretch.category };
            if width <= 0.0 {
                let share = if unsampled && !gc && OWN_CODE.contains(&stretch.category) {
                    NOT_PROFILED
                } else {
                    plain
                };
                out.push(Segment {
                    from,
                    to,
                    share,
                    span,
                    stacks: None,
                });
                continue;
            }
            let mut bucket = (from / width).floor() as i64;
            while (bucket as f64) * width < to {
                let (start, end) = (
                    from.max(bucket as f64 * width),
                    to.min((bucket + 1) as f64 * width),
                );
                if end > start {
                    let stacks = buckets.get(&bucket).filter(|stacks| !stacks.is_empty());
                    out.extend(bucket_segments(
                        kinds,
                        &stretch,
                        span,
                        (start, end),
                        gc,
                        stacks,
                        bucket,
                    ));
                }
                bucket += 1;
            }
        }
    }
    out
}

/// A stretch of one span's time inside one bucket, in its segments.
fn bucket_segments<'a>(
    kinds: &[StackKind],
    stretch: &Stretch,
    span: &'a Value,
    (from, to): (f64, f64),
    gc: bool,
    stacks: Option<&Vec<(usize, f64)>>,
    bucket: i64,
) -> Vec<Segment<'a>> {
    let plain = if gc { GC } else { stretch.category };
    let Some(stacks) = stacks else {
        // A span's own code the profile didn't sample is said so; a call's or the collector's time is theirs.
        let share = if !gc && OWN_CODE.contains(&stretch.category) {
            NOT_PROFILED
        } else {
            plain
        };
        return vec![Segment {
            from,
            to,
            share,
            span,
            stacks: None,
        }];
    };
    if gc || !OWN_CODE.contains(&stretch.category) {
        return vec![Segment {
            from,
            to,
            share: plain,
            span,
            stacks: Some(scaled(stacks, to - from)),
        }];
    }
    let parts = own_parts(kinds, stretch.category, stacks, bucket);
    let total: f64 = stacks.iter().map(|(_, count)| count).sum();
    let mut out = Vec::new();
    let mut at = from;
    let last = parts.len().saturating_sub(1);
    for (index, (share, group)) in parts.into_iter().enumerate() {
        let seen: f64 = group.iter().map(|(_, count)| count).sum();
        let end = if index == last {
            to
        } else {
            at + (to - from) * seen / total
        };
        if end > at {
            out.push(Segment {
                from: at,
                to: end,
                share,
                span,
                stacks: Some(scaled(&group, end - at)),
            });
        }
        at = end;
    }
    out
}

/// The frame a segment's time goes under, where its share isn't the code's own or a wait: a call's (named by it:
/// `SQL postgresql`), the collector's, the framework's; with its share's name.
pub(crate) fn share_frame(segment: &Segment) -> Option<(String, &'static str)> {
    if segment.share == "code" || segment.share == WAITING {
        return None;
    }
    let share = label(segment.share);
    let call =
        segment.share != GC && segment.share != NOT_PROFILED && !OWN_CODE.contains(&segment.share);
    let function = if call {
        waits::call_label(segment.span)
    } else {
        share.to_owned()
    };
    Some((function, share))
}

/// Times rounded to `step` so they add up to `target` steps: each rounded down, the steps left to those that lost
/// most (largest remainder), the first of them on a tie.
pub(crate) fn apportion(values: &[f64], step: f64, target: i64) -> Vec<f64> {
    let mut floors: Vec<i64> = values
        .iter()
        .map(|value| (value / step + 1e-9).floor() as i64)
        .collect();
    let remainder = |at: usize| {
        let value = values[at] / step;
        value - (value + 1e-9).floor()
    };
    let mut order: Vec<usize> = (0..values.len()).collect();
    order.sort_by(|&a, &b| remainder(b).total_cmp(&remainder(a)).then(a.cmp(&b)));
    let mut left = target - floors.iter().sum::<i64>();
    for at in order {
        if left <= 0 {
            break;
        }
        floors[at] += 1;
        left -= 1;
    }
    floors
        .into_iter()
        .map(|steps| steps as f64 * step)
        .collect()
}

/// The shares of `whole` that `parts` are, as whole percents that add up as the parts do (100% for parts that make
/// the whole), rounded by largest remainder as the console's legend says them: 7, 3, 2 and 125 ms of 137 read 5%,
/// 2%, 2%, 91%. A share neither none nor all never reads either: `<1%`, `>99%`.
pub(crate) fn percents(parts: &[f64], whole: f64) -> Vec<String> {
    if whole <= 0.0 {
        return parts.iter().map(|_| "0%".to_owned()).collect();
    }
    let exact: Vec<f64> = parts
        .iter()
        .map(|part| (part.max(0.0) / whole) * 100.0)
        .collect();
    let said = apportion(&exact, 1.0, exact.iter().sum::<f64>().round() as i64);
    parts
        .iter()
        .zip(said)
        .map(|(&part, said)| {
            if part <= 0.0 {
                "0%".to_owned()
            } else if part >= whole {
                "100%".to_owned()
            } else if said <= 0.0 {
                "<1%".to_owned()
            } else if said >= 100.0 {
                ">99%".to_owned()
            } else {
                format!("{said:.0}%")
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{apportion, percents};

    #[test]
    fn percents_said_add_up_to_100() {
        // A Node task's legend: 7, 3, 2 and 125 ms of 137 ms read 5%, 2%, 1%, 91% rounded each (99% in all).
        assert_eq!(
            percents(&[7_000.0, 3_000.0, 2_000.0, 125_000.0], 137_000.0),
            ["5%", "2%", "2%", "91%"]
        );
        assert_eq!(percents(&[1.0, 388.0], 389.0), ["<1%", ">99%"]);
    }

    #[test]
    fn parts_said_add_up_to_the_total_said() {
        // A code row's profile: 6.9 ms and 3.56 ms of 10.46 ms read 7 + 4 = 11 of 10, rounded each.
        assert_eq!(apportion(&[6900.0, 3560.0], 1000.0, 10), [7000.0, 3000.0]);
    }
}
