#!/usr/bin/env node
// A dev check that every view of a profiled trace's time says the same: over a store's profiled traces, the time
// strip's legend, the Profile tab's head and bar (the trace's own, and each app's in a chain), each code and wait row
// and the stretch it opens, against the MCP server's get_profile. One computed result says them all (lib/split.ts,
// crates/mcp/src/split.rs); this reads what a person and an AI agent are shown, the console in Chromium and the MCP
// server over stdio, and lists every place they disagree, or a share's percents don't add up to 100%.
//
// It copies the store first and runs its own agent on the copy (the store passed in is never written to), on ports
// of its own, OTLP off. CI runs it on the e2e store after the e2e tests (.github/workflows/ci.yml).
//
//   node scripts/profile_sweep.mjs --agent target/debug/tracepanel-agent --store ui/e2e/.store [--limit 200]
//
// Exits 1 when anything disagrees, 2 when it couldn't run.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

const args = {};
for (let at = 2; at < process.argv.length; at += 2) args[process.argv[at].replace(/^--/, "")] = process.argv[at + 1];
const AGENT = resolve(args.agent ?? "target/debug/tracepanel-agent");
const STORE = args.store ? resolve(args.store) : null;
const LIMIT = Number(args.limit ?? 1_000_000);
if (!(STORE && existsSync(STORE) && existsSync(AGENT))) {
  console.error("usage: node scripts/profile_sweep.mjs --agent BIN --store DIR [--limit N]");
  process.exit(2);
}

// Playwright as the e2e tests have it (ui/e2e's dependency).
const require = createRequire(new URL("../ui/e2e/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

/** The store, copied: the agent runs on the copy. */
function copyOf(store) {
  const work = mkdtempSync(join(tmpdir(), "profile-sweep-"));
  for (const name of readdirSync(store)) {
    if (/^traces\.v\d+\.sqlite3(-wal|-shm)?$/.test(name)) cpSync(join(store, name), join(work, name));
  }
  return work;
}

/** The traces, newest first, with their app and whether they have a profile. */
function tracesIn(dir) {
  const file = readdirSync(dir).find((name) => /^traces\.v\d+\.sqlite3$/.test(name));
  const db = new DatabaseSync(join(dir, file), { readOnly: true });
  const rows = db
    .prepare(
      `select id, json_type(doc, '$.profile') = 'object' as profiled,
        coalesce(json_extract(doc, '$.profile.bucket_us'), 0) > 0
          or coalesce(json_array_length(json_extract(doc, '$.profile.stacks')), 0) = 0 as readable,
        (select max(json_extract(value, '$.start') + json_extract(value, '$.duration')) - min(json_extract(value, '$.start'))
           from json_each(doc, '$.spans')) >= duration as spanned
       from traces order by start desc limit ?`,
    )
    .all(LIMIT);
  db.close();
  return rows.map((row) => ({
    ...row,
    profiled: Boolean(row.profiled),
    readable: Boolean(row.readable),
    spanned: Boolean(row.spanned),
  }));
}

/** The agent on the copy, serving the console on a free port: its URL once it says it. */
function serve(dir) {
  const agent = spawn(AGENT, ["--dir", dir, "--serve", "127.0.0.1:0", "--listen", "tcp:127.0.0.1:0", "--otlp", "off"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((done, fail) => {
    const lines = createInterface({ input: agent.stdout });
    const errors = createInterface({ input: agent.stderr });
    const read = (line) => {
      const found = /console\s+(http:\/\/\S+)/.exec(line);
      if (found) done({ agent, url: found[1] });
    };
    lines.on("line", read);
    errors.on("line", read);
    agent.on("exit", (code) => fail(new Error(`the agent exited (${code}) before it served the console`)));
  });
}

/** get_profile of each trace, as an AI agent reads it: the MCP server over stdio. */
async function mcpProfiles(dir, ids) {
  const server = spawn(AGENT, ["mcp", "--dir", dir], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: server.stdout });
  const waiting = new Map();
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
  });
  let next = 0;
  const call = (method, params) =>
    new Promise((done) => {
      const id = next++;
      waiting.set(id, done);
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "profile-sweep", version: "1" },
  });
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const out = new Map();
  for (const id of ids) {
    const answer = await call("tools/call", { name: "get_profile", arguments: { id } });
    out.set(id, (answer.result?.content ?? []).map((part) => part.text).join("\n"));
  }
  server.kill();
  return out;
}

