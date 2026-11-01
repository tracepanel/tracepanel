//! A trace's profile as the model reads it: where its time went in code (the functions by their own time and in
//! all, the hottest paths) and where its memory was (the peak, what it kept, the sites that held most). The numbers
//! are the console's Profile tab's, read the same way: a profile that says when its stacks were seen reads in the
//! trace's own time, one with enough of the project's code reads as that code (its frames alone: what a library call
//! of its spent, it spent; the samples that ran none of it one "framework & runtime"), and a site is named by the line
//! of the project's code that led to it.

use crate::compact::{int, ms, text};
use crate::off_cpu;
use serde_json::Value;
use std::collections::HashMap;

/// Under this share of samples in the project's own code, a profile reads as every frame: there is little of yours.
const OWN_ENOUGH: f64 = 0.1;
/// Frames kept above the first of the project's own, out of what every stack starts with: the middleware around it.
const CONTEXT: usize = 3;
/// The hottest paths shown.
const PATHS: usize = 5;
/// A path's innermost frames shown; the outer ones are a count.
const PATH_FRAMES: usize = 8;
/// The changes `compare` lists, at most.
const CHANGES: usize = 8;
/// The SDKs that sample the CPU alone, by their language: Go's runtime/pprof, Node's V8 profiler without its idle
/// samples. Python's and the JVM's sample each thread on the clock, waiting or not.
const CPU_ONLY: [&str; 2] = ["go", "nodejs"];
/// A CPU profile's time off the CPU, read as waiting: the database, the network, a lock, a timer.
const OFF_CPU: &str = "off the CPU";
/// What the project's code reads the samples that ran none of it as: the server's, the runtime's, the SDKs'.
const FRAMEWORK: &str = "(framework & runtime)";

/// How to profile a request: what a refusal says.
const HOW: &str = "Make the request again with an `X-Tracepanel-Profile: 1` header (`memory` to count its memory \
    too) or a `tracepanel_profile=1` cookie, or turn on the `profile` setting to profile every trace; then \
    wait_for_trace and get_profile.";

/// What a profile measured: its time, its memory.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Kind {
    Cpu,
    Memory,
}

impl Kind {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Cpu => "cpu",
            Self::Memory => "memory",
        }
    }

    pub(crate) fn parse(name: &str) -> Option<Self> {
        match name {
            "cpu" => Some(Self::Cpu),
            "memory" => Some(Self::Memory),
            _ => None,
        }
    }
}

struct Frame<'a> {
    function: &'a str,
    module: &'a str,
    file: &'a str,
    line: i64,
    /// The line it ran when sampled (an await's, an allocation's), where `line` is where it is defined.
    at_line: Option<i64>,
    in_app: bool,
    waiting: bool,
}

impl Frame<'_> {
    /// `shop/cards.py:42`: where it ran, else where it is defined.
    fn place(&self) -> String {
        if self.file.is_empty() {
            return String::new();
        }
        format!("{}:{}", self.file, self.at_line.unwrap_or(self.line))
    }

    /// A function in a list, whose it is and where: `build_cards (yours)`, then its file and line.
    fn named(&self) -> String {
        let mut out = self.function.to_owned();
        if self.waiting {
            out.push_str(" (waiting)");
        } else if self.in_app {
            out.push_str(" (yours)");
        }
        let place = self.place();
        if !place.is_empty() {
            out.push_str(&format!(" — {place}"));
        }
        out
    }

    /// `build_cards (shop/cards.py:44)`: a step of a path.
    fn step(&self) -> String {
        let place = self.place();
        if place.is_empty() {
            self.function.to_owned()
        } else {
            format!("{} ({place})", self.function)
        }
    }

    /// Tracing's own code, never the project's (a span started, an attribute set).
    fn tracing(&self) -> bool {
        !self.in_app && tracepanel_analysis::profiles::tracing(self.module, self.file)
    }

    /// `asyncio.sleep`: a function by its package and name.
    fn called(&self) -> String {
        match self
            .module
            .split('.')
            .next()
            .filter(|root| !root.is_empty())
        {
            Some(root) => format!("{root}.{}", self.function),
            None => self.function.to_owned(),
        }
    }
}

/// A stack seen: its frames, outermost first, as indexes; its samples, and the time they stand for.
#[derive(Clone)]
struct Stack {
    frames: Vec<usize>,
    count: i64,
    us: f64,
}

struct Profile<'a> {
    frames: Vec<Frame<'a>>,
    stacks: Vec<Stack>,
    interval: i64,
    samples: i64,
    dropped: i64,
    /// Read in the trace's own time: the profile says when its stacks were seen.
    timed: bool,
    raw: &'a Value,
    /// The frame the samples that ran none of the project's code read as, in its view (FRAMEWORK), last of `frames`.
    outside: usize,
    /// A CPU profile's (CPU_ONLY) time on the CPU; the rest of the trace's time is waiting (OFF_CPU), under the
    /// function of the project's that made each call it waited for.
    on_cpu: Option<f64>,
}

/// A CPU profile's `off` µs off the CPU as waiting stacks (OFF_CPU): each call's time under the function of the
/// project's that made it (off_cpu), shared down to `off` where the calls took more (their time on the CPU is in the
/// samples); the rest, no call's, one waiting stack of its own.
fn off_cpu_stacks(doc: &Value, frames: &mut Vec<Frame>, stacks: &mut Vec<Stack>, off: f64) {
    let places: Vec<off_cpu::Place> = frames
        .iter()
        .map(|frame| off_cpu::Place {
            function: frame.function,
            file: frame.file,
            line: frame.line,
            in_app: frame.in_app,
        })
        .collect();
    let seen: Vec<(&[usize], i64)> = stacks
        .iter()
        .map(|stack| (stack.frames.as_slice(), stack.count))
        .collect();
    let waiters = off_cpu::waited(doc, &places, &seen);
    frames.push(Frame {
        function: OFF_CPU,
        module: "",
        file: "",
        line: 0,
        at_line: None,
        in_app: false,
        waiting: true,
    });
    let waiting = frames.len() - 1;
    let in_calls: f64 = waiters.iter().map(|(_, us)| us).sum();
    let scale = if in_calls > off { off / in_calls } else { 1.0 };
    for (path, us) in waiters {
        let mut frames = path;
        frames.push(waiting);
        stacks.push(Stack {
            frames,
            count: 0,
            us: us * scale,
        });
    }
    let rest = off - in_calls * scale;
    if rest > 0.0 {
        stacks.push(Stack {
            frames: vec![waiting],
            count: 0,
            us: rest,
        });
    }
}

