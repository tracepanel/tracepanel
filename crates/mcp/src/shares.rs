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

/// A share's name, as the console's legend says it: "Database", "GC", "Framework & middleware".
pub(crate) fn label(share: &str, trace_kind: &str) -> &'static str {
    match share {
        GC => "GC",
        WAITING => "Waiting",
        "django" if trace_kind == "http" || trace_kind.is_empty() => "Framework & middleware",
        "django" => "Framework",
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

/// A span's own code in a bucket in its parts: what ran the project's code (its category's), what ran only the
/// framework's (a view's: the framework's share), what waited; in turn one way in even buckets and the other in odd.
fn own_parts(
    kinds: &[StackKind],
    category: &'static str,
    stacks: &[(usize, f64)],
    bucket: i64,
) -> Vec<(&'static str, Vec<(usize, f64)>)> {
    let mut groups: Vec<(&'static str, Vec<(usize, f64)>)> =
        vec![(category, vec![]), ("django", vec![]), (WAITING, vec![])];
    for &(index, count) in stacks {
        let kind = kinds.get(index);
        let share = if kind.is_some_and(|kind| kind.waits) {
            WAITING
        } else if category == "code" && !kind.is_some_and(|kind| kind.yours) {
            "django"
        } else {
            category
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

/// The trace's time in segments, in order (the console's `segmentsOf`): each span's stretches, the collector's
/// pauses cut out as GC's, and, with a timed profile, each bucket of a span's own code in its parts.
pub(crate) fn segments<'a>(doc: &'a Value, kinds: &[StackKind]) -> Vec<Segment<'a>> {
    let Some(raw) = doc.get("profile") else {
        return Vec::new();
    };
    let duration = int(doc, "duration") as f64;
    let width = int(raw, "bucket_us") as f64;
    let spans = spans_of(doc);
    let by_id: HashMap<&str, &Value> = spans.iter().map(|span| (span.id, span.raw)).collect();
    let buckets = if width > 0.0 {
        bucket_stacks(raw, duration, width)
    } else {
        BTreeMap::new()
    };
    let pauses = gc_pauses(raw, duration);
    let mut out = Vec::new();
    for stretch in stretches(doc, &spans) {
        let span = by_id[stretch.span];
        for ((from, to), gc) in cut_by_pauses(stretch.from, stretch.to, &pauses) {
            let plain = if gc { GC } else { stretch.category };
            if width <= 0.0 {
                out.push(Segment {
                    from,
                    to,
                    share: plain,
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
        return vec![Segment {
            from,
            to,
            share: plain,
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
pub(crate) fn share_frame(segment: &Segment, trace_kind: &str) -> Option<(String, &'static str)> {
    if segment.share == "code" || segment.share == WAITING {
        return None;
    }
    let share = label(segment.share, trace_kind);
    let call = segment.share != GC && !OWN_CODE.contains(&segment.share);
    let function = if call {
        waits::call_label(segment.span)
    } else {
        share.to_owned()
    };
    Some((function, share))
}

/// The step a time is said in (the console's duration): a tenth of a second from a second on, a millisecond from
/// one, a tenth of one, else a microsecond.
pub(crate) fn display_step(us: f64) -> f64 {
    if (us / 1000.0).round() >= 1000.0 {
        100_000.0
    } else if us >= 1000.0 {
        1000.0
    } else if us >= 100.0 {
        100.0
    } else {
        1.0
    }
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

/// Times as said: rounded to the step their total is said in, adding up to that total as said.
pub(crate) fn rounded<K: Clone>(times: &[(K, f64)]) -> Vec<(K, f64)> {
    let total: f64 = times.iter().map(|(_, us)| us).sum();
    let step = display_step(total);
    let values: Vec<f64> = times.iter().map(|(_, us)| *us).collect();
    let parts = apportion(&values, step, (total / step).round() as i64);
    times
        .iter()
        .zip(parts)
        .map(|((key, _), us)| (key.clone(), us))
        .collect()
}

/// The trace's time by share (µs), as said: what the console's time strip legend and Profile tab bar say.
pub(crate) fn share_times(segments: &[Segment]) -> Vec<(&'static str, f64)> {
    let mut times: Vec<(&'static str, f64)> = Vec::new();
    for segment in segments {
        let time = segment.to - segment.from;
        match times.iter_mut().find(|(share, _)| *share == segment.share) {
            Some(found) => found.1 += time,
            None => times.push((segment.share, time)),
        }
    }
    rounded(&times)
}

#[cfg(test)]
mod tests {
    use super::{apportion, rounded};

    #[test]
    fn parts_said_add_up_to_the_total_said() {
        // A code row's profile: 6.9 ms and 3.56 ms of 10.46 ms read 7 + 4 = 11 of 10, rounded each.
        assert_eq!(apportion(&[6900.0, 3560.0], 1000.0, 10), [7000.0, 3000.0]);
        assert_eq!(
            rounded(&[("a", 33_400.0), ("b", 14_300.0), ("c", 60_300.0)]),
            [("a", 34_000.0), ("b", 14_000.0), ("c", 60_000.0)]
        );
    }
}