/** A share's percent as a number: "<1%" one said as none, ">99%" as all. */
function percentOf(text) {
  if (text === "<1%") return 0;
  if (text === ">99%") return 100;
  return Number(text.replace("%", ""));
}

/** Percents that don't add up to 100%: what's wrong with them, if anything. */
function hundred(shares) {
  const sum = shares.reduce((all, share) => all + percentOf(share.percent), 0);
  return shares.length === 0 || sum === 100 ? null : `percents add up to ${sum}%`;
}

const UNITS = { "µs": 1, ms: 1000, s: 1_000_000 };
/** "47 ms" in µs. */
function us(text) {
  const found = /([\d.,]+)\s*(µs|ms|s)\b/.exec(text ?? "");
  return found ? Math.round(Number(found[1].replaceAll(",", "")) * UNITS[found[2]]) : Number.NaN;
}

/** Shares whose times, as written, don't add up to the total written: what's wrong, if anything. */
function addsUp(shares, total) {
  // A share under the split's step ("<1 ms") counts as none.
  const sum = shares.reduce((all, share) => all + (share.value.startsWith("<") ? 0 : us(share.value)), 0);
  return shares.length === 0 || sum === us(total) ? null : `times as written add up to ${sum} µs, not ${total}`;
}

/** "Database 47 ms (38%) · Waiting 45 ms (37%)": get_profile's time by share. */
function mcpShares(line) {
  return line
    .split(" · ")
    .map((part) => /^(.+) (\S+ (?:µs|ms|s)) \((<1%|>99%|\d+%)\)$/.exec(part))
    .filter(Boolean)
    .map(([, name, value, percent]) => ({ name, value, percent }));
}

/** A block of get_profile: its head (what it profiled of what, its samples) and its time by share. */
function mcpBlock(text) {
  const head = /CPU profile: (≈ )?(\S+ (?:µs|ms|s)) profiled of (the trace's|the traces') (\S+ (?:µs|ms|s)) · (.*)/.exec(
    text,
  );
  const shares = /time by share \(as the time strip says it\): (.*)/.exec(text);
  return head
    ? {
        cover: `${head[1] ?? ""}${head[2]} profiled of ${head[3]} ${head[4]}`,
        sampled: head[5],
        shares: shares ? mcpShares(shares[1]) : [],
      }
    : null;
}

/** The trace ids a block is of, as one key. */
const idsKey = (ids) => [...ids].sort().join(",");

/** get_profile's answer: its blocks by the traces each is of (this trace's own, each app's of its chain). */
function mcpParts(id, text) {
  const [own, chain = ""] = text.split("\nchain:");
  const blocks = new Map();
  const mine = mcpBlock(own);
  if (mine) blocks.set(idsKey([id]), mine);
  for (const block of chain.split(/\n\n(?=\S+ · )/).slice(1)) {
    const head = block.split("\n")[0] ?? "";
    const parsed = mcpBlock(block);
    if (parsed) blocks.set(idsKey(head.match(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g) ?? []), parsed);
  }
  return { blocks, text };
}