fn frames_of(value: &Value) -> Vec<usize> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_u64)
        .map(|index| index as usize)
        .collect()
}

impl<'a> Profile<'a> {
    fn of(doc: &'a Value) -> Option<Self> {
        let raw = doc.get("profile").filter(|profile| profile.is_object())?;
        let mut frames: Vec<Frame> = raw
            .get("frames")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|frame| Frame {
                function: text(frame, "function"),
                module: text(frame, "module"),
                file: text(frame, "file"),
                line: int(frame, "line"),
                at_line: frame.get("at_line").and_then(Value::as_i64),
                in_app: frame.get("in_app").and_then(Value::as_bool) == Some(true),
                waiting: frame.get("waiting").and_then(Value::as_bool) == Some(true),
            })
            .collect();
        let outside = frames.len();
        frames.push(Frame {
            function: FRAMEWORK,
            module: "",
            file: "",
            line: 0,
            at_line: None,
            in_app: false,
            waiting: false,
        });
        let interval = int(raw, "interval_us").max(1);
        let mut stacks: Vec<Stack> = raw
            .get("stacks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|stack| Stack {
                frames: frames_of(&stack["frames"]),
                count: int(stack, "count"),
                us: (int(stack, "count") * interval) as f64,
            })
            .collect();
        let timed = wall_clock(raw, int(doc, "duration"), &mut stacks);
        let language = doc
            .get("attrs")
            .and_then(|attrs| attrs.get("telemetry.sdk.language"))
            .and_then(Value::as_str);
        let on_cpu = (!timed && language.is_some_and(|language| CPU_ONLY.contains(&language)))
            .then(|| {
                let sampled = (int(raw, "samples") + int(raw, "dropped")) * interval;
                let off = int(doc, "duration") - sampled;
                if off >= interval {
                    off_cpu_stacks(doc, &mut frames, &mut stacks, off as f64);
                }
                (int(raw, "samples") * interval) as f64
            });
        Some(Self {
            frames,
            stacks,
            interval,
            samples: int(raw, "samples"),
            dropped: int(raw, "dropped"),
            timed,
            raw,
            outside,
            on_cpu,
        })
    }

    fn frame(&self, index: usize) -> Option<&Frame<'a>> {
        self.frames.get(index)
    }

    fn total(&self) -> f64 {
        self.stacks.iter().map(|stack| stack.us).sum()
    }

    fn waits(&self, stack: &Stack) -> bool {
        stack
            .frames
            .last()
            .and_then(|&index| self.frame(index))
            .is_some_and(|frame| frame.waiting)
    }

    fn yours(&self, index: usize) -> bool {
        self.frame(index).is_some_and(|frame| frame.in_app)
    }

    /// Whether the project's code ran enough of the time for the profile to read as it.
    fn mostly_yours(&self) -> bool {
        let yours: i64 = self
            .stacks
            .iter()
            .filter(|stack| stack.frames.iter().any(|&index| self.yours(index)))
            .map(|stack| stack.count)
            .sum();
        yours as f64 >= self.samples as f64 * OWN_ENOUGH
    }

    /// A stack as the project's code sees it: its frames alone, what the library calls they made spent counted to the
    /// innermost of them; its innermost frame too where that waited (a socket, a sleep). A stack without the
    /// project's code, or running tracing's own (a span started), is the framework's and the runtime's (FRAMEWORK):
    /// none of their frames, nor tracing's time, are the project's.
    fn own_frames(&self, frames: &[usize]) -> Vec<usize> {
        let mut kept: Vec<usize> = frames
            .iter()
            .copied()
            .filter(|&index| self.yours(index))
            .collect();
        let leaf = frames.last().copied();
        let inner = leaf.and_then(|leaf| self.frame(leaf));
        match (leaf, inner) {
            (Some(leaf), Some(frame)) if frame.waiting && !frame.in_app => kept.push(leaf),
            (_, frame) if kept.is_empty() || frame.is_some_and(Frame::tracing) => {
                kept = vec![self.outside];
            }
            _ => {}
        }
        kept
    }

    /// Every frame, less the library frames every stack starts with (the server, the thread) but the last few.
    fn all_frames(&self) -> Vec<Stack> {
        let Some(first) = self.stacks.first() else {
            return Vec::new();
        };
        let shared = self.stacks[1..]
            .iter()
            .fold(first.frames.len(), |length, stack| {
                let common = first
                    .frames
                    .iter()
                    .zip(&stack.frames)
                    .take_while(|(a, b)| a == b)
                    .count();
                length.min(common)
            });
        let library = first.frames[..shared]
            .iter()
            .position(|&index| self.yours(index))
            .unwrap_or(shared);
        let cut = library.saturating_sub(CONTEXT);
        self.stacks
            .iter()
            .map(|stack| Stack {
                frames: stack.frames[cut.min(stack.frames.len())..].to_vec(),
                ..stack.clone()
            })
            .collect()
    }

    fn own_code(&self) -> Vec<Stack> {
        self.stacks
            .iter()
            .map(|stack| Stack {
                frames: self.own_frames(&stack.frames),
                ..stack.clone()
            })
            .collect()
    }

    /// The stacks as the console opens them: as the project's code when there is enough of it, else every frame.
    fn view(&self) -> (Vec<Stack>, &'static str) {
        if self.mostly_yours() {
            (
                self.own_code(),
                "your code: library calls counted to the function of yours that made them",
            )
        } else {
            (self.all_frames(), "every frame")
        }
    }

    /// The stack that waited most: its frames, the one that waited and the last of the project's in it.
    fn longest_wait(&self) -> Option<(Vec<&Frame<'a>>, Option<&Frame<'a>>)> {
        let stack = self
            .stacks
            .iter()
            .filter(|stack| self.waits(stack))
            .max_by_key(|stack| stack.count)?;
        let frames: Vec<&Frame> = stack
            .frames
            .iter()
            .filter_map(|&index| self.frame(index))
            .collect();
        let own = frames.iter().rev().find(|frame| frame.in_app).copied();
        Some((frames, own))
    }

    /// `asyncio.sleep in send_digest at shop/tasks.py:108`: what the code waited on most, as the app awaited it
    /// where that is known (`await sync_to_async(…)`), in which function of its own.
    fn wait_name(&self) -> Option<String> {
        let (frames, own) = self.longest_wait()?;
        let after = match own {
            Some(own) => {
                let at = frames
                    .iter()
                    .position(|frame| std::ptr::eq(*frame, own))
                    .map_or(0, |at| at + 1);
                &frames[at..]
            }
            None => &frames[..],
        };
        let awaited = after
            .iter()
            .find_map(|frame| match frame.called().as_str() {
                "asgiref.SyncToAsync.__call__" => Some("await sync_to_async(…)".to_owned()),
                "asgiref.AsyncToSync.__call__" => Some("async_to_sync(…)".to_owned()),
                _ => None,
            });
        let what = awaited.or_else(|| frames.last().map(|leaf| leaf.called()))?;
        Some(match own {
            Some(own) => format!("{what} in {} at {}", own.function, own.place()),
            None => what,
        })
    }
}

