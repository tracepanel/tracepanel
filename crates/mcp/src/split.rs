//! Where a trace's time went, said once: the console's one result (`ui/packages/ui/src/lib/split.ts`), its cases in
//! `schema/waits.json`. Of the whole trace or of stretches of it, or of an app's traces in a chain: its shares in µs
//! and in percent, rounded once so the times add up to the total and the percents to 100%; how much of it the
//! profile covers (the rest its code's time it didn't sample: Not profiled); how many samples it is drawn from; what
//! it is of. get_profile says this and nothing it works out itself, so its numbers are the console's to the letter.

use crate::compact::int;
use crate::shares::{self, NOT_PROFILED, WAITING};
use serde_json::Value;

/// Stretches of a trace's time, in µs since it started, in order and apart.
pub(crate) type Windows = Vec<(f64, f64)>;

/// One of an app's traces in a chain, and the stretches of it taken (none: all of it).
pub(crate) type Part<'a> = (&'a Value, Option<&'a [(f64, f64)]>);

/// A share of the time as said: its time (µs, rounded with the rest), that time written, its percent.
pub(crate) struct SaidShare {
    pub(crate) share: &'static str,
    pub(crate) label: &'static str,
    pub(crate) us: f64,
    pub(crate) time: String,
    pub(crate) percent: String,
}

/// Where the time of a trace (or of stretches of it, or of an app's traces) went, as every view says it.
pub(crate) struct Split {
    /// What it is of: `the whole trace`, `93 ms – 100 ms`, `3 traces`.
    pub(crate) of: String,
    pub(crate) windows: Option<Windows>,
    /// Its time (µs): its shares' added up; and written at the split's step, as its shares are.
    pub(crate) total: f64,
    pub(crate) time: String,
    /// Largest first, waiting last; none with no time.
    pub(crate) shares: Vec<SaidShare>,
    /// How much of it the profile covers: all but its code's time before the first sample (Not profiled).
    // Said as `covered`; the number itself is the shared cases'.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) profiled: f64,
    pub(crate) covered: String,
    /// How many samples it is drawn from; 0 without a profile.
    pub(crate) samples: i64,
    /// `50 samples, one every 1 ms`, as the profile took them; none without a profile.
    pub(crate) sampled: Option<String>,
    /// The step its times are rounded to (µs): the one its smallest share is said in.
    pub(crate) step: f64,
}

impl Split {
    /// A share's said time and percent, where it has that share (by its name, as frames carry it).
    pub(crate) fn by_label(&self, label: &str) -> Option<&SaidShare> {
        self.shares.iter().find(|share| share.label == label)
    }

    /// The split as the shared cases (`schema/waits.json`) and the console write it.
    #[cfg(test)]
    pub(crate) fn json(&self) -> Value {
        serde_json::json!({
            "of": self.of,
            "windows": self.windows.as_ref().map(|windows| windows.iter().map(|&(from, to)| serde_json::json!([number(from), number(to)])).collect::<Vec<_>>()),
            "total": number(self.total),
            "time": self.time,
            "shares": self.shares.iter().map(|share| serde_json::json!([share.label, number(share.us), share.time, share.percent])).collect::<Vec<_>>(),
            "profiled": number(self.profiled),
            "covered": self.covered,
            "samples": self.samples,
            "sampled": self.sampled,
        })
    }

    /// `profiled of the trace's 123 ms`: what the profile covers is of, as a profile's head says it.
    pub(crate) fn of_what(&self) -> String {
        let time = &self.time;
        match &self.windows {
            None if self.of.ends_with("traces") => format!("the traces' {time}"),
            None => format!("the trace's {time}"),
            Some(windows) if windows.len() > 1 => format!("these stretches' {time}"),
            Some(_) => format!("the stretch's {time}"),
        }
    }
}

/// A whole number as one, else as it is: µs said are whole.
#[cfg(test)]
fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9e15 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}

/// The samples behind a split, as the profile took them.
#[derive(Clone)]
struct Samples {
    all: i64,
    cpu: i64,
    estimated: Option<i64>,
    spread: bool,
    interval: i64,
}

