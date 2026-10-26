// AWS in the console: one page of every call to AWS by service and operation, one group per region in the services
// map, and the issues of S3's and DynamoDB's calls in a trace.
import { traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";
import { AWS_REQUEST } from "../seed.ts";

test("AWS lists every service's operations, with the failures by code and the retries", async ({ page }) => {
  await page.goto("/#/");
  await page.getByRole("navigation").getByRole("link", { name: "AWS", exact: true }).click();

  const table = page.getByRole("region", { name: "AWS" }).getByRole("table");
  const row = (name: RegExp) => table.getByRole("row").filter({ hasText: name });
  await expect(row(/Amazon S3\s*HeadObject/)).toContainText("NoSuchKey 1");
  await expect(
    row(/Amazon DynamoDB\s*Scan/)
      .getByRole("cell")
      .nth(4),
  ).toHaveText("2");
  await expect(row(/AWS Lambda\s*Invoke/)).toBeVisible();
  await expect(row(/AWS Secrets Manager\s*GetSecretValue/)).toBeVisible();
  // The storage's own PutObject is an AWS call too, made for the storage.
  await expect(row(/Amazon S3\s*PutObject/)).toBeVisible();
  // AWS's other calls are on this page, not on a page of their own.
  await expect(page.getByRole("navigation").getByRole("link", { name: /^AWS calls/ })).toHaveCount(0);
});

test("AWS's services are listed under AWS, shown while AWS or one of them is open", async ({ page }) => {
  await page.goto("/#/");
  const nav = page.getByRole("navigation");
  const services = ["DynamoDB", "Amazon SNS", "Amazon SQS"];

  await expect(nav.getByRole("link", { name: "AWS", exact: true })).toBeVisible();
  for (const name of services) await expect(nav.getByRole("link", { name, exact: true })).toHaveCount(0);
  // Kafka and RabbitMQ are no AWS services: they stay where they were.
  await expect(nav.getByRole("link", { name: "Kafka", exact: true })).toBeVisible();

  await nav.getByRole("link", { name: "AWS", exact: true }).click();

  const links = nav.getByRole("link");
  const names = await links.allTextContents();
  const aws = names.indexOf("AWS");
  expect(names.slice(aws, aws + 4)).toEqual(["AWS", ...services]);

  await nav.getByRole("link", { name: "DynamoDB", exact: true }).click();

  await expect(page).toHaveURL(/#\/calls\/dynamodb/);
  await expect(page.getByRole("heading", { level: 1, name: "DynamoDB" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "DynamoDB", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Amazon SQS", exact: true })).toBeVisible();
});

test("an AWS service's own page opens from search and from its URL", async ({ page }) => {
  await page.goto("/#/calls/sqs");
  await expect(page.getByRole("heading", { level: 1, name: "Amazon SQS" })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("dialog").getByRole("combobox").fill("Amazon SNS");
  await page.getByRole("dialog").getByRole("option", { name: "Amazon SNS" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Amazon SNS" })).toBeVisible();
});

test("an AWS row opens to where it is called from and its latest calls, and leads to its system's page", async ({
  page,
}) => {
  await page.goto("/#/aws");
  const table = page.getByRole("region", { name: "AWS" }).getByRole("table");
  await table
    .getByRole("row")
    .filter({ hasText: /Amazon S3\s*HeadObject/ })
    .click();

  const from = page.getByRole("region", { name: "Called from" });
  await expect(from).toContainText("shop");
  await expect(from).toContainText("avatars/views.py:24 in upload");
  const latest = page.getByRole("region", { name: "Latest calls" }).getByRole("link");
  await expect(latest).toHaveCount(3);
  await expect(latest.first()).toContainText("S3 HeadObject media/thumbs/");

  await page.getByRole("link", { name: "Its N+1 and duplicates on Storage" }).click();

  await expect(page).toHaveURL(/#\/calls\/storage\?q=op%3AHeadObject/);
  await expect(page.getByRole("heading", { level: 1, name: "Storage" })).toBeVisible();
});

test("the services map draws each AWS service in one group per region, and a service opens its calls", async ({
  page,
}) => {
  await page.goto("/#/services");
  const map = page.getByRole("region", { name: "Architecture" });

  await expect(map.getByText("AWS · eu-west-1", { exact: true })).toBeVisible();
  for (const service of ["Amazon S3", "Amazon DynamoDB", "Amazon SQS", "Amazon SNS", "AWS Lambda"]) {
    // One box a service, at its endpoint in the region (a Django storage on S3 in another app is a box of its own).
    await expect(map.getByRole("link", { name: new RegExp(`^${service} .*eu-west-1\\.amazonaws\\.com$`) })).toHaveCount(
      1,
    );
  }

  await map.getByRole("link", { name: /^AWS Lambda / }).click();

  await expect(page).toHaveURL(/#\/aws\?q=aws%3ALambda/);
});

test("a request's S3 and DynamoDB issues say AWS's way to fix them", async ({ page }) => {
  await page.goto(`/#/t/${await traceId(AWS_REQUEST)}?tab=issues`);
  const issues = page.getByRole("tabpanel");

  await expect(issues.getByRole("heading", { name: "Slow call 820 ms · GetObject media/originals/*" })).toBeVisible();
  await expect(issues.getByRole("heading", { name: "Slow call 310 ms · Scan users" })).toBeVisible();
  await expect(
    issues.getByRole("heading", { name: "N+1 3 similar storage calls · HeadObject media/thumbs/*" }),
  ).toBeVisible();
  await expect(issues.getByText(/Query by the partition key instead, with a global secondary index/)).toBeVisible();
  await expect(issues.getByText(/presigned URL/)).toBeVisible();
});