/** In the page: each profile's head and bar shown (one, or an app's each in a chain). */
async function heads(page) {
  await page.waitForSelector("[data-split-head]", { timeout: 8000 }).catch(() => {});
  return page.locator("[data-split-head]").evaluateAll((all) =>
    all.map((head) => {
      const view = head.closest("header")?.parentElement ?? head;
      const section = head.closest("section.dt-app-profile");
      const bar = view.querySelector('section[aria-label="Time by package"] .dt-breakdown-legend');
      const legend = bar
        ? [...bar.querySelectorAll(".dt-share")].map((share) => ({
            name: [...share.childNodes]
              .filter((node) => node.nodeType === 3)
              .map((node) => node.textContent)
              .join("")
              .trim(),
            value: share.querySelector("b")?.textContent?.trim() ?? "",
            percent: share.querySelector(".dt-breakdown-share")?.textContent?.trim() ?? "",
          }))
        : [];
      return {
        app: section?.getAttribute("aria-label")?.replace(/^Profile of /, "") ?? null,
        traces: section?.getAttribute("data-traces")?.split(",") ?? null,
        // Its own words, not its app's chip.
        title: [...(head.firstElementChild?.childNodes ?? [])]
          .filter((node) => node.nodeType === 3)
          .map((node) => node.textContent)
          .join("")
          .trim(),
        // Its parts as one line: the number, then what it is of (set apart by a margin, not a space).
        cover: [...(head.querySelector("[data-cover]")?.childNodes ?? [])]
          .map((node) => node.textContent?.trim() ?? "")
          .filter(Boolean)
          .join(" "),
        sampled: head.querySelector("[data-sampled]")?.textContent?.trim() ?? "",
        bar: legend,
      };
    }),
  );
}

const STRIP = '[aria-label="Where the time went, and what to show"]';
const ROW = 'button.dt-map-row[data-kind="code"]';

const said = (shares) => JSON.stringify(shares.map((share) => [share.name, share.value, share.percent]));

/** The step a time is written at, from how it reads: "1.6 s" a tenth of a second, "8 ms" a ms, "0.8 ms", "27 µs". */
function stepOf(text) {
  if (/ s$/.test(text)) return 100_000;
  if (/ µs$/.test(text)) return 1;
  return /\.\d ms$/.test(text) ? 100 : 1000;
}

/**
 * Database is the time in queries, as the DB tab adds it up. Where each query runs alone (none beside it, none inside
 * it: concurrent queries add up past the time they took), the strip's Database and the DB tab's time are one time,
 * each written at its own step. What's wrong, if anything.
 */
async function databaseBroken(page, base, id, strip) {
  const tab = page.getByRole("tab", { name: /^DB\b/ });
  if ((await tab.count()) === 0) return null;
  // Its time is the tab's last piece of text ("DB", its count, then its time): read apart, not run together.
  const pieces = await tab
    .first()
    .evaluate((element) =>
      [...element.querySelectorAll("*")]
        .filter((each) => each.children.length === 0)
        .map((each) => each.textContent?.trim() ?? ""),
    );
  const said = pieces.filter((piece) => /^[\d.,]+ (?:µs|ms|s)$/.test(piece)).at(-1);
  const share = strip.find((each) => each.name === "Database");
  if (!said) return null;
  const trace = await (await fetch(new URL(`api/traces/${id}`, base))).json();
  const spans = trace.spans ?? [];
  const byId = new Map(spans.map((span) => [span.id, span]));
  const above = (span, other) => {
    for (let at = byId.get(span.parent_id); at; at = byId.get(at.parent_id)) if (at === other) return true;
    return false;
  };
  const queries = spans.filter((span) => span.kind === "sql" && span.duration > 0);
  const alone = queries.every(
    (query) =>
      !spans.some(
        (other) =>
          other.parent_id === query.id ||
          (other !== query &&
            !above(query, other) &&
            other.start < query.start + query.duration &&
            query.start < other.start + other.duration),
      ),
  );
  if (!(alone && queries.length)) return null;
  READ.databases += 1;
  if (!share) return `the DB tab says ${said}, the strip has no Database`;
  const value = share.value.startsWith("<") ? 0 : us(share.value);
  const within = (stepOf(said) + stepOf(share.value.replace(/^</, ""))) / 2;
  return Math.abs(value - us(said)) <= within ? null : `the strip's Database ${share.value}, the DB tab's ${said}`;
}

/** What the sweep read: traces, Profile heads, code and wait rows. */
const READ = { heads: 0, rows: 0, apart: 0, databases: 0 };
/** Traces not read, each with why: none is left out silently. */
const SKIPPED = [];

