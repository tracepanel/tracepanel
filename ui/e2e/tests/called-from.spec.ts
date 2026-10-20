// Where a query was made: a query no code of the project's made (an admin's page) names the library code that asked
// for it, marked as the library's.
import { traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

test("a query only library code made names that code, marked as a library's", async ({ page }) => {
  await page.goto(`/#/t/${await traceId("GET /admin/users/")}?tab=sql`);
  await page.getByText("SELECT COUNT auth_user").first().click();

  await expect(page.getByText("library", { exact: true })).toHaveCount(2);
  await expect(page.getByText("django/core/paginator.py:110 in Paginator.count")).toBeVisible();
  await expect(page.getByText("django/contrib/admin/views/main.py:320 in ChangeList.get_results")).toBeVisible();
});
