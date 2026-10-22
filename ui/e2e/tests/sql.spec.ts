// A statement reads the same whichever database ran it: SQL Server's, as Django's mssql backend writes it, is laid
// out like any other, its [bracketed] names coloured as names, TOP as a keyword, its placeholders as placeholders.
import { traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

const STATEMENT =
  "SELECT TOP 21 [campaign_stats_1].[id], [campaign_stats_1].[clicks] FROM [campaign_stats_1] " +
  "WHERE [campaign_stats_1].[campaign_id] = %s AND [campaign_stats_1].[day] > @P2";

test("a SQL Server statement is laid out and coloured like any other", async ({ page }) => {
  const id = await traceId("PATCH /campaigns/{id}/report");
  // The trace as a Django app on SQL Server would have sent it: its first query rewritten.
  await page.route(`**/api/traces/${id}`, async (route) => {
    const trace = await (await route.fetch()).json();
    const span = trace.spans.find((candidate: { name: string }) => candidate.name === "SELECT campaign_stats_1");
    span.attrs = { ...span.attrs, "db.statement": STATEMENT, "db.vendor": "microsoft", "db.system": "mssql" };
    await route.fulfill({ json: trace });
  });
  await page.goto(`/#/t/${id}?tab=sql`);
  await page.getByText("SELECT campaign_stats_1").first().click();
  const code = page.locator("pre code").filter({ hasText: "[campaign_stats_1]" });

  await expect(code).toHaveText(
    [
      "SELECT",
      "  TOP 21 [campaign_stats_1].[id],",
      "  [campaign_stats_1].[clicks]",
      "FROM",
      "  [campaign_stats_1]",
      "WHERE",
      "  [campaign_stats_1].[campaign_id] = ?",
      "  AND [campaign_stats_1].[day] > @P2",
    ].join("\n"),
  );
  await expect(code.locator(".dt-sql-keyword")).toHaveText(["SELECT", "TOP", "FROM", "WHERE", "AND"]);
  await expect(code.locator(".dt-sql-identifier").first()).toHaveText("[campaign_stats_1]");
  await expect(code.locator(".dt-sql-param")).toHaveText(["?", "@P2"]);
});