/// A timed profile's stacks in the trace's own time: each 'bucket' of it shared among the stacks seen in it, a
/// bucket with none (its thread ran other traces then) as the bucket before it. Whether the profile is timed.
fn wall_clock(raw: &Value, duration: i64, stacks: &mut [Stack]) -> bool {
    let width = int(raw, "bucket_us");
    let seen_in: Vec<Vec<(i64, i64)>> = raw
        .get("stacks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|stack| {
            stack
                .get("at")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|pair| {
                    (
                        pair[0].as_i64().unwrap_or(-1),
                        pair[1].as_i64().unwrap_or(0),
                    )
                })
                .collect()
        })
        .collect();
    if width <= 0 || duration <= 0 || seen_in.iter().all(Vec::is_empty) {
        return false;
    }
    let mut buckets: HashMap<i64, Vec<(usize, i64)>> = HashMap::new();
    for (index, pairs) in seen_in.iter().enumerate() {
        for &(bucket, count) in pairs {
            if bucket >= 0 && count > 0 {
                buckets.entry(bucket).or_default().push((index, count));
            }
        }
    }
    let mut time = vec![0.0; stacks.len()];
    let mut before: Option<&Vec<(usize, i64)>> = None;
    let mut bucket = 0;
    while bucket * width < duration {
        before = buckets.get(&bucket).or(before);
        if let Some(seen) = before {
            let from = bucket * width;
            let length = ((from + width).min(duration) - from) as f64;
            let all: i64 = seen.iter().map(|(_, count)| count).sum();
            for &(index, count) in seen {
                time[index] += length * count as f64 / all as f64;
            }
        }
        bucket += 1;
    }
    for (stack, us) in stacks.iter_mut().zip(time) {
        stack.us = us;
    }
    true
}

/// `32%`, `<1%`.
fn share(part: f64, whole: f64) -> String {
    if whole <= 0.0 {
        return "0%".into();
    }
    let percent = part * 100.0 / whole;
    if percent > 0.0 && percent < 0.5 {
        "<1%".into()
    } else {
        format!("{percent:.0}%")
    }
}

fn us(time: f64) -> String {
    ms(time.round() as i64)
}

/// Bytes as the console says them: `512 B`, `4.0 KB`, `48 MB`.
pub(crate) fn bytes(size: i64) -> String {
    if size < 0 {
        return format!("−{}", bytes(-size));
    }
    if size < 1024 {
        return format!("{size} B");
    }
    let units = ["KB", "MB", "GB"];
    let unit = (1..=units.len())
        .filter(|&power| size as f64 >= 1024_f64.powi(power as i32))
        .count();
    let value = size as f64 / 1024_f64.powi(unit as i32);
    if value < 10.0 {
        format!("{value:.1} {}", units[unit - 1])
    } else {
        format!("{value:.0} {}", units[unit - 1])
    }
}

/// `+1.2 MB`: what a trace kept, its sign said.
fn signed(size: i64) -> String {
    if size > 0 {
        format!("+{}", bytes(size))
    } else {
        bytes(size)
    }
}

/// Each function's time: its own (it was running) and in all (it or what it called was), a stack counted once.
fn functions(stacks: &[Stack]) -> Vec<(usize, f64, f64)> {
    let mut own: HashMap<usize, f64> = HashMap::new();
    let mut all: HashMap<usize, f64> = HashMap::new();
    for stack in stacks {
        if let Some(&leaf) = stack.frames.last() {
            *own.entry(leaf).or_default() += stack.us;
        }
        let mut seen = stack.frames.clone();
        seen.sort_unstable();
        seen.dedup();
        for index in seen {
            *all.entry(index).or_default() += stack.us;
        }
    }
    let mut rows: Vec<(usize, f64, f64)> = all
        .into_iter()
        .map(|(index, total)| (index, own.get(&index).copied().unwrap_or(0.0), total))
        .collect();
    rows.sort_by(|a, b| {
        b.1.total_cmp(&a.1)
            .then(b.2.total_cmp(&a.2))
            .then(a.0.cmp(&b.0))
    });
    rows
}

/// The stacks merged where they are now alike, the most time first.
fn paths(stacks: &[Stack]) -> Vec<(Vec<usize>, f64)> {
    let mut order: Vec<Vec<usize>> = Vec::new();
    let mut time: HashMap<Vec<usize>, f64> = HashMap::new();
    for stack in stacks {
        if !time.contains_key(&stack.frames) {
            order.push(stack.frames.clone());
        }
        *time.entry(stack.frames.clone()).or_default() += stack.us;
    }
    let mut merged: Vec<(Vec<usize>, f64)> = order
        .into_iter()
        .map(|frames| {
            let us = time[&frames];
            (frames, us)
        })
        .collect();
    merged.sort_by(|a, b| b.1.total_cmp(&a.1));
    merged
}

/// What a trace's profile measured: `cpu`, and `memory` where it counted it.
pub(crate) fn kinds(doc: &Value) -> Vec<&'static str> {
    let Some(profile) = doc.get("profile").filter(|profile| profile.is_object()) else {
        return Vec::new();
    };
    let mut kinds = vec!["cpu"];
    if profile.get("memory").is_some_and(Value::is_object) {
        kinds.push("memory");
    }
    kinds
}