/// What a split adds up before it is said: each share's time, the samples behind it.
struct Raw {
    times: Vec<(&'static str, f64)>,
    samples: Option<Samples>,
}

/// How much of a stretch (`from`–`to`) the windows take (all of it with none).
pub(crate) fn taken(from: f64, to: f64, windows: Option<&[(f64, f64)]>) -> f64 {
    match windows {
        None => to - from,
        Some(windows) => windows.iter().fold(0.0, |sum, &(start, end)| {
            sum + (to.min(end) - from.max(start)).max(0.0)
        }),
    }
}

/// The profile's samples in the windows: by the buckets they were seen in, as much of each as the windows take.
fn samples_of(doc: &Value, windows: Option<&[(f64, f64)]>) -> Option<Samples> {
    let raw = doc.get("profile").filter(|raw| raw.is_object())?;
    let frames = raw
        .get("frames")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    let stacks = raw
        .get("stacks")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    let waits = |stack: &Value| {
        stack
            .get("frames")
            .and_then(Value::as_array)
            .and_then(|path| path.last())
            .and_then(Value::as_u64)
            .and_then(|leaf| frames.get(leaf as usize))
            .and_then(|leaf| leaf.get("waiting"))
            .and_then(Value::as_bool)
            == Some(true)
    };
    let samples = int(raw, "samples");
    let estimated = raw.get("estimated_from").and_then(Value::as_i64);
    let spread = raw.get("spread").and_then(Value::as_bool) == Some(true);
    let interval = int(raw, "interval_us");
    let Some(windows) = windows.filter(|_| shares::timed(raw)) else {
        let waited: i64 = stacks
            .iter()
            .filter(|stack| waits(stack))
            .map(|stack| int(stack, "count"))
            .sum();
        return Some(Samples {
            all: samples,
            cpu: samples - waited,
            estimated,
            spread,
            interval,
        });
    };
    let width = int(raw, "bucket_us") as f64;
    let (mut all, mut cpu) = (0.0, 0.0);
    for stack in stacks {
        for pair in stack
            .get("at")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let (Some(bucket), Some(count)) = (
                pair.get(0).and_then(Value::as_f64),
                pair.get(1).and_then(Value::as_f64),
            ) else {
                continue;
            };
            let part = taken(bucket * width, (bucket + 1.0) * width, Some(windows)) / width;
            let seen = count * part;
            all += seen;
            if !waits(stack) {
                cpu += seen;
            }
        }
    }
    let estimated = estimated
        .filter(|_| samples > 0)
        .map(|estimated| ((estimated as f64 * all) / samples as f64).round() as i64);
    Some(Samples {
        all: all.round() as i64,
        cpu: cpu.round() as i64,
        estimated,
        spread,
        interval,
    })
}

