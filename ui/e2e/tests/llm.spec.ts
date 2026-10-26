// LLM calls: a kind of their own in the call tree, in a colour of their own, an LLM share of the time, their details
// (provider, model, tokens, cost, time to first token, tool calls), their messages as a conversation, a count with
// the tokens and cost in the trace's header, an N+1 for calls made one by one, and a page of their own.
import type { Page } from "@playwright/test";
import { traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

async function openAssistant(page: Page, tab = "calls"): Promise<void> {
  await page.goto(`/#/t/${await traceId("POST /assistant/")}?tab=${tab}`);
}

function row(page: Page, kind: string, name: string | RegExp) {
  return page.locator(`.dt-map-row[data-kind="${kind}"]`).filter({ hasText: name });
}

test("an LLM call's row: its kind and model, in a colour of its own; its HTTP request inside it", async ({ page }) => {
  await openAssistant(page);
  const calls = row(page, "llm", "chat claude-sonnet-4-5");

  await expect(calls.first().locator(".dt-map-kind")).toHaveText("llm");
  const colour = (locator: typeof calls) =>
    locator.evaluate((element) => getComputedStyle(element).getPropertyValue("--dt-k").trim());
  const llm = await colour(calls.first());

  expect(llm).not.toBe("");
  expect(llm).not.toBe(await colour(row(page, "function", "get_weather")));
});

test("an LLM call's details: provider, model asked and answered, tokens, cost, first token, tools", async ({
  page,
}) => {
  await openAssistant(page);
  const details = page.getByRole("complementary", { name: "Details" });
  const value = (label: string) => details.locator("dt", { hasText: new RegExp(`^${label}$`) }).locator("+ dd");

  await row(page, "llm", "chat claude-sonnet-4-5").last().click();

  await expect(value("Provider")).toHaveText("Anthropic");
  await expect(value("Model")).toHaveText("claude-sonnet-4-5 → claude-sonnet-4-5-20250929");
  await expect(value("Tokens")).toHaveText("1,402 in · 38 out · 1,200 cached");
  await expect(value("Cost")).toHaveText("~$0.00154 (estimate, at list price)");
  await expect(value("Time to first token")).toHaveText("412 ms");
  await expect(value("Finish reason")).toHaveText("end_turn");
});

test("an LLM call's messages read as a conversation, the earlier turns folded", async ({ page }) => {
  await openAssistant(page);
  const details = page.getByRole("complementary", { name: "Details" });

  await row(page, "llm", "chat claude-sonnet-4-5").last().click();

  const conversation = details.getByRole("region", { name: "Conversation" });
  const turns = conversation.locator(".dt-llm-turn");
  await expect(turns.locator(".dt-llm-role")).toHaveText(["System", "User", "Assistant", "User", "Assistant"]);
  // The history folded, the last message sent and the answer open.
  await expect(turns.nth(0)).not.toHaveAttribute("open");
  await expect(turns.nth(2).locator(".dt-llm-preview")).toHaveText("Let me look.");
  await expect(turns.nth(3)).toContainText('← toolu_1 {\n  "sky": "clear"');
  await expect(turns.nth(4)).toContainText("It's clear in Oslo, 7 °C.");

  await turns.nth(2).locator("summary").click();

  // The tool call's arguments, masked as the SDK sent them.
  await expect(turns.nth(2)).toContainText('→ get_weather({\n  "city": "Oslo",\n  "api_key": "********"\n})');
  // The messages aren't listed again among the attributes.
  await expect(details.getByRole("region", { name: "All attributes" })).not.toContainText("gen_ai.input.messages");
});

test("the header counts the LLM calls with their tokens and cost, the strip has their share", async ({ page }) => {
  await openAssistant(page);

  await expect(page.locator(".dt-trace-facts")).toContainText(/· 2 LLM calls [\d.]+ s · 2,816 tokens · ~\$0\.00298/);
  const legend = page.getByRole("list", { name: /^Where the time went/ });
  await expect(legend.locator('[data-category="llm"]')).toContainText("LLM");
  // The HTTP requests are the model's time: no External calls share.
  await expect(legend.locator('[data-category="http"]')).toHaveCount(0);
});

test("an agent's turns are no issue; summaries made one by one are an N+1 with a batching hint", async ({ page }) => {
  await openAssistant(page, "issues");
  await expect(page.getByRole("tab", { name: /^Issues/ })).toHaveCount(0);

  await page.goto(`/#/t/${await traceId("POST /summaries/")}?tab=issues`);
  const issues = page.getByRole("tabpanel");

  await expect(issues.getByRole("heading", { name: "N+1 3 similar LLM calls · chat gpt-4o-mini" })).toBeVisible();
  await expect(page.getByText(/use the provider's Batch API/)).toBeVisible();
});

test("LLM lists its calls by provider, operation and model, with tokens, cost and p95", async ({ page }) => {
  await page.goto("/#/calls/llm");
  const region = page.getByRole("region", { name: "LLM" });
  const rows = region.getByRole("rowgroup").last().getByRole("row");

  await expect(rows).toHaveCount(2);
  const claude = rows.filter({ hasText: "chat claude-sonnet-4-5" });
  await expect(claude).toContainText("Anthropic");
  await expect(claude).toContainText("2,732 / 84");
  await expect(claude).toContainText("~$0.00298");
  await expect(rows.filter({ hasText: "chat gpt-4o-mini" })).toContainText("OpenAI");

  const summary = page.getByRole("region", { name: "Summary" });
  await expect(summary).toContainText("Tokens");
  await expect(summary).toContainText("estimate, at list prices");
});