/// Whether a trace's profile measured `kind`.
pub(crate) fn has(doc: &Value, kind: Kind) -> bool {
    let kinds = kinds(doc);
    match kind {
        Kind::Cpu => kinds.contains(&"cpu"),
        Kind::Memory => kinds.contains(&"memory"),
    }
}

/// The profile of `kind`, compact, with its `top` functions or sites; why not, when the trace has none.
pub(crate) fn profile(doc: &Value, kind: Kind, top: usize) -> Result<String, String> {
    read(doc, kind, top, false)
}

/// An app's profiles of `kind` in a chain of calls, compact: one trace's as `profile` reads it, several merged as
/// one (as the console's Profile tab adds an app's traces up). None when none of them measured it.
pub(crate) fn app_profile(docs: &[&Value], kind: Kind, top: usize) -> Option<String> {
    let measured: Vec<&Value> = docs.iter().copied().filter(|doc| has(doc, kind)).collect();
    match measured.as_slice() {
        [] => None,
        [one] => read(one, kind, top, false).ok(),
        several => read(&merged(several), kind, top, true).ok(),
    }
}

fn read(doc: &Value, kind: Kind, top: usize, merged: bool) -> Result<String, String> {
    let id = text(doc, "id");
    let Some(profile) = Profile::of(doc) else {
        return Err(format!("Trace {id} has no profile. {HOW}"));
    };
    match kind {
        Kind::Cpu => Ok(cpu(&profile, int(doc, "duration"), top, merged)),
        Kind::Memory => match profile
            .raw
            .get("memory")
            .filter(|memory| memory.is_object())
        {
            Some(memory) => Ok(memory_of(&profile, memory, top, merged)),
            None => Err(format!(
                "Trace {id} has a CPU profile but its memory wasn't counted. Make the request again with an \
                 `X-Tracepanel-Profile: memory` header or a `tracepanel_profile=memory` cookie (the \
                 `profile_memory` setting counts every profiled trace's); then wait_for_trace and get_profile."
            )),
        },
    }
}

/// A frame's index in `frames` (added when it isn't there yet, by all it says).
fn interned(frames: &mut Vec<Value>, seen: &mut HashMap<String, usize>, frame: &Value) -> usize {
    *seen.entry(frame.to_string()).or_insert_with(|| {
        frames.push(frame.clone());
        frames.len() - 1
    })
}

/// A stack of one profile (indexes into its own frames) as indexes into the merged frames.
fn remapped(
    frames: &mut Vec<Value>,
    seen: &mut HashMap<String, usize>,
    own: &[Value],
    stack: &Value,
) -> Vec<usize> {
    frames_of(stack)
        .into_iter()
        .filter_map(|at| own.get(at))
        .map(|frame| interned(frames, seen, frame))
        .collect()
}

/// Counts added up by stack, in the order the stacks were first seen.
#[derive(Default)]
struct Summed {
    order: Vec<Vec<usize>>,
    counts: HashMap<Vec<usize>, Vec<i64>>,
}

impl Summed {
    fn add(&mut self, stack: Vec<usize>, counts: &[i64]) {
        match self.counts.get_mut(&stack) {
            Some(seen) => seen
                .iter_mut()
                .zip(counts)
                .for_each(|(seen, more)| *seen += more),
            None => {
                self.counts.insert(stack.clone(), counts.to_vec());
                self.order.push(stack);
            }
        }
    }

    fn rows(&self) -> impl Iterator<Item = (&Vec<usize>, &Vec<i64>)> {
        self.order.iter().map(|stack| (stack, &self.counts[stack]))
    }
}

/// Several memories' numbers as one: what they kept and allocated added up, the peak the largest of one of them
/// (they ran apart, each from its own start), what all of them say alike.
fn memory_numbers(memories: &[&Value]) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    let peak = memories.iter().map(|memory| int(memory, "peak")).max();
    out.insert("peak".into(), Value::from(peak.unwrap_or(0)));
    out.insert(
        "net".into(),
        Value::from(
            memories
                .iter()
                .map(|memory| int(memory, "net"))
                .sum::<i64>(),
        ),
    );
    let allocated: Option<i64> = memories
        .iter()
        .map(|memory| memory.get("allocated").and_then(Value::as_i64))
        .sum();
    if let Some(allocated) = allocated {
        out.insert("allocated".into(), Value::from(allocated));
    }
    let at = text(memories[0], "sites_at");
    if !at.is_empty() && memories.iter().all(|memory| text(memory, "sites_at") == at) {
        out.insert("sites_at".into(), Value::from(at));
    }
    if memories
        .iter()
        .any(|memory| memory.get("shared").and_then(Value::as_bool) == Some(true))
    {
        out.insert("shared".into(), Value::Bool(true));
    }
    out
}

/// Several traces' profiles of one app as one, in a trace document of their time added up: their frames once,
/// their stacks' samples and their memory's sites added up by stack, their collections too. Untimed: when each stack
/// was seen is each trace's own.
fn merged(docs: &[&Value]) -> Value {
    let mut frames: Vec<Value> = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();
    let (mut stacks, mut sites) = (Summed::default(), Summed::default());
    let mut memories: Vec<&Value> = Vec::new();
    let (mut samples, mut dropped, mut collections, mut paused) = (0, 0, 0, 0);
    for doc in docs {
        let raw = &doc["profile"];
        let own = raw["frames"].as_array().map_or(&[][..], Vec::as_slice);
        for stack in raw["stacks"].as_array().into_iter().flatten() {
            let at = remapped(&mut frames, &mut seen, own, &stack["frames"]);
            stacks.add(at, &[int(stack, "count")]);
        }
        if let Some(memory) = raw.get("memory").filter(|memory| memory.is_object()) {
            memories.push(memory);
            for site in memory["sites"].as_array().into_iter().flatten() {
                let at = remapped(&mut frames, &mut seen, own, &site["frames"]);
                sites.add(at, &[int(site, "bytes"), int(site, "count")]);
            }
        }
        samples += int(raw, "samples");
        dropped += int(raw, "dropped");
        collections += int(&raw["gc"], "collections");
        paused += int(&raw["gc"], "pause_us");
    }
    let mut profile = serde_json::json!({
        "interval_us": int(&docs[0]["profile"], "interval_us"),
        "samples": samples,
        "dropped": dropped,
        "frames": frames,
        "stacks": stacks.rows().map(|(frames, counts)| serde_json::json!({"frames": frames, "count": counts[0]})).collect::<Vec<_>>(),
    });
    if !memories.is_empty() {
        let mut memory = memory_numbers(&memories);
        let mut listed: Vec<Value> = sites
            .rows()
            .map(|(frames, counts)| serde_json::json!({"frames": frames, "bytes": counts[0], "count": counts[1]}))
            .collect();
        listed.sort_by_key(|site| std::cmp::Reverse(int(site, "bytes")));
        memory.insert("sites".into(), Value::Array(listed));
        profile["memory"] = Value::Object(memory);
    }
    if collections > 0 {
        profile["gc"] = serde_json::json!({"collections": collections, "pause_us": paused});
    }
    let duration: i64 = docs.iter().map(|doc| int(doc, "duration")).sum();
    // The first trace's attributes: one app's, its language the same.
    let attrs = docs.first().and_then(|doc| doc.get("attrs")).cloned();
    serde_json::json!({"id": "", "duration": duration, "attrs": attrs, "profile": profile})
}

