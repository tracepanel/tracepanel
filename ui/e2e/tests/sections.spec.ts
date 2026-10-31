// Every section the seeded traces fill: it is in the sidebar, opens, and lists what it should.
import { expect, test } from "../fixtures.ts";

const SECTIONS = [
  { link: "Pages", heading: "Pages", row: "/books" },
  { link: "HTTP", heading: "HTTP", row: "/api/posts" },
  { link: "Tasks", heading: "Tasks", row: "shop.tasks.send_receipt" },
  { link: "Jobs", heading: "Jobs", row: "manage.py rebuild_index" },
  { link: "Services", heading: "Services", row: "blog" },
  { link: "Database", heading: "Database", row: "SELECT" },
  { link: "Logs", heading: "Logs", row: null },
  { link: "Errors", heading: "Errors", row: "RuntimeError" },
  { link: "Issues", heading: "Issues", row: "N+1" },
] as const;

for (const section of SECTIONS) {
  test(`${section.link} opens from the sidebar`, async ({ page }) => {
    await page.goto("/");
    // By its whole name, its count after it ("Errors 4"): "HTTP" is not "HTTP calls", which may show first while the
    // sidebar's sections arrive one by one.
    await page
      .getByRole("navigation")
      .getByRole("link", { name: new RegExp(`^${section.link}(\\s*\\d+)?$`) })
      .click();

    await expect(page.getByRole("heading", { level: 1, name: section.heading })).toBeVisible();
    if (section.row) await expect(page.getByRole("main").getByText(section.row).first()).toBeVisible();
  });
}

test("the Data group lists the stores, the brokers, the calls out, storage, then logs", async ({ page }) => {
  await page.goto("/");
  const links = page.getByRole("navigation").getByRole("link");
  const order = ["Services", "Database", "Redis", "Kafka", "HTTP calls", "AWS", "LLM", "Storage", "Logs"];

  // Read again until every section has arrived: the sidebar shows a section once its counts say it has rows.
  await expect.poll(async () => (await links.allTextContents()).filter((name) => order.includes(name))).toEqual(order);
});
