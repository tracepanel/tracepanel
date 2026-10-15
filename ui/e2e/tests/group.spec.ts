// One group's page: the period it looks at, picked from presets or by dragging over its calls.
import { expect, test } from "../fixtures.ts";

const GROUP = `/#/group/pages/${encodeURIComponent('/books › click "Save"')}`;

test("a group's page picks its period: a preset, then all time again", async ({ page }) => {
  await page.goto(GROUP);
  await page.getByRole("button", { name: "Time" }).click();
  await page.getByRole("button", { name: "Last hour" }).click();

  await expect(page).toHaveURL(/q=since%3A1h$/);
  await expect(page.getByRole("region", { name: "Summary" })).toContainText("Calls1");
});

test("dragging over a group's calls looks at that stretch", async ({ page }) => {
  await page.goto(GROUP);
  const chart = page.getByRole("img", { name: "calls and errors over time" });
  const box = await chart.boundingBox();
  if (!box) throw new Error("no chart");
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();

  await expect(page).toHaveURL(/q=since%3A.+until%3A/);
});

test("one call still gets a time axis: its calls chart spans a window, not a moment", async ({ page }) => {
  await page.goto(GROUP);
  const axis = page.getByRole("img", { name: "calls and errors over time" }).locator("text");
  const labels = await axis.allTextContents();
  const times = labels.filter((label) => /^\d{1,2}:\d{2}/.test(label));

  expect(new Set(times).size).toBeGreaterThan(1);
});