/// `GC: 3 collections, 12 ms paused`, when the profile counted any.
fn gc_line(raw: &Value) -> Option<String> {
    let gc = raw.get("gc")?;
    let collections = int(gc, "collections");
    (collections > 0).then(|| {
        format!(
            "GC: {} {}, {} paused",
            collections,
            if collections == 1 {
                "collection"
            } else {
                "collections"
            },
            ms(int(gc, "pause_us"))
        )
    })
}

fn cpu(profile: &Profile, duration: i64, top: usize, merged: bool) -> String {
    let total = profile.total();
    let mut out = vec![format!(
        "CPU profile: {} {} of the {} {} · {} samples, one every {}{}",
        us(profile.on_cpu.unwrap_or(total)),
        match (profile.on_cpu, profile.timed) {
            (Some(_), _) => "on the CPU",
            (None, true) => "profiled",
            (None, false) => "sampled",
        },
        if merged { "traces'" } else { "trace's" },
        ms(duration),
        profile.samples,
        ms(profile.interval),
        if profile.on_cpu.is_some() {
            " of CPU time"
        } else {
            ""
        }
    )];
    let waited: f64 = profile
        .stacks
        .iter()
        .filter(|stack| profile.waits(stack))
        .map(|stack| stack.us)
        .sum();
    if waited > 0.0 {
        let what = if profile.on_cpu.is_some() {
            ", off the CPU (the database, the network, a lock, a timer; not sampled)"
        } else {
            " (a sleep, a socket, a lock, the event loop: not computing)"
        };
        let mut line = format!("waiting{what}: {} ({})", us(waited), share(waited, total));
        if let Some(name) = profile.wait_name().filter(|_| profile.on_cpu.is_none()) {
            line.push_str(&format!(", most in {name}"));
        }
        out.push(line);
    }
    if profile.dropped > 0 {
        out.push(format!(
            "not sampled: {} (other traces ran on the same thread){}",
            ms(profile.dropped * profile.interval),
            if profile.timed {
                ", filled in from the samples around it"
            } else {
                ""
            }
        ));
    }
    out.extend(gc_line(profile.raw));
    let mut notes = format!(
        "note: a sample every {}: a function that ran for less may be missed or miscounted.",
        ms(profile.interval)
    );
    if profile.raw.get("memory").is_some_and(Value::is_object) {
        notes.push_str(
            " Its memory was counted too, which slows the code down: these times are higher than without it.",
        );
    }
    out.push(notes);
    if profile.stacks.iter().all(|stack| stack.count == 0) {
        out.push(format!(
            "\nNo samples: the trace was over before the profiler saw its code (one sample every {}).",
            ms(profile.interval)
        ));
        return out.join("\n");
    }

    let (view, seen_as) = profile.view();
    let rows = functions(&view);
    let mut by_self = vec![format!("\nfunctions by self time ({seen_as}):")];
    by_self.extend(
        rows.iter()
            .filter(|(_, own, _)| *own > 0.0)
            .take(top)
            .filter_map(|&(index, own, all)| {
                let frame = profile.frame(index)?;
                Some(format!(
                    "  {}  {}  {} · total {}",
                    us(own),
                    share(own, total),
                    frame.named(),
                    us(all)
                ))
            }),
    );
    out.extend(by_self);

    let mut by_total = rows.clone();
    // A tie is a caller and what it called: the caller (less of its own) first.
    by_total.sort_by(|a, b| {
        b.2.total_cmp(&a.2)
            .then(a.1.total_cmp(&b.1))
            .then(a.0.cmp(&b.0))
    });
    out.push("\nfunctions by total time:".into());
    out.extend(by_total.iter().take(top).filter_map(|&(index, own, all)| {
        let frame = profile.frame(index)?;
        Some(format!(
            "  {}  {}  {} · self {}",
            us(all),
            share(all, total),
            frame.named(),
            us(own)
        ))
    }));

    out.push("\nhottest paths (outermost first):".into());
    for (frames, time) in paths(&view).into_iter().take(PATHS) {
        let steps: Vec<String> = frames
            .iter()
            .filter_map(|&index| profile.frame(index))
            .map(Frame::step)
            .collect();
        let skip = steps.len().saturating_sub(PATH_FRAMES);
        let mut path = steps[skip..].join(" → ");
        if skip > 0 {
            path = format!("… {skip} outer frames → {path}");
        }
        out.push(format!("  {}  {}  {path}", us(time), share(time, total)));
    }
    out.join("\n")
}

/// A site as its list says it: the function that allocated, and the line of the project's code that led there.
struct Site<'a> {
    bytes: i64,
    count: i64,
    allocated: &'a Frame<'a>,
    own: &'a Frame<'a>,
}

impl Site<'_> {
    /// The line of the project's code that led to the site, then the library function that allocated, if another.
    fn named(&self) -> String {
        if std::ptr::eq(self.allocated, self.own) {
            return self.own.named();
        }
        format!(
            "{} · allocated in {}",
            self.own.named(),
            self.allocated.named()
        )
    }
}

