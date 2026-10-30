// The sidebar's footer says where the agent takes OTLP, under where it keeps the data. One agent on a machine gets a
// port: another project's agent that wanted it says, calmly, whose it is and what to set for this project's apps,
// until it takes the port over.
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures.ts";

type Otlp = Record<string, unknown>;

/**
 * The agent's OTLP status as its API says it: served at `address`, or taken (`by` a project's agent, an older agent
 * that says no project, or another program).
 */
function status(
  address: string,
  served: boolean,
  by: string | null = null,
  free: string | null = null,
  agent = by !== null,
): Otlp {
  return {
    address,
    serving: served,
    error: served ? null : "Address already in use (os error 48)",
    taken: !served,
    // biome-ignore lint/style/useNamingConvention: wire format.
    taken_by: by,
    // biome-ignore lint/style/useNamingConvention: wire format.
    taken_by_agent: agent,
    free,
  };
}

/** The agent's answer with this OTLP status (or what `said` says at the time), whatever the agent of the run serves. */
async function otlp(page: Page, said: Otlp | (() => Otlp)): Promise<void> {
  await page.route(
    (url) => url.pathname.endsWith("/api/capabilities") && !url.searchParams.has("service"),
    async (route) => {
      const capabilities = await (await route.fetch()).json();
      await route.fulfill({ json: { ...capabilities, otlp: typeof said === "function" ? said() : said } });
    },
  );
}

test("the footer shows where the agent takes OTLP, a line under the store", async ({ page }) => {
  await otlp(page, status("127.0.0.1:4319", true));
  await page.goto("/#/endpoints");
  const footer = page.locator("aside footer");

  await expect(footer).toContainText("Local · .tracepanel/");
  await expect(footer).toContainText("OTLP · 127.0.0.1:4319");
  await expect(footer.getByRole("note")).toHaveCount(0);
});

test("a port another project's agent holds is named, with the address to set instead", async ({ page }) => {
  await otlp(page, status("127.0.0.1:4318", false, "shop", "127.0.0.1:4319"));
  await page.goto("/#/endpoints");
  const notice = page.locator("aside footer").getByRole("note", { name: "OTLP" });

  await expect(notice).toHaveText(
    "OTLP: 127.0.0.1:4318 is taken by the agent of shop. Set TRACEPANEL_OTLP=127.0.0.1:4319 for this project's apps and point its OTLP exporters there.",
  );
  await expect(page.locator("aside footer")).not.toContainText("OTLP · ");
});

test("a port another program holds says so", async ({ page }) => {
  await otlp(page, status("127.0.0.1:4318", false, null, "127.0.0.1:4320"));
  await page.goto("/#/endpoints");

  await expect(page.locator("aside footer").getByRole("note", { name: "OTLP" })).toContainText(
    "is taken by another program. Set TRACEPANEL_OTLP=127.0.0.1:4320",
  );
});

test("a port an older agent holds says so", async ({ page }) => {
  await otlp(page, status("127.0.0.1:4318", false, null, "127.0.0.1:4319", true));
  await page.goto("/#/endpoints");

  await expect(page.locator("aside footer").getByRole("note", { name: "OTLP" })).toContainText(
    "is taken by an older Tracepanel agent. Set TRACEPANEL_OTLP=127.0.0.1:4319",
  );
});

test("the notice turns into the address once the agent has taken the port over", async ({ page }) => {
  await page.clock.install();
  let said = status("127.0.0.1:4318", false, "shop", "127.0.0.1:4319");
  await otlp(page, () => said);
  await page.goto("/#/endpoints");
  const footer = page.locator("aside footer");
  await expect(footer.getByRole("note", { name: "OTLP" })).toContainText("is taken by the agent of shop");

  // The other project's agent has gone, and this one serves the port: the console asks again every 10 seconds.
  said = status("127.0.0.1:4318", true);
  await page.clock.runFor(10_000);

  await expect(footer).toContainText("OTLP · 127.0.0.1:4318");
  await expect(footer.getByRole("note")).toHaveCount(0);
});