/// `1 sample`, `1,204 samples`: a count as the console writes one, its thousands apart.
pub(crate) fn counted(count: i64, one: &str, many: &str) -> String {
    let digits = count.to_string();
    let mut grouped = String::new();
    for (at, digit) in digits.chars().enumerate() {
        if at > 0 && (digits.len() - at).is_multiple_of(3) && digit.is_ascii_digit() {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    format!("{grouped} {}", if count == 1 { one } else { many })
}

/// What a CPU profile placed on the trace's clock (`spread`, Go's) says of its waits: they weren't sampled.
const SPREAD: &str =
    "spread evenly over your code's time, the rest of it waiting off the CPU (not sampled)";

/// `110 samples, one every 10 ms`: what the profile took, as the console's Profile tab says it.
fn sampled_line(samples: &Samples) -> String {
    if let Some(estimated) = samples.estimated {
        let line = format!(
            "CPU time estimated from {} (macOS hands the profiler's samples out unevenly, so each is weighed)",
            counted(estimated, "sample", "samples")
        );
        return if samples.spread {
            format!("{line}, {SPREAD}")
        } else {
            line
        };
    }
    let every = format!("one every {}", duration(samples.interval as f64));
    if samples.spread {
        return format!(
            "{} of CPU time, {every}, {SPREAD}",
            counted(samples.cpu, "sample", "samples")
        );
    }
    format!("{}, {every}", counted(samples.all, "sample", "samples"))
}

/// The time each share took in the windows (all of it with none), in the order the trace first had them.
fn raw_of(doc: &Value, windows: Option<&[(f64, f64)]>) -> Raw {
    let kinds = doc
        .get("profile")
        .map_or_else(Vec::new, shares::stack_kinds);
    let mut times: Vec<(&'static str, f64)> = Vec::new();
    for segment in shares::segments(doc, &kinds) {
        let time = taken(segment.from, segment.to, windows);
        if time > 0.0 {
            match times.iter_mut().find(|(share, _)| *share == segment.share) {
                Some(found) => found.1 += time,
                None => times.push((segment.share, time)),
            }
        }
    }
    Raw {
        times,
        samples: samples_of(doc, windows),
    }
}

/// The steps a split's times can be said at (µs): a tenth of a second, a millisecond, a tenth of one, a µs.
const STEPS: [f64; 4] = [100_000.0, 1000.0, 100.0, 1.0];

/// `1,204`: a whole number with its thousands apart.
fn thousands(value: i64) -> String {
    let digits = value.to_string();
    let mut out = String::new();
    for (at, digit) in digits.chars().enumerate() {
        if at > 0 && (digits.len() - at).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// A time (µs, a whole number of `step`s) written at the step, so the times of one split read in one precision and
/// add up as written (the console's `writtenAt`): `1.6 s`, `3 ms`, `0.8 ms`, `27 µs`, `47.059 ms`.
pub(crate) fn written_at(us: f64, step: f64, total: f64) -> String {
    let whole = us.round() as i64;
    if step >= 100_000.0 {
        format!(
            "{}.{} s",
            thousands(whole / 1_000_000),
            ((whole % 1_000_000) as f64 / 100_000.0).round()
        )
    } else if step >= 1000.0 {
        format!("{} ms", thousands((whole as f64 / 1000.0).round() as i64))
    } else if step >= 100.0 {
        format!(
            "{}.{} ms",
            thousands(whole / 1000),
            ((whole % 1000) as f64 / 100.0).round()
        )
    } else if total < 1000.0 {
        format!("{whole} µs")
    } else {
        format!("{}.{:03} ms", thousands(whole / 1000), whole % 1000)
    }
}

/// The times rounded at the coarsest step (from the one their total is said in) that loses none of them.
fn rounded_at(exact: &[f64]) -> (f64, Vec<f64>) {
    let sum = exact.iter().fold(0.0, |all, us| all + us);
    let from = shares::display_step(sum);
    for step in STEPS.into_iter().filter(|step| *step <= from) {
        let rounded = shares::apportion(exact, step, (sum / step).round() as i64);
        if step == 1.0 || rounded.iter().all(|us| *us > 0.0) {
            return (step, rounded);
        }
    }
    (1.0, exact.to_vec())
}

/// The raw times said: rounded at one step, the coarsest that keeps every share, adding up to their total rounded to
/// it, and written at it, so the times as read add up too; percents of that total, largest remainder, adding up to
/// 100%.
fn said(raw: Raw, of: String, windows: Option<Windows>) -> Split {
    let entries: Vec<(&'static str, f64)> =
        raw.times.into_iter().filter(|(_, us)| *us > 0.0).collect();
    let exact: Vec<f64> = entries.iter().map(|(_, us)| *us).collect();
    let (step, rounded) = rounded_at(&exact);
    let mut shares: Vec<SaidShare> = entries
        .iter()
        .zip(rounded)
        .filter(|(_, us)| *us > 0.0)
        .map(|(&(share, _), us)| SaidShare {
            share,
            label: shares::label(share),
            us,
            time: String::new(),
            percent: String::new(),
        })
        .collect();
    let total = shares.iter().fold(0.0, |sum, share| sum + share.us);
    for share in &mut shares {
        share.time = written_at(share.us, step, total);
    }
    // Waiting last, the rest largest first, those as long in the order the trace first had them (a stable sort).
    shares.sort_by(|a, b| {
        (a.share == WAITING)
            .cmp(&(b.share == WAITING))
            .then(b.us.total_cmp(&a.us))
    });
    let percents = shares::percents(
        &shares.iter().map(|share| share.us).collect::<Vec<_>>(),
        total,
    );
    for (share, percent) in shares.iter_mut().zip(percents) {
        share.percent = percent;
    }
    let unprofiled = shares
        .iter()
        .find(|share| share.share == NOT_PROFILED)
        .map_or(0.0, |share| share.us);
    Split {
        of,
        windows,
        total,
        time: written_at(total, step, total),
        shares,
        profiled: total - unprofiled,
        covered: written_at(total - unprofiled, step, total),
        samples: raw.samples.as_ref().map_or(0, |samples| samples.all),
        sampled: raw.samples.as_ref().map(sampled_line),
        step,
    }
}

/// Where the trace's time went, of all of it or of the windows' (µs since it started): the console's `splitOf`.
pub(crate) fn split(doc: &Value, windows: Option<&[(f64, f64)]>) -> Split {
    let of = windows.map_or_else(|| "the whole trace".to_owned(), windows_label);
    said(raw_of(doc, windows), of, windows.map(<[_]>::to_vec))
}

/// One app's traces in a chain (each of all of it or of its windows), added up before they are said: one split.
pub(crate) fn app_split(parts: &[Part]) -> Split {
    if let [(doc, windows)] = parts {
        return split(doc, *windows);
    }
    let mut times: Vec<(&'static str, f64)> = Vec::new();
    let mut samples: Option<Samples> = None;
    for (doc, windows) in parts {
        let raw = raw_of(doc, *windows);
        for (share, us) in raw.times {
            match times.iter_mut().find(|(each, _)| *each == share) {
                Some(found) => found.1 += us,
                None => times.push((share, us)),
            }
        }
        samples = match (samples, raw.samples) {
            (Some(sum), Some(more)) => Some(Samples {
                all: sum.all + more.all,
                cpu: sum.cpu + more.cpu,
                estimated: sum.estimated.zip(more.estimated).map(|(a, b)| a + b),
                spread: sum.spread && more.spread,
                interval: sum.interval,
            }),
            (sum, more) => sum.or(more),
        };
    }
    said(
        Raw { times, samples },
        format!("{} traces", parts.len()),
        None,
    )
}

/// `x.toFixed(decimals)` as JavaScript writes it: of the number's exact value, a tie rounded up.
fn to_fixed(value: f64, decimals: usize) -> String {
    let exact = format!("{:.*}", decimals + 30, value.abs());
    let (whole, fraction) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut digits: Vec<u8> = whole
        .bytes()
        .chain(fraction.bytes().take(decimals))
        .collect();
    if fraction
        .as_bytes()
        .get(decimals)
        .is_some_and(|digit| *digit >= b'5')
    {
        let mut at = digits.len();
        loop {
            if at == 0 {
                digits.insert(0, b'1');
                break;
            }
            at -= 1;
            if digits[at] == b'9' {
                digits[at] = b'0';
            } else {
                digits[at] += 1;
                break;
            }
        }
    }
    let split = digits.len() - decimals;
    let text = String::from_utf8(digits).unwrap_or_default();
    let sign = if value < 0.0 { "-" } else { "" };
    if decimals == 0 {
        format!("{sign}{text}")
    } else {
        format!("{sign}{}.{}", &text[..split], &text[split..])
    }
}

/// Microseconds as the console says a time (its `duration`): `27 µs`, `0.4 ms`, `28 ms`, `7.9 s`.
pub(crate) fn duration(us: f64) -> String {
    let ms = us / 1000.0;
    if ms < 0.1 {
        format!("{} µs", us.round())
    } else if ms < 1.0 {
        format!("{} ms", to_fixed(ms, 1))
    } else if ms < 1000.0 {
        format!("{} ms", ms.round())
    } else {
        format!("{} s", to_fixed(ms / 1000.0, 1))
    }
}

/// `11 ms – 1.6 s`: where a stretch starts and ends, as the console says it (its `rangeLabel`); where both would
/// read the same, in the end's unit with as many decimals as tell them apart.
fn range_label((from, to): (f64, f64)) -> String {
    let start = if from == 0.0 {
        "0".to_owned()
    } else {
        duration(from)
    };
    let end = duration(to);
    if start != end {
        return format!("{start} – {end}");
    }
    // Whole µs apart at the most: as many decimals as the unit has µs.
    let (unit, size, most) = if to >= 1_000_000.0 {
        ("s", 1_000_000.0, 6)
    } else if to >= 1000.0 {
        ("ms", 1000.0, 3)
    } else {
        ("µs", 1.0, 0)
    };
    for decimals in most.min(1)..=most {
        let (a, b) = (
            to_fixed(from / size, decimals),
            to_fixed(to / size, decimals),
        );
        if a != b || decimals == most {
            return format!("{a} {unit} – {b} {unit}");
        }
    }
    format!("{start} – {end}")
}

/// `93 ms – 100 ms`, `0 – 38 ms, 97 ms – 100 ms`, `46 ms in 5 stretches of 0 – 100 ms`: the console's `windowsLabel`.
fn windows_label(windows: &[(f64, f64)]) -> String {
    if windows.len() <= 3 {
        return windows
            .iter()
            .map(|&window| range_label(window))
            .collect::<Vec<_>>()
            .join(", ");
    }
    let time = windows.iter().fold(0.0, |sum, (from, to)| sum + to - from);
    format!(
        "{} in {} stretches of {}",
        duration(time),
        windows.len(),
        range_label((windows[0].0, windows[windows.len() - 1].1))
    )
}

#[cfg(test)]
pub(crate) mod tests {
    use super::{Part, Split, Windows, app_split, counted, duration, range_label, split, to_fixed};
    use crate::shares::{self, GC, NOT_PROFILED, WAITING};
    use serde_json::{Value, json};

    /// A seeded generator (xorshift): the same traces every run, any failure the same again.
    pub(crate) struct Random(u64);

    impl Random {
        pub(crate) fn new(seed: u64) -> Self {
            Self(seed.max(1))
        }

        fn next(&mut self) -> f64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 >> 11) as f64 / (1u64 << 53) as f64
        }

        fn int(&mut self, from: i64, to: i64) -> i64 {
            from + (self.next() * (to - from + 1) as f64).floor() as i64
        }

        fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
            &items[(self.next() * items.len() as f64).floor() as usize]
        }
    }

    const KINDS: [&str; 7] = [
        "sql",
        "redis",
        "http.client",
        "template",
        "view",
        "function",
        "cache",
    ];

    /// Spans under `parent` in [from, to): a few, apart or overlapping, some with spans of their own.
    fn children(
        next: &mut Random,
        parent: &str,
        (from, to): (i64, i64),
        depth: u32,
        out: &mut Vec<Value>,
    ) {
        let count = if depth > 2 || to - from < 4 {
            0
        } else {
            next.int(0, 4)
        };
        for at in 0..count {
            let start = next.int(from, to - 2);
            let end = next.int(start + 1, to);
            let id = format!("{parent}.{at}");
            let kind = *next.pick(&KINDS);
            let attrs = if kind == "sql" {
                json!({"db.system": "postgresql"})
            } else {
                json!({})
            };
            out.push(
                json!({"id": id, "parent_id": parent, "kind": kind, "name": format!("{kind} {id}"),
                "start": start, "duration": end - start, "status": "ok", "attrs": attrs}),
            );
            children(next, &id, (start, end), depth + 1, out);
        }
    }

    /// A profile of the trace: none, one with no samples, timed (from its start or late), or not timed.
    fn profile_of(next: &mut Random, duration: i64) -> Option<Value> {
        let shape = *next.pick(&["none", "empty", "timed", "late", "untimed"]);
        if shape == "none" {
            return None;
        }
        let interval = *next.pick(&[1000, 10_000]);
        let pauses: Vec<Value> = (0..next.int(0, 3))
            .map(|_| {
                let from = next.int(0, (duration - 1).max(0));
                json!([from, next.int(1, (duration / 10).max(1)), 0])
            })
            .collect();
        let paused: i64 = pauses.iter().map(|pause| pause[1].as_i64().unwrap()).sum();
        let gc = json!({"collections": pauses.len(), "pause_us": paused, "pauses": pauses});
        if shape == "empty" {
            return Some(
                json!({"interval_us": interval, "samples": 0, "dropped": 0, "frames": [], "stacks": [], "gc": gc}),
            );
        }
        let frames = json!([
            {"function": "serve", "module": "server", "file": "server.py", "line": 1, "in_app": false},
            {"function": "handler", "module": "app.views", "file": "app/views.py", "line": 10, "in_app": true},
            {"function": "helper", "module": "app.lib", "file": "app/lib.py", "line": 20, "in_app": true},
            {"function": "select", "module": "selectors", "file": "selectors.py", "line": 3, "in_app": false, "waiting": true},
            {"function": "encode", "module": "json", "file": "json.py", "line": 4, "in_app": false},
        ]);
        let paths: [&[i64]; 6] = [
            &[0, 1],
            &[0, 1, 2],
            &[0, 1, 3],
            &[0, 4],
            &[0, 1, 2, 4],
            &[0, 3],
        ];
        let bucket = *next.pick(&[1000, 10_000]);
        let buckets = ((duration as f64) / bucket as f64).ceil().max(1.0) as i64;
        let first = if shape == "late" {
            next.int(0, buckets - 1)
        } else {
            0
        };
        let mut stacks: Vec<(Vec<i64>, i64, Vec<Value>)> = paths
            .iter()
            .map(|path| (path.to_vec(), 0, vec![]))
            .collect();
        for at in first..buckets {
            if next.next() < 0.2 {
                continue;
            }
            for stack in &mut stacks {
                if next.next() < 0.5 {
                    continue;
                }
                let seen = next.int(1, 5);
                stack.2.push(json!([at, seen]));
                stack.1 += seen;
            }
        }
        stacks.retain(|stack| stack.1 > 0);
        let samples: i64 = stacks.iter().map(|stack| stack.1).sum();
        let timed = shape != "untimed";
        let stacks: Vec<Value> = stacks
            .into_iter()
            .map(|(frames, count, at)| {
                if timed {
                    json!({"frames": frames, "count": count, "at": at})
                } else {
                    json!({"frames": frames, "count": count})
                }
            })
            .collect();
        let mut profile = json!({"interval_us": interval, "samples": samples, "dropped": 0, "frames": frames,
            "stacks": stacks, "gc": gc});
        if timed {
            profile["bucket_us"] = json!(bucket);
            if next.next() < 0.2 {
                profile["estimated_from"] = json!(next.int(1, samples + 1));
                profile["spread"] = json!(next.next() < 0.5);
            }
        }
        Some(profile)
    }

    /// A random trace: its root, spans under it, a profile of some shape.
    pub(crate) fn random_trace(next: &mut Random) -> Value {
        let duration = (10_f64.powf(next.next() * 5.5)).round() as i64 + 1;
        let kind = *next.pick(&["http", "task"]);
        let mut spans = vec![
            json!({"id": "r", "parent_id": null, "kind": kind, "name": "root", "start": 0,
            "duration": duration, "status": "ok", "attrs": {}}),
        ];
        children(next, "r", (0, duration), 0, &mut spans);
        let mut doc =
            json!({"id": "P", "start": 0, "duration": duration, "attrs": {}, "spans": spans});
        if let Some(profile) = profile_of(next, duration) {
            doc["profile"] = profile;
        }
        doc
    }

    /// A percent as a number: `<1%` a share said as none, `>99%` as all.
    fn said(percent: &str) -> i64 {
        match percent {
            "<1%" => 0,
            ">99%" => 100,
            _ => percent.trim_end_matches('%').parse().unwrap(),
        }
    }

    /// A time as written (`1,204.5 ms`, `27 µs`, `1.6 s`) back in whole µs.
    fn read(text: &str) -> i64 {
        let text = text.replace(',', "");
        let (value, unit) = text.split_once(' ').unwrap_or((&text, "µs"));
        let scale = match unit {
            "s" => 1_000_000.0,
            "ms" => 1000.0,
            _ => 1.0,
        };
        (value.parse::<f64>().unwrap() * scale).round() as i64
    }

    /// A time's unit and how many decimals it is written with: `ms.1` for `0.8 ms`.
    fn decimals(text: &str) -> String {
        let (value, unit) = text.split_once(' ').unwrap_or((text, ""));
        let places = value
            .split_once('.')
            .map_or(0, |(_, fraction)| fraction.len());
        format!("{unit}.{places}")
    }

    /// What every split says, whatever it is of: what it breaks, if anything.
    pub(crate) fn broken(split: &Split) -> Vec<String> {
        let mut problems = Vec::new();
        let mut check = |ok: bool, what: &str| {
            if !ok {
                problems.push(format!("{what}: {}", split.json()));
            }
        };
        let total: f64 = split.shares.iter().fold(0.0, |sum, share| sum + share.us);
        check(total == split.total, "times add up to the total");
        check(
            split.shares.iter().all(|share| {
                share.us > 0.0
                    && (share.us / split.step - (share.us / split.step).round()).abs() < 1e-9
            }),
            "each share a whole number of steps",
        );
        check(
            split.shares.is_empty()
                || split
                    .shares
                    .iter()
                    .map(|share| said(&share.percent))
                    .sum::<i64>()
                    == 100,
            "percents add up to 100%",
        );
        // As read: the shares' times written add up to the total written, in one precision.
        let written: i64 = split.shares.iter().map(|share| read(&share.time)).sum();
        check(written == read(&split.time), "times as read add up");
        let not_profiled = split
            .shares
            .iter()
            .find(|share| share.share == NOT_PROFILED)
            .map_or(0, |share| read(&share.time));
        check(
            read(&split.covered) == read(&split.time) - not_profiled,
            "covered as read",
        );
        check(
            split
                .shares
                .iter()
                .all(|share| decimals(&share.time) == decimals(&split.time)),
            "one precision for the shares and the total",
        );
        let unprofiled = split
            .shares
            .iter()
            .find(|share| share.share == NOT_PROFILED)
            .map_or(0.0, |share| share.us);
        check(
            split.profiled == split.total - unprofiled,
            "covered is the total less Not profiled",
        );
        let rest: Vec<f64> = split
            .shares
            .iter()
            .filter(|share| share.share != WAITING)
            .map(|share| share.us)
            .collect();
        check(
            rest.windows(2).all(|pair| pair[0] >= pair[1]),
            "largest first",
        );
        let waiting = split.shares.iter().position(|share| share.share == WAITING);
        check(
            waiting.is_none_or(|at| at == split.shares.len() - 1),
            "waiting last",
        );
        check(
            split.of.split(", ").all(|part| {
                let ends: Vec<&str> = part.split(" – ").collect();
                ends.len() != 2 || ends[0] != ends[1]
            }),
            "a stretch's ends apart",
        );
        problems
    }

    /// A span's own stretches as its code row opens them: in whole µs, those that meet as one.
    fn row_windows(doc: &Value, span: &str) -> Windows {
        let kinds = doc
            .get("profile")
            .map_or_else(Vec::new, shares::stack_kinds);
        let mut out: Windows = Vec::new();
        for segment in shares::segments(doc, &kinds) {
            if segment.span["id"] != span || segment.share == GC {
                continue;
            }
            let (from, to) = (segment.from.round(), segment.to.round());
            if to <= from {
                continue;
            }
            match out.last_mut() {
                Some(last) if from <= last.1 => last.1 = last.1.max(to),
                _ => out.push((from, to)),
            }
        }
        out
    }

    #[test]
    fn any_traces_split_adds_up() {
        let mut next = Random::new(20_261_104);
        let mut problems = Vec::new();
        for _ in 0..400 {
            let doc = random_trace(&mut next);
            problems.extend(broken(&split(&doc, None)));
            for span in doc["spans"].as_array().unwrap() {
                let windows = row_windows(&doc, span["id"].as_str().unwrap());
                if !windows.is_empty() {
                    problems.extend(broken(&split(&doc, Some(&windows))));
                }
            }
        }
        let mut apps = Random::new(4_242);
        for _ in 0..100 {
            let count = apps.int(1, 4);
            let docs: Vec<Value> = (0..count).map(|_| random_trace(&mut apps)).collect();
            let parts: Vec<Part> = docs.iter().map(|doc| (doc, None)).collect();
            problems.extend(broken(&app_split(&parts)));
        }

        assert_eq!(problems, Vec::<String>::new());
    }

    fn windows(value: &Value) -> Windows {
        value
            .as_array()
            .into_iter()
            .flatten()
            .map(|pair| (pair[0].as_f64().unwrap(), pair[1].as_f64().unwrap()))
            .collect()
    }

    /// The cases the console checks itself against (`schema/waits.json`), each said here as there to the letter:
    /// the whole trace's split, its stretches' (a code row's, a wait's), an app's traces added up.
    #[test]
    fn the_shared_splits() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../../schema/waits.json")).unwrap();
        let trace =
            |name: &Value| &cases.iter().find(|case| case["name"] == *name).unwrap()["trace"];

        for case in &cases {
            let name = &case["name"];
            assert_eq!(split(&case["trace"], None).json(), case["split"], "{name}");
            for stretch in case["stretches"].as_array().into_iter().flatten() {
                let windows = windows(&stretch["windows"]);
                assert_eq!(
                    split(&case["trace"], Some(&windows)).json(),
                    stretch["split"],
                    "{name}"
                );
            }
            if let Some(app) = case["app"]["cases"].as_array() {
                let docs: Vec<Part> = app.iter().map(|name| (trace(name), None)).collect();
                assert_eq!(app_split(&docs).json(), case["app"]["split"], "{name}");
            }
        }
        assert!(cases.iter().any(|case| case["stretches"].is_array()));
        assert_eq!(
            json!(cases.iter().filter(|case| case["app"].is_object()).count()),
            json!(2)
        );
    }

    #[test]
    fn times_read_as_the_console_writes_them() {
        assert_eq!(
            [
                27.0,
                250.0,
                450.0,
                999.0,
                1499.0,
                1500.0,
                999_499.0,
                1_250_000.0
            ]
            .map(duration),
            [
                "27 µs", "0.3 ms", "0.5 ms", "1.0 ms", "1 ms", "2 ms", "999 ms", "1.3 s"
            ]
        );
        assert_eq!(to_fixed(0.25, 1), "0.3");
        assert_eq!(to_fixed(170.25, 1), "170.3");
        assert_eq!(counted(1, "sample", "samples"), "1 sample");
        assert_eq!(counted(1204, "sample", "samples"), "1,204 samples");
    }

    #[test]
    fn a_stretch_whose_ends_read_the_same_says_them_apart() {
        assert_eq!(range_label((93_000.0, 100_000.0)), "93 ms – 100 ms");
        assert_eq!(range_label((170_210.0, 170_480.0)), "170.2 ms – 170.5 ms");
        assert_eq!(range_label((0.0, 38.0)), "0 – 38 µs");
        assert_eq!(
            range_label((1_146_999.0, 1_147_000.0)),
            "1.146999 s – 1.147000 s"
        );
        assert_eq!(range_label((600.0, 640.0)), "600 µs – 640 µs");
    }
}