/// The sites with bytes, largest first; one whose frames the profile doesn't have is left out.
fn sites<'a>(profile: &'a Profile<'a>, memory: &Value) -> Vec<Site<'a>> {
    let mut sites: Vec<Site> = memory
        .get("sites")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|site| int(site, "bytes") > 0)
        .filter_map(|site| {
            let frames: Vec<&Frame> = frames_of(&site["frames"])
                .into_iter()
                .filter_map(|index| profile.frame(index))
                .collect();
            let allocated = *frames.last()?;
            let own = frames
                .iter()
                .rev()
                .find(|frame| frame.in_app)
                .copied()
                .unwrap_or(allocated);
            Some(Site {
                bytes: int(site, "bytes"),
                count: int(site, "count"),
                allocated,
                own,
            })
        })
        .collect();
    sites.sort_by_key(|site| std::cmp::Reverse(site.bytes));
    sites
}

fn memory_of(profile: &Profile, memory: &Value, top: usize, merged: bool) -> String {
    let mut facts = vec![
        format!(
            "memory profile: peak {}{} above where it started",
            bytes(int(memory, "peak")),
            if merged {
                " (one trace's, the largest)"
            } else {
                ""
            }
        ),
        format!("net {}", signed(int(memory, "net"))),
    ];
    if let Some(allocated) = memory.get("allocated").and_then(Value::as_i64) {
        facts.push(format!("{} allocated in all", bytes(allocated)));
    }
    let mut out = vec![facts.join(" · ")];
    out.extend(gc_line(profile.raw));
    if text(memory, "sites_at") == "end" {
        out.push(format!(
            "note: the sites are where the memory was at {} end, not at its peak.",
            if merged {
                "each trace's"
            } else {
                "the trace's"
            }
        ));
    }
    if memory.get("shared").and_then(Value::as_bool) == Some(true) {
        out.push(
            "note: other traces ran in the process meanwhile: these numbers include what they allocated.".into(),
        );
    }
    out.push(
        "note: counting memory slows the code down (Python's tracemalloc, a short request several times over; \
         Node's heap sampler less, and a full GC after the response): compare times on traces profiled without it."
            .into(),
    );
    let sites = sites(profile, memory);
    if sites.is_empty() {
        out.push("\nNo allocation sites were recorded.".into());
        return out.join("\n");
    }
    let all: i64 = sites.iter().map(|site| site.bytes).sum();
    let at = if text(memory, "sites_at") == "end" {
        "at the end"
    } else {
        "at the peak"
    };
    let shown = sites.len().min(top);
    out.push(format!(
        "\nallocation sites {at} ({shown} of {}, {} in all, largest first; ×: allocations counted):",
        sites.len(),
        bytes(all)
    ));
    out.extend(sites.iter().take(top).map(|site| {
        format!(
            "  {}  {}  ×{}  {}",
            bytes(site.bytes),
            share(site.bytes as f64, all as f64),
            site.count,
            site.named()
        )
    }));
    out.join("\n")
}

/// The functions' own time, by what names them in both traces: its name and where it is defined.
fn self_times(profile: &Profile) -> (Vec<(String, f64)>, f64) {
    let mut times: Vec<(String, f64)> = Vec::new();
    let stacks = profile.own_code();
    for (index, own, _) in functions(&stacks) {
        let Some(frame) = profile.frame(index) else {
            continue;
        };
        let key = if frame.file.is_empty() {
            frame.function.to_owned()
        } else {
            format!("{} ({}:{})", frame.function, frame.file, frame.line)
        };
        match times.iter_mut().find(|(name, _)| *name == key) {
            Some((_, time)) => *time += own,
            None => times.push((key, own)),
        }
    }
    (times, profile.total())
}

/// The bytes at each site, by its name.
fn site_bytes(profile: &Profile, memory: &Value) -> Vec<(String, i64)> {
    let mut found: Vec<(String, i64)> = Vec::new();
    for site in sites(profile, memory) {
        let key = site.named();
        match found.iter_mut().find(|(name, _)| *name == key) {
            Some((_, size)) => *size += site.bytes,
            None => found.push((key, site.bytes)),
        }
    }
    found
}

/// The biggest changes from `old` to `new`, by name: `name: before → after`.
fn changes<T: Copy + Default + PartialEq>(
    old: &[(String, T)],
    new: &[(String, T)],
    size: impl Fn(T) -> f64,
    say: impl Fn(T) -> String,
    least: f64,
) -> Vec<String> {
    let find = |list: &[(String, T)], key: &str| {
        list.iter()
            .find(|(name, _)| name == key)
            .map_or_else(T::default, |(_, value)| *value)
    };
    let mut names: Vec<&String> = old.iter().map(|(name, _)| name).collect();
    names.extend(
        new.iter()
            .map(|(name, _)| name)
            .filter(|name| !old.iter().any(|(old, _)| old == *name)),
    );
    let mut found: Vec<(f64, String)> = names
        .into_iter()
        .filter_map(|name| {
            let (was, now) = (find(old, name), find(new, name));
            let delta = size(now) - size(was);
            (delta.abs() >= least && delta != 0.0)
                .then(|| (delta, format!("  {name}: {} → {}", say(was), say(now))))
        })
        .collect();
    found.sort_by(|a, b| b.0.abs().total_cmp(&a.0.abs()));
    found
        .into_iter()
        .take(CHANGES)
        .map(|(_, line)| line)
        .collect()
}

