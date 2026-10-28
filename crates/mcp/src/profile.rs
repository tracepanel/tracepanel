//! A trace's profile as the model reads it: where its time went in code (the functions by their own time and in
//! all, the hottest paths) and where its memory was (the peak, what it kept, the sites that held most). The numbers
//! are the console's Profile tab's, read the same way: a profile that says when its stacks were seen reads in the
//! trace's own time, one with enough of the project's code reads as that code (a library call it made counts all
//! the call did), and a site is named by the line of the project's code that led to it.

use crate::compact::{int, ms, text};
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
        let frames = raw
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
        Some(Self {
            frames,
            stacks,
            interval,
            samples: int(raw, "samples"),
            dropped: int(raw, "dropped"),
            timed,
            raw,
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

    /// A stack as the project's code sees it: its frames, and after each the library call it made (what that call
    /// spent, it spent). A stack without the project's code is left as it is.
    fn own_frames(&self, frames: &[usize]) -> Vec<usize> {
        let yours: Vec<bool> = frames.iter().map(|&index| self.yours(index)).collect();
        let kept: Vec<usize> = frames
            .iter()
            .enumerate()
            .filter(|&(at, _)| yours[at] || (at > 0 && yours[at - 1]))
            .map(|(_, &index)| index)
            .collect();
        if kept.is_empty() {
            frames.to_vec()
        } else {
            kept
        }
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
            (self.own_code(), "your code, with the library calls it made")
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

/// The profile of `kind`, compact, with its `top` functions or sites; why not, when the trace has none.
pub(crate) fn profile(doc: &Value, kind: Kind, top: usize) -> Result<String, String> {
    let id = text(doc, "id");
    let Some(profile) = Profile::of(doc) else {
        return Err(format!("Trace {id} has no profile. {HOW}"));
    };
    match kind {
        Kind::Cpu => Ok(cpu(&profile, int(doc, "duration"), top)),
        Kind::Memory => match profile
            .raw
            .get("memory")
            .filter(|memory| memory.is_object())
        {
            Some(memory) => Ok(memory_of(&profile, memory, top)),
            None => Err(format!(
                "Trace {id} has a CPU profile but its memory wasn't counted. Make the request again with an \
                 `X-Tracepanel-Profile: memory` header or a `tracepanel_profile=memory` cookie (the \
                 `profile_memory` setting counts every profiled trace's); then wait_for_trace and get_profile."
            )),
        },
    }
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

fn cpu(profile: &Profile, duration: i64, top: usize) -> String {
    let total = profile.total();
    let mut out = vec![format!(
        "CPU profile: {} {} of the trace's {} · {} samples, one every {}",
        us(total),
        if profile.timed { "profiled" } else { "sampled" },
        ms(duration),
        profile.samples,
        ms(profile.interval)
    )];
    let waited: f64 = profile
        .stacks
        .iter()
        .filter(|stack| profile.waits(stack))
        .map(|stack| stack.us)
        .sum();
    if waited > 0.0 {
        let mut line = format!(
            "waiting (a sleep, a socket, a lock, the event loop: not computing): {} ({})",
            us(waited),
            share(waited, total)
        );
        if let Some(name) = profile.wait_name() {
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

fn memory_of(profile: &Profile, memory: &Value, top: usize) -> String {
    let mut facts = vec![
        format!(
            "memory profile: peak {} above where it started",
            bytes(int(memory, "peak"))
        ),
        format!("net {}", signed(int(memory, "net"))),
    ];
    if let Some(allocated) = memory.get("allocated").and_then(Value::as_i64) {
        facts.push(format!("{} allocated in all", bytes(allocated)));
    }
    let mut out = vec![facts.join(" · ")];
    out.extend(gc_line(profile.raw));
    if text(memory, "sites_at") == "end" {
        out.push(
            "note: the sites are where the memory was at the trace's end, not at its peak.".into(),
        );
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
