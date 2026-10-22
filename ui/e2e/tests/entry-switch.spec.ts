// Every entry point opens on all its calls; its switch reads "All … | By …", and goes both ways.
import { expect, test } from "../fixtures.ts";

const ENTRIES = [
  { path: "endpoints", link: "HTTP", all: "All requests", by: "By endpoint", group: "Endpoint" },
  { path: "tasks", link: "Tasks", all: "All runs", by: "By task", group: "Task" },
  { path: "jobs", link: "Jobs", all: "All runs", by: "By job", group: "Job" },
  { path: "pages", link: "Pages", all: "All events", by: "By page", group: "Page" },
] as const;

for (const entry of ENTRIES) {
  test(`${entry.link} opens on ${entry.all}, the switch reads All first, and goes both ways`, async ({ page }) => {
    await page.goto("/#/logs");
    await page.getByRole("complementary").getByRole("link", { name: entry.link, exact: true }).click();
    const list = page.getByRole("navigation", { name: "List" });
    const main = page.getByRole("main");

    await expect(page).toHaveURL(new RegExp(`#/${entry.path}$`));
    await expect(list.getByRole("link")).toHaveText([entry.all, entry.by]);
    await expect(list.getByRole("link", { name: entry.all })).toHaveAttribute("aria-current", "page");
    await expect(main.getByRole("columnheader", { name: "Trace" })).toBeVisible();

    await list.getByRole("link", { name: entry.by }).click();

    await expect(page).toHaveURL(new RegExp(`#/${entry.path}\\?view=overview$`));
    await expect(list.getByRole("link", { name: entry.by })).toHaveAttribute("aria-current", "page");
    await expect(main.getByRole("columnheader", { name: entry.group, exact: true })).toBeVisible();

    await list.getByRole("link", { name: entry.all }).click();

    await expect(page).toHaveURL(new RegExp(`#/${entry.path}$`));
    await expect(list.getByRole("link", { name: entry.all })).toHaveAttribute("aria-current", "page");
    await expect(main.getByRole("columnheader", { name: "Trace" })).toBeVisible();
  });
}

test("a link that names its list still opens it: view=calls on All, view=overview on By", async ({ page }) => {
  const list = page.getByRole("navigation", { name: "List" });

  await page.goto("/#/endpoints?view=calls");

  await expect(list.getByRole("link", { name: "All requests" })).toHaveAttribute("aria-current", "page");

  await page.goto("/#/endpoints?view=overview");

  await expect(list.getByRole("link", { name: "By endpoint" })).toHaveAttribute("aria-current", "page");
});
