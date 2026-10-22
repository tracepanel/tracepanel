// A task run's place in its workflow: its facts say what it follows, its root, its group, when it was due and its
// time limit; its related traces list the runs before and after it, its callbacks and its group's other tasks.
import type { Locator, Page } from "@playwright/test";
import { traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

/** A task's run on its first tab (Task): its facts, and its related traces. */
async function open(page: Page, name: string) {
  await page.goto(`/#/t/${await traceId(name)}`);
  await page.getByRole("tab", { name: /^Task/ }).click();
  return {
    facts: page.getByRole("tabpanel").locator("dl").first(),
    related: page.getByRole("region", { name: "Related traces" }),
  };
}

/** The value beside a name: a fact's, or a related traces row's. */
function beside(list: Locator, label: string): Locator {
  return list.locator("dt", { hasText: new RegExp(`^${label}$`) }).locator("xpath=following-sibling::dd[1]");
}

test("a chain's last step says what it follows and its root, and lists them as its workflow", async ({ page }) => {
  const { facts, related } = await open(page, "shop.tasks.store_feed");

  await expect(beside(facts, "Follows")).toHaveText("shop.tasks.parse_feed");
  await expect(beside(facts, "Root")).toHaveText("shop.tasks.fetch_feed");
  await expect(related.getByText("Workflow", { exact: true })).toBeVisible();
  await expect(beside(related, "Root")).toContainText("shop.tasks.fetch_feed");
  await expect(beside(related, "Previous step")).toContainText("shop.tasks.parse_feed");
  // The step that sent it is its previous step: not listed again as what enqueued it.
  await expect(related.getByText("Enqueued by", { exact: true })).toHaveCount(0);

  await beside(facts, "Root").getByRole("link").click();
  await page.getByRole("tab", { name: /^Task/ }).click();
  const first = page.getByRole("region", { name: "Related traces" });
  await expect(beside(first, "Next step")).toContainText("shop.tasks.parse_feed");
  await expect(beside(first, "Next step")).toContainText("success");
});

test("a chord's callback follows the group's last task and lists the group, the failed one too", async ({ page }) => {
  const { facts, related } = await open(page, "shop.tasks.thumbnails_done");

  await expect(beside(facts, "Follows")).toHaveText("shop.tasks.make_thumbnail");
  await expect(beside(facts, "Group")).toHaveText("3 tasks");
  await expect(beside(facts, "Group").getByRole("link")).toHaveAttribute("href", /group(%3A|:)thumbs/);
  await expect(beside(related, "Previous step")).toContainText("shop.tasks.make_thumbnail");
  const group = beside(related, "Group \\(3 tasks\\)");
  await expect(group.getByRole("link")).toHaveCount(3);
  await expect(group).toContainText("failure");

  await beside(facts, "Group").getByRole("link").click();
  await expect(page.getByText("3 shown")).toBeVisible();
});

test("a long group shows how many tasks it has, its first few, and a search for them all", async ({ page }) => {
  await page.route("**/api/traces/*/related", async (route) => {
    const related = await (await route.fetch()).json();
    if (related.workflow?.group) related.workflow.group.tasks = 300;
    await route.fulfill({ json: related });
  });
  const { related } = await open(page, "shop.tasks.thumbnails_done");
  const group = beside(related, "Group \\(300 tasks\\)");

  await expect(group).toContainText("+297 more");
  await expect(group.getByRole("link", { name: "All 300 tasks" })).toHaveAttribute("href", /group(%3A|:)thumbs/);
});

test("a job that waited for another follows it, and that one lists it and its callback", async ({ page }) => {
  const waited = await open(page, "shop.jobs.publish_image");

  await expect(beside(waited.facts, "Follows")).toHaveText("shop.jobs.resize_image");
  await expect(beside(waited.related, "Enqueued by")).toContainText("/api/images");
  await expect(beside(waited.related, "Previous step")).toContainText("shop.jobs.resize_image");

  const first = await open(page, "shop.jobs.resize_image");
  await expect(beside(first.related, "Next step")).toContainText("shop.jobs.publish_image");
  await expect(beside(first.related, "Callback")).toContainText("shop.jobs.log_resized");
  await expect(beside(first.related, "Callback")).toContainText("on_success");
  await expect(first.related.getByText("Enqueued task", { exact: true })).toHaveCount(0);

  const callback = await open(page, "shop.jobs.log_resized");
  await expect(beside(callback.facts, "Callback \\(on_success\\) of")).toHaveText("shop.jobs.resize_image");
  await expect(beside(callback.related, "Callback of")).toContainText("shop.jobs.resize_image");
});

test("a run its time limit stopped says so", async ({ page }) => {
  const { facts } = await open(page, "shop.jobs.render_report");

  await expect(beside(facts, "Time limit")).toHaveText("30 s · stopped by its time limit");
});

test("a delayed task says when it was due, and how late it started", async ({ page }) => {
  const { facts } = await open(page, "shop.tasks.send_reminder");

  await expect(beside(facts, "Due")).toHaveText(/^[A-Z][a-z]{2} \d{2} \d{2}:\d{2}:\d{2}\.\d{3} · 2 min late$/);
  await expect(beside(facts, "Priority")).toHaveText("5");
});
