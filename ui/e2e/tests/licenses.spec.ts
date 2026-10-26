// The licenses the agent carries: a link in the sidebar's footer opens them, as `tracepanel-agent licenses` prints them.
import { expect, test } from "../fixtures.ts";

test("the sidebar's Licenses link opens the agent's license and the third parties' notices", async ({ page }) => {
  await page.goto("/#/services");
  const link = page.getByRole("complementary").getByRole("link", { name: "Licenses" });

  await expect(link).toHaveAttribute("href", "api/licenses");
  await expect(link).toHaveAttribute("target", "_blank");

  const [tab] = await Promise.all([page.waitForEvent("popup"), link.click()]);
  const body = tab.locator("body");

  await expect(body).toContainText("Functional Source License");
  await expect(body).toContainText("Copyright 2026 DevRealm");
  await expect(body).toContainText("shadcn/ui components");
});