/**
 * Each place a trace's views disagree; without a profile, its strip's percents alone. A profile whose samples aren't
 * timed opens whole from a code row (it can't be narrowed, and says so): its rows aren't read.
 */
async function sweep(page, base, { id, profiled, readable, spanned }, mcp) {
  const problems = [];
  const problem = (what) => problems.push(`${id} ${what}`);
  // The trace's page, its call tree open: its strip shows, or the console didn't open it as a trace (an id that
  // isn't a ULID, as a test's made-up one, goes back to the list): then it is skipped, said why.
  const open = async () => {
    await page.goto("about:blank");
    await page.goto(`${base}#/t/${id}?tab=tree`);
    await page.waitForFunction(
      ([strip, hash]) => document.querySelector(strip) !== null || !location.hash.startsWith(hash),
      [STRIP, `#/t/${id}`],
      { timeout: 8000 },
    );
    return page.url().includes(`#/t/${id}`);
  };
  if (!(await open())) {
    const why = `the console doesn't open it as a trace (it went to ${new URL(page.url()).hash || "/"})`;
    // A profiled one must open: its profile is what is checked.
    if (profiled) problem(why);
    else SKIPPED.push(`${id}: ${why}`);
    return problems;
  }
  const strip = await page.locator(STRIP).evaluate((root) =>
    [...root.querySelectorAll(":scope > li > .dt-share")].map((share) => ({
      name: [...share.childNodes]
        .filter((node) => node.nodeType === 3)
        .map((node) => node.textContent)
        .join("")
        .trim(),
      value: share.querySelector("b")?.textContent?.trim() ?? "",
      percent: share.querySelector(".dt-breakdown-share")?.textContent?.trim() ?? "",
    })),
  );
  const wrong = hundred(strip);
  if (wrong) problem(`strip: ${wrong} ${said(strip)}`);
  const database = await databaseBroken(page, base, id, strip);
  if (database) problem(database);
  if (!profiled) return problems;
  const rows = readable
    ? await page
        .locator(ROW)
        .evaluateAll((all) => all.map((row) => row.querySelector(".dt-map-time")?.textContent?.trim() ?? ""))
    : [];

  const tab = page.getByRole("tab", { name: /^Profile/ });
  if ((await tab.count()) === 0) {
    problem("no Profile tab");
    return problems;
  }
  await tab.first().click();
  const shown = await heads(page);
  const header = (await page.locator(".dt-trace-time").first().textContent())?.trim() ?? "";
  if (shown.length === 0) problem("the Profile tab shows no profile");
  const answer = mcpParts(id, mcp.get(id) ?? "");
  if (/\n {2}\S.*Not profiled/.test(answer.text.split("\nfunctions by self time").slice(1).join("")))
    problem("get_profile lists Not profiled as a function");
  READ.heads += shown.length;
  for (const head of shown) {
    const what = head.app ?? "own";
    const wrongBar = hundred(head.bar);
    if (wrongBar) problem(`${what} bar: ${wrongBar} ${said(head.bar)}`);
    const cover = /^(?:≈ )?(\S+ (?:µs|ms|s)) profiled of .*? (\S+ (?:µs|ms|s))$/.exec(head.cover);
    if (!cover) problem(`${what} head reads "${head.cover}"`);
    else if (us(cover[1]) > us(cover[2])) problem(`${what} head says more profiled than its time: ${head.cover}`);
    const sum = cover && addsUp(head.bar, cover[2]);
    if (sum) problem(`${what} bar: ${sum} ${said(head.bar)}`);
    // The whole trace's time as its page's header says it.
    // Its spans' time, where they cover the trace (a made-up trace's may not: said, not counted).
    if (cover && head.title === "Profile of the whole trace" && idsKey(head.traces ?? [id]) === id && cover[2] !== header) {
      const says = `head says ${cover[2]} of the trace, its page's header ${header}`;
      if (spanned) problem(`${what} ${says}`);
      else SKIPPED.push(`${id}: its spans don't cover its time, so its ${says} (not counted)`);
    }
    // The trace's own profile: the strip's shares, to the letter.
    const traces = head.traces ?? [id];
    const own = idsKey(traces) === id;
    if (own && said(head.bar) !== said(strip)) problem(`strip ${said(strip)} != Profile bar ${said(head.bar)}`);
    // get_profile's block of the same traces: this trace's own, or an app's of its chain. The console's chain is all
    // of it (its callers too), get_profile's down its calls: an app's traces beyond that have no block to compare.
    const block = answer.blocks.get(idsKey(traces));
    if (!block) {
      if (own) problem(`${what}: get_profile has no profile of it`);
      else READ.apart += 1;
      continue;
    }
    if (block.cover !== head.cover) problem(`${what} head "${head.cover}" != get_profile "${block.cover}"`);
    if (block.sampled !== head.sampled) problem(`${what} samples "${head.sampled}" != get_profile "${block.sampled}"`);
    if (said(block.shares) !== said(head.bar))
      problem(`${what} bar ${said(head.bar)} != get_profile ${said(block.shares)}`);
  }

  // Each code and wait row: its time is the time of the stretch it opens, said the same.
  READ.rows += rows.length;
  for (let at = 0; at < rows.length; at++) {
    await open();
    await page.locator(ROW).nth(at).click();
    await page.waitForURL(/tab=profile/, { timeout: 5000 }).catch(() => {});
    const [head] = await heads(page);
    if (!head) {
      problem(`row ${at} (${rows[at]}) opened no profile`);
      continue;
    }
    const of = /of (?:the stretch's|these stretches') (\S+ (?:µs|ms|s))$/.exec(head.cover);
    if (!of) problem(`row ${at} (${rows[at]}) opened "${head.title}": ${head.cover}`);
    else if (of[1] !== rows[at]) problem(`row ${at} says ${rows[at]}, its stretch ${of[1]}`);
    const sum = of && addsUp(head.bar, of[1]);
    if (sum) problem(`row ${at} stretch bar: ${sum} ${said(head.bar)}`);
    const wrongBar = hundred(head.bar);
    if (wrongBar) problem(`row ${at} stretch bar: ${wrongBar} ${said(head.bar)}`);
    const ends = head.title.replace(/^Profile of /, "").split(", ");
    if (ends.some((part) => part.split(" – ").length === 2 && part.split(" – ")[0] === part.split(" – ")[1]))
      problem(`row ${at} stretch titled "${head.title}"`);
  }
  return problems;
}