/// What changed in the two traces' profiles: the time and the functions whose own time changed most, the memory's
/// peak and the sites that changed most. `None` when neither trace was profiled.
pub(crate) fn compare(before: &Value, after: &Value) -> Option<String> {
    let (old, new) = match (Profile::of(before), Profile::of(after)) {
        (None, None) => return None,
        (Some(_), None) => {
            return Some(
                "profile: only the before trace was profiled; profile the after one too to compare (an \
                 `X-Tracepanel-Profile: 1` header)."
                    .into(),
            );
        }
        (None, Some(_)) => {
            return Some(
                "profile: only the after trace was profiled; profile the before one too to compare (an \
                 `X-Tracepanel-Profile: 1` header)."
                    .into(),
            );
        }
        (Some(old), Some(new)) => (old, new),
    };
    let waited = |profile: &Profile| -> f64 {
        profile
            .stacks
            .iter()
            .filter(|stack| profile.waits(stack))
            .map(|stack| stack.us)
            .sum()
    };
    let (old_times, old_total) = self_times(&old);
    let (new_times, new_total) = self_times(&new);
    let mut out = vec![format!(
        "profile: {} → {} profiled, of which waiting {} → {}",
        us(old_total),
        us(new_total),
        us(waited(&old)),
        us(waited(&new))
    )];
    let least = old_total.max(new_total) / 100.0;
    let lines = changes(&old_times, &new_times, |time| time, us, least);
    if !lines.is_empty() {
        out.push("functions whose self time changed most:".into());
        out.extend(lines);
    }

    let memory = |profile: &Profile| -> Option<Value> {
        profile
            .raw
            .get("memory")
            .filter(|memory| memory.is_object())
            .cloned()
    };
    match (memory(&old), memory(&new)) {
        (Some(was), Some(now)) => {
            out.push(format!(
                "memory: peak {} → {}, net {} → {}",
                bytes(int(&was, "peak")),
                bytes(int(&now, "peak")),
                signed(int(&was, "net")),
                signed(int(&now, "net"))
            ));
            let (old_sites, new_sites) = (site_bytes(&old, &was), site_bytes(&new, &now));
            let largest = old_sites
                .iter()
                .chain(&new_sites)
                .map(|(_, size)| *size)
                .max()
                .unwrap_or(0);
            let lines = changes(
                &old_sites,
                &new_sites,
                |size| size as f64,
                bytes,
                largest as f64 / 100.0,
            );
            if !lines.is_empty() {
                out.push("allocation sites that changed most:".into());
                out.extend(lines);
            }
        }
        (Some(_), None) => out.push(
            "note: only the before trace counted its memory, which slows the code down: its times are higher for it."
                .into(),
        ),
        (None, Some(_)) => out.push(
            "note: only the after trace counted its memory, which slows the code down: its times are higher for it."
                .into(),
        ),
        (None, None) => {}
    }
    Some(out.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A trace of one app with its memory: a site in build_cards, its peak and where the sites were taken.
    fn traced(peak: i64, at: &str) -> Value {
        let frame = |function: &str, file: &str, line: i64| json!({"function": function, "module": "", "file": file, "line": line, "in_app": true});
        json!({"id": "T", "duration": 20_000, "profile": {
            "interval_us": 1000, "samples": 2,
            "frames": [frame("sales", "reports/views.py", 18), frame("build_cards", "reports/cards.py", 40)],
            "stacks": [{"frames": [0, 1], "count": 2}],
            "memory": {"peak": peak, "net": 1_024, "allocated": 2_048, "sites_at": at,
                       "sites": [{"frames": [0, 1], "bytes": 1_048_576, "count": 2}]},
        }})
    }

    #[test]
    fn an_apps_traces_add_up_as_one_memory() {
        let (one, two) = (traced(2_097_152, "end"), traced(3_145_728, "peak"));

        let answer = app_profile(&[&one, &two], Kind::Memory, 5).unwrap();

        assert_eq!(
            answer,
            "memory profile: peak 3.0 MB (one trace's, the largest) above where it started · net +2.0 KB · 4.0 KB \
             allocated in all
note: counting memory slows the code down (Python's tracemalloc, a short request several times over; Node's heap \
             sampler less, and a full GC after the response): compare times on traces profiled without it.

allocation sites at the peak (1 of 1, 2.0 MB in all, largest first; ×: allocations counted):
  2.0 MB  100%  ×4  build_cards (yours) — reports/cards.py:40"
        );
    }

    #[test]
    fn an_apps_traces_add_up_as_one_cpu_profile() {
        let (one, two) = (traced(0, "peak"), traced(0, "peak"));

        let answer = app_profile(&[&one, &two], Kind::Cpu, 5).unwrap();

        assert!(
            answer.starts_with(
                "CPU profile: 4.0 ms sampled of the traces' 40.0 ms · 4 samples, one every 1.0 ms"
            ),
            "{answer}"
        );
        assert_eq!(app_profile(&[], Kind::Cpu, 5), None);
    }

    /// A Node task's samples as tracepanel-js sends them: one in the job's own code under the worker's and the
    /// runtime's frames, one in the runtime and OpenTelemetry's code alone.
    fn node_task() -> Value {
        let frame = |function: &str, file: &str, in_app: bool| json!({"function": function, "module": null, "file": file, "line": 1, "in_app": in_app});
        json!({"id": "T", "duration": 10_000, "profile": {
            "interval_us": 1000, "samples": 10,
            "frames": [
                frame("processTicksAndRejections", "node:internal/process/task_queues", false),
                frame("callback", "bullmq/dist/cjs/classes/worker.js", false),
                frame("rankProducts", "worker.ts", true),
                frame("stringify", "", false),
                frame("export", "@opentelemetry/sdk-trace-base/build/src/export/BatchSpanProcessorBase.js", false),
                frame("listOnTimeout", "node:internal/timers", false),
            ],
            "stacks": [{"frames": [0, 1, 2, 3], "count": 6}, {"frames": [5, 4, 3], "count": 4}],
        }})
    }

    #[test]
    fn your_code_is_the_apps_frames_alone_a_stack_without_them_the_framework_and_runtimes() {
        let doc = node_task();
        let profile = Profile::of(&doc).unwrap();

        let stacks: Vec<Vec<&str>> = profile
            .own_code()
            .iter()
            .map(|stack| {
                stack
                    .frames
                    .iter()
                    .map(|&index| profile.frames[index].function)
                    .collect()
            })
            .collect();

        assert_eq!(
            stacks,
            vec![vec!["rankProducts"], vec!["(framework & runtime)"]]
        );
    }

    /// A Next.js request's samples as tracepanel-js sends them (the route's handler, its helper, pg and
    /// OpenTelemetry's span processor under it; Next's error inspection; the runtime's timers and files).
    fn next_request() -> Value {
        let frame = |function: &str, file: &str, in_app: bool| json!({"function": function, "module": null, "file": file, "line": 1, "in_app": in_app});
        json!({"id": "N", "duration": 10_000, "profile": {
            "interval_us": 1000, "samples": 10,
            "frames": [
                frame("processTicksAndRejections", "node:internal/process/task_queues", false),
                frame("runMicrotasks", "", false),
                frame("GET", "app/api/catalog/products/route.ts", true),
                frame("card", "lib/catalog.ts", true),
                frame("query", "pg-pool/index.js", false),
                frame("connect", "@opentelemetry/instrumentation-pg/build/src/instrumentation.js", false),
                frame("startSpan", "@opentelemetry/sdk-trace/build/src/Tracer.js", false),
                frame("onStart", "@opentelemetry/sdk-trace/build/src/MultiSpanProcessor.js", false),
                frame("prepareUnsourcemappedStackTrace", "next/dist/server/patch-error-inspect.js", false),
                frame("readFileSync", "node:fs", false),
            ],
            "stacks": [
                {"frames": [0, 1, 2, 3, 4, 5, 6, 7], "count": 4},
                {"frames": [0, 1, 2, 3, 8], "count": 3},
                {"frames": [0, 1, 2, 3, 4], "count": 2},
                {"frames": [9], "count": 1},
            ],
        }})
    }

    #[test]
    fn tracings_own_time_is_never_your_code() {
        let doc = next_request();
        let profile = Profile::of(&doc).unwrap();

        let stacks: Vec<(Vec<&str>, i64)> = profile
            .own_code()
            .iter()
            .map(|stack| {
                let names = stack
                    .frames
                    .iter()
                    .map(|&index| profile.frames[index].function)
                    .collect();
                (names, stack.count)
            })
            .collect();

        assert_eq!(
            stacks,
            vec![
                (vec!["(framework & runtime)"], 4),
                (vec!["GET", "card"], 3),
                (vec!["GET", "card"], 2),
                (vec!["(framework & runtime)"], 1),
            ]
        );
    }

    /// A Gin request's CPU profile as tracepanel-go sends it: 30 ms on the CPU of 99 ms, the rest waiting on
    /// Postgres, which runtime/pprof doesn't sample.
    #[test]
    fn a_go_profile_is_its_time_on_the_cpu_the_rest_waiting() {
        let frame = |function: &str, module: &str, file: &str, in_app: bool| json!({"function": function, "module": module, "file": file, "line": 1, "in_app": in_app});
        let doc = json!({"id": "G", "duration": 99_000, "attrs": {"telemetry.sdk.language": "go"}, "profile": {
            "interval_us": 1000, "samples": 30, "dropped": 0,
            "frames": [
                frame("(*App).listProducts", "shop", "catalog.go", true),
                frame("editDistance", "shop", "similar.go", true),
                frame("syscall.syscall", "syscall", "syscall/syscall_darwin.go", false),
            ],
            "stacks": [{"frames": [0, 1], "count": 25}, {"frames": [0, 2], "count": 5}],
        }});

        let read = profile(&doc, Kind::Cpu, 3).unwrap();
        let lines: Vec<&str> = read.lines().take(2).collect();

        assert_eq!(
            lines,
            [
                "CPU profile: 30.0 ms on the CPU of the trace's 99.0 ms · 30 samples, one every 1.0 ms of CPU time",
                "waiting, off the CPU (the database, the network, a lock, a timer; not sampled): 69.0 ms (70%)",
            ]
        );
    }

    /// A stack of the profile's view by its functions' names, with its time in µs.
    fn named(profile: &Profile, stacks: &[Stack]) -> Vec<(Vec<String>, i64)> {
        stacks
            .iter()
            .map(|stack| {
                let names = stack
                    .frames
                    .iter()
                    .map(|&index| profile.frames[index].function.to_owned())
                    .collect();
                (names, stack.us.round() as i64)
            })
            .collect()
    }

    /// A call out of the request, `at` ms into it, `ms` long, made from `origin`.
    fn call(kind: &str, at: i64, ms: i64, origin: &str) -> Value {
        json!({"id": format!("{kind}{at}"), "parent_id": "r", "kind": kind, "start": 1_000_000 + at * 1000,
               "duration": ms * 1000, "attrs": {"code.origin": origin}})
    }

    /// A Gin request's CPU profile with its calls: a query from listProducts, one from similar, a Redis command from
    /// count (never sampled: its line in catalog.go is listProducts'), 30 ms of the 69 off the CPU in none.
    #[test]
    fn a_go_profiles_calls_wait_under_the_function_that_made_them() {
        let frame = |function: &str, file: &str, line: i64, in_app: bool| json!({"function": function, "module": "shop", "file": file, "line": line, "in_app": in_app});
        let doc = json!({"id": "G", "start": 1_000_000, "duration": 99_000,
            "attrs": {"telemetry.sdk.language": "go"},
            "spans": [
                {"id": "r", "parent_id": null, "kind": "http", "start": 1_000_000, "duration": 99_000, "attrs": {}},
                call("sql", 5, 20, "catalog.go:14 in (*App).listProducts"),
                call("sql", 40, 10, "similar.go:8 in (*App).similar"),
                call("redis", 60, 9, "catalog.go:30 in (*App).count"),
            ],
            "profile": {
                "interval_us": 1000, "samples": 30, "dropped": 0,
                "frames": [
                    frame("(*App).listProducts", "catalog.go", 10, true),
                    frame("(*App).similar", "similar.go", 5, true),
                    frame("editDistance", "similar.go", 40, true),
                    frame("syscall.syscall", "syscall/syscall_darwin.go", 1, false),
                ],
                "stacks": [{"frames": [0, 1, 2], "count": 25}, {"frames": [0, 3], "count": 5}],
            },
        });
        let profile = Profile::of(&doc).unwrap();

        let stacks = named(&profile, &profile.own_code());

        let names = |names: &[&str]| {
            names
                .iter()
                .map(|name| (*name).to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            stacks,
            vec![
                (
                    names(&["(*App).listProducts", "(*App).similar", "editDistance"]),
                    25_000
                ),
                (names(&["(*App).listProducts"]), 5_000),
                (names(&["(*App).listProducts", "off the CPU"]), 29_000),
                (
                    names(&["(*App).listProducts", "(*App).similar", "off the CPU"]),
                    10_000
                ),
                (names(&["off the CPU"]), 30_000),
            ]
        );
    }
}
