// A share as the console's tiles and lists write it: a whole percent, and one that is neither none nor all never
// rounds to either, so one failed call in hundreds doesn't read 0% in the error colour.
import { percent, percents } from "../../packages/ui/src/lib/percent.ts";
import { expect, test } from "../fixtures.ts";

test("a share is a whole percent, never 0% or 100% unless it is", () => {
  const shares = [
    [0, 389],
    [1, 389],
    [2, 389],
    [4, 389],
    [194, 389],
    [386, 389],
    [388, 389],
    [389, 389],
    [5, 0],
  ].map(([part = 0, total = 0]) => percent(part, total));

  expect(shares).toEqual(["0%", "<1%", "1%", "1%", "50%", "99%", ">99%", "100%", "0%"]);
});

test("a legend's percents add up to 100%: 7, 3, 2 and 125 ms of a Node task's 137 ms", () => {
  expect(percents([7_000, 3_000, 2_000, 125_000], 137_000)).toEqual(["5%", "2%", "2%", "91%"]);
  // A sliver still reads <1%, the rest adding up to what they are of.
  expect(percents([1, 388], 389)).toEqual(["<1%", ">99%"]);
  expect(percents([3, 2], 35)).toEqual(["8%", "6%"]);
});

test("one failed statement in hundreds reads <1% on the Database page", async ({ page }) => {
  await page.route("**/api/calls/summary?*", (route) =>
    route.fulfill({
      json: {
        calls: 389,
        traces: 40,
        // biome-ignore lint/style/useNamingConvention: wire format.
        most_per_trace: 21,
        errors: 1,
        total: 1_200_000,
        p95: 9_000,
        hits: null,
        misses: null,
        // biome-ignore lint/style/useNamingConvention: wire format.
        tokens_in: null,
        // biome-ignore lint/style/useNamingConvention: wire format.
        tokens_out: null,
        cost: null,
      },
    }),
  );
  await page.goto("/#/calls/sql");
  const failed = page.getByRole("region", { name: "Summary" }).getByRole("button", { name: /Failed/ });

  await expect(failed).toContainText("<1%");
  await expect(failed).toContainText("1 of 389");
});