const work = copyOf(STORE);
let agent;
let browser;
try {
  const traces = tracesIn(work);
  const served = await serve(work);
  agent = served.agent;
  const mcp = await mcpProfiles(
    work,
    traces.filter((trace) => trace.profiled).map((trace) => trace.id),
  );
  browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  page.setDefaultTimeout(8000);
  const problems = [];
  for (const trace of traces) {
    try {
      problems.push(...(await sweep(page, served.url, trace, mcp)));
    } catch (error) {
      problems.push(`${trace.id} could not be read: ${String(error).split("\n")[0]}`);
    }
  }
  const profiled = traces.filter((trace) => trace.profiled).length;
  console.log(
    `${traces.length} traces (${profiled} profiled), ${READ.heads} profile heads (${READ.apart} of a chain's traces get_profile doesn't add up together), ${READ.rows} code and wait rows, ${READ.databases} Database shares against their DB tab: ${problems.length} disagreements`,
  );
  if (SKIPPED.length) console.log(`${SKIPPED.length} not compared:`);
  for (const skipped of SKIPPED) console.log(`  not compared: ${skipped}`);
  for (const problem of problems) console.log(`  ${problem}`);
  process.exitCode = problems.length ? 1 : 0;
} catch (error) {
  console.error(error);
  process.exitCode = 2;
} finally {
  await browser?.close();
  agent?.kill();
  rmSync(work, { recursive: true, force: true });
}
