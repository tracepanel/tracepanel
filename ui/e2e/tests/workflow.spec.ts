// A task run's place in its workflow: its facts say what it follows, its root, its group, when it was due and its
// time limit; its graph draws the runs before and after it, its callbacks and its group's other tasks.
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

test("a chain's last step says what it follows and its root; the graph is its workflow, not rows again", async ({
  page,
}) => {
  const { facts, related } = await open(page, "shop.tasks.store_feed");

  await expect(beside(facts, "Follows")).toHaveText("shop.tasks.parse_feed");
  await expect(beside(facts, "Root")).toHaveText("shop.tasks.fetch_feed");
  // Drawn below, the workflow is not listed again among the related traces.
  await expect(related).toHaveCount(0);
  await expect(box(page, "shop.tasks.fetch_feed")).toBeVisible();
  await expect(box(page, "shop.tasks.parse_feed")).toBeVisible();

  await beside(facts, "Root").getByRole("link").click();
  await page.getByRole("tab", { name: /^Task/ }).click();

  await expect(box(page, "shop.tasks.fetch_feed")).toHaveAttribute("aria-current", "true");
  await expect(box(page, "shop.tasks.parse_feed")).toContainText("success");
});

test("a chord's callback follows the group's last task, its graph framing the group, the failed one too", async ({
  page,
}) => {
  const { facts } = await open(page, "shop.tasks.thumbnails_done");

  await expect(beside(facts, "Follows")).toHaveText("shop.tasks.make_thumbnail");
  await expect(beside(facts, "Group")).toHaveText("3 tasks");
  await expect(beside(facts, "Group").getByRole("link")).toHaveAttribute("href", /group(%3A|:)thumbs/);
  await expect(box(page, "shop.tasks.make_thumbnail")).toHaveCount(3);
  await expect(graph(page)).toContainText("failure");

  await beside(facts, "Group").getByRole("link").click();
  await expect(page.getByText("3 shown")).toBeVisible();
});

test("a long group draws its first few tasks and a search for them all", async ({ page }) => {
  await page.route("**/api/traces/*/related", async (route) => {
    const related = await (await route.fetch()).json();
    const nodes = related.workflow?.graph?.nodes ?? [];
    const member = nodes.find((node: { group: string | null }) => node.group === "thumbs");
    if (member) {
      for (let n = 0; n < 297; n += 1) {
        // biome-ignore lint/style/useNamingConvention: the wire format.
        nodes.push({ ...member, task_id: `extra-${n}`, trace: { ...member.trace, id: `extra-${n}` } });
      }
    }
    await route.fulfill({ json: related });
  });
  await open(page, "shop.tasks.thumbnails_done");

  await expect(graph(page).getByText("Group · 300 tasks")).toBeVisible();
  await expect(graph(page).getByRole("link", { name: /^\+295 more/ })).toHaveAttribute("href", /group(%3A|:)thumbs/);
});

test("a group of one task says one task, in its facts and its frame", async ({ page }) => {
  await page.route("**/api/traces/*/related", async (route) => {
    const related = await (await route.fetch()).json();
    const workflow = related.workflow;
    if (workflow?.group) {
      const nodes: { group: string | null }[] = workflow.graph?.nodes ?? [];
      const first = nodes.findIndex((node) => node.group === "thumbs");
      workflow.graph.nodes = nodes.filter((node, n) => node.group !== "thumbs" || n === first);
      workflow.group.tasks = 1;
    }
    await route.fulfill({ json: related });
  });
  const { facts } = await open(page, "shop.tasks.thumbnails_done");

  await expect(beside(facts, "Group")).toHaveText("1 task");
  await expect(graph(page).getByText("Group · 1 task", { exact: true })).toBeVisible();
});

test("a job that waited for another follows it; the graph draws both and its callback", async ({ page }) => {
  const waited = await open(page, "shop.jobs.publish_image");

  await expect(beside(waited.facts, "Follows")).toHaveText("shop.jobs.resize_image");
  await expect(beside(waited.related, "Enqueued by")).toContainText("/api/images");
  await expect(box(page, "shop.jobs.resize_image")).toBeVisible();
  await expect(box(page, "shop.jobs.log_resized")).toContainText("on_success");

  const callback = await open(page, "shop.jobs.log_resized");
  await expect(beside(callback.facts, "Callback \\(on_success\\) of")).toHaveText("shop.jobs.resize_image");
  await expect(box(page, "shop.jobs.resize_image")).toBeVisible();
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

/** A run's workflow drawn whole: its boxes by their names, as their titles give them. */
function graph(page: Page) {
  return page.getByRole("region", { name: "Workflow" }).getByTestId("workflow-graph");
}

function box(page: Page, name: string): Locator {
  return graph(page).locator(`[title^="${name}"]`);
}

test("a chain is drawn whole, the run on screen marked, the others links to their traces", async ({ page }) => {
  await open(page, "shop.tasks.parse_feed");

  await expect(box(page, "shop.tasks.fetch_feed")).toContainText("fetch_feed");
  await expect(box(page, "shop.tasks.parse_feed")).toHaveAttribute("aria-current", "true");
  await expect(box(page, "shop.tasks.store_feed")).toContainText("success");
  await expect(graph(page).locator("svg path[marker-end]")).toHaveCount(2);

  await box(page, "shop.tasks.store_feed").click();
  await expect(page.getByRole("heading", { name: /shop\.tasks\.store_feed/ })).toBeVisible();
});

test("a chord is drawn as its request, the group in a frame, and the callback after it", async ({ page }) => {
  await open(page, "shop.tasks.make_thumbnail");

  await expect(box(page, "/api/thumbnails")).toContainText("POST");
  await expect(graph(page).getByText("Group · 3 tasks")).toBeVisible();
  await expect(box(page, "shop.tasks.make_thumbnail")).toHaveCount(3);
  await expect(box(page, "shop.tasks.thumbnails_done")).toBeVisible();
  // Into the group and out of it: one line each.
  await expect(graph(page).locator("svg path[marker-end]")).toHaveCount(2);
});

test("a job's callback is drawn after it, named as one", async ({ page }) => {
  await open(page, "shop.jobs.publish_image");

  await expect(box(page, "shop.jobs.resize_image")).toBeVisible();
  await expect(box(page, "shop.jobs.log_resized")).toContainText("on_success");
  await expect(box(page, "shop.jobs.publish_image")).toHaveAttribute("aria-current", "true");
});
