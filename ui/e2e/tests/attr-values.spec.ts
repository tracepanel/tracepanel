// Values in every list of names and values, one look: a list one item a line, JSON and a Python repr laid out and
// coloured, a long one folded, each copied as it came; a trace's attributes the same in its Request tab and on its
// call tree's request row.
import type { Locator, Page } from "@playwright/test";
import { pythonLiteral } from "../../packages/ui/src/lib/pyliteral.ts";
import { isRepr, prettyRepr, shapeOf } from "../../packages/ui/src/lib/values.ts";
import { traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

/** The value of a row named `name` in a list of names and values. */
function value(list: Locator, name: string): Locator {
  return list.locator("dt", { hasText: new RegExp(`^${name}$`) }).locator("+ dd");
}

async function openOrder(page: Page, tab: string): Promise<void> {
  await page.goto(`/#/t/${await traceId("POST /orders/")}?tab=${tab}`);
}

test("a value's shape: a list one item a line, JSON and a repr as code, anything else as it came", () => {
  expect(shapeOf(["a", 1, true])).toEqual({ kind: "list", items: ["a", "1", "true"] });
  expect(shapeOf([])).toEqual({ kind: "text", text: "[]" });
  expect(shapeOf(42)).toEqual({ kind: "text", text: "42" });
  expect(shapeOf(null)).toEqual({ kind: "text", text: "null" });
  expect(shapeOf({ a: [1] })).toEqual({ kind: "code", text: '{\n  "a": [\n    1\n  ]\n}', language: "javascript" });
  expect(shapeOf('{"a":1}')).toEqual({ kind: "code", text: '{\n  "a": 1\n}', language: "javascript" });
  expect(shapeOf("['a', 'b']")).toEqual({ kind: "code", text: "['a', 'b']", language: "python" });
  expect(shapeOf("None")).toEqual({ kind: "code", text: "None", language: "python" });
  expect(shapeOf("[1/3] step")).toEqual({ kind: "text", text: "[1/3] step" });

  expect(shapeOf(`[${"'x', ".repeat(5_000)}]`).kind).toBe("text");
});

test("a repr is one only when it is whole: its brackets and quotes balance, the first closes at the end", () => {
  expect(isRepr("{'a': (1, 2)}")).toBe(true);
  expect(isRepr("True")).toBe(true);
  expect(isRepr("(1, 2) and more")).toBe(false);
  expect(isRepr("['it\\'s', \"a ]\"]")).toBe(true);
  expect(isRepr("['cut off…")).toBe(false);
  expect(isRepr("[1, 2)")).toBe(false);
  expect(isRepr("<QuerySet [1, 2]>")).toBe(false);
});

test("a long repr opens a group a line, an item a line; a short group stays on its line", () => {
  const databases =
    "{'default': {'ENGINE': 'django.db.backends.postgresql', 'NAME': 'shop', 'PORT': '5432'}, 'replica': {}}";

  expect(prettyRepr(databases)?.split("\n")).toEqual([
    "{",
    "  'default': {",
    "    'ENGINE': 'django.db.backends.postgresql',",
    "    'NAME': 'shop',",
    "    'PORT': '5432'",
    "  },",
    "  'replica': {}",
    "}",
  ]);
  expect(prettyRepr("(1, 2)")).toBe("(1, 2)");
  expect(
    prettyRepr(`(${"'a long item', ".repeat(5)})`)
      ?.split("\n")
      .at(-2),
  ).toBe("  'a long item',");
});

test("a request with only its attributes has the same switch as any other, its one part Attributes", async ({
  page,
}) => {
  await openOrder(page, "request");
  const attributes = page.getByRole("tabpanel", { name: "Attributes" });

  await expect(page.getByRole("tablist", { name: "Request details" }).getByRole("tab")).toHaveText([
    /^Attributes\s*8$/,
  ]);
  await expect(attributes.getByRole("heading", { level: 4 })).toHaveText([
    /^code\s*1$/,
    /^http\s*4$/,
    /^service\s*1$/,
    /^signal\s*1$/,
    /^telemetry\s*1$/,
  ]);
});

test("a list attribute reads one item a line, in the Request tab and on the call tree's request row alike", async ({
  page,
}) => {
  const items = ["pre_save shop.Order: 3", "pre_delete auth.Group: 1"];
  await openOrder(page, "request");
  const request = page.getByRole("tabpanel", { name: "Attributes" });

  await expect(
    value(request.getByRole("region", { name: "signal", exact: true }), "unreceived").getByRole("listitem"),
  ).toHaveText(items);
  const shown = await request.innerText();

  await page.getByRole("tab", { name: /^Call tree/ }).click();
  await page.locator(".dt-map-row").first().click();
  // The request row shows the Request tab's parts, behind the same switch.
  const tree = page.getByRole("complementary", { name: "Details" }).getByRole("tabpanel", { name: "Attributes" });

  await expect(
    value(tree.getByRole("region", { name: "signal", exact: true }), "unreceived").getByRole("listitem"),
  ).toHaveText(items);
  expect(await tree.innerText()).toBe(shown);

  await value(tree, "unreceived").hover();
  await tree.getByRole("button", { name: "Copy unreceived" }).click();

  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(JSON.stringify(items));
});

test("a log record's JSON (its message, a field) is laid out and coloured; a list field one item a line", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId("GET /books/")}?tab=logs`);
  await page.getByText("books listed").first().click();
  const fields = page.getByRole("region", { name: "Fields" });
  const filters = value(fields, "extra.filters");

  await expect(filters.locator("code.dt-syntax")).toHaveText(/^\{\s*"genre": "fiction",\s*"page": 2,/);
  await expect(filters.locator(".token.string").first()).toHaveText('"genre"');
  await expect(filters.locator(".token.boolean")).toHaveText("true");
  await expect(value(fields, "extra.ids").getByRole("listitem")).toHaveText(["3", "5", "8"]);

  const message = page.getByRole("region", { name: "Message" });

  await expect(message.locator(".token.string").first()).toHaveText('"event"');
  await expect(message.locator(".token.number")).toHaveText("12");
});

test("a Python repr is laid out and coloured: an app's settings, a template's context", async ({ page }) => {
  await page.goto("/#/app/shop");
  const settings = page.getByRole("tabpanel", { name: "Settings" });
  const databases = value(settings, "DATABASES");

  await expect(value(settings, "ALLOWED_HOSTS").locator(".token.string")).toHaveText(["'localhost'", "'127.0.0.1'"]);
  await expect(value(settings, "DEBUG").locator(".token.boolean")).toHaveText("True");
  await expect(databases.locator("code.dt-syntax > span").first()).toHaveText("{");
  await expect(databases.locator(".token.string").first()).toHaveText("'default'");

  await page.goto(`/#/t/${await traceId("GET /books/")}?tab=tree`);
  await page.getByText("books/list.html").first().click();
  const genres = value(page.getByRole("region", { name: "Template context" }), "genres");

  await expect(genres.locator("code.dt-syntax > span")).toHaveCount(6);
  await expect(genres.locator(".token.string").first()).toHaveText("'genre 0'");

  await genres.getByRole("button", { name: "Show all 42 lines" }).click();

  await expect(genres.locator("code.dt-syntax > span")).toHaveCount(42);
});

test("an error's locals are a list of names and values: each one copies", async ({ page }) => {
  await page.goto(`/#/t/${await traceId("GET /error/")}?tab=error`);
  const locals = page.getByRole("region", { name: "Locals", exact: true });

  await expect(locals.locator("dt")).toHaveText(["posts", "request"]);
  await expect(value(locals, "request")).toHaveText("<WSGIRequest: GET '/error/'>");

  await value(locals, "request").hover();
  await locals.getByRole("button", { name: "Copy request" }).click();

  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("<WSGIRequest: GET '/error/'>");
});

test("a task's long result is laid out and coloured in its facts, whole, not cut to a line", async ({ page }) => {
  await page.goto(`/#/t/${await traceId("shop.tasks.send_reminder")}?tab=request`);
  const facts = page.getByRole("main");
  // The facts' Result, not the same value again in the attributes below.
  // Shown as the JSON the Python literal stands for.
  const result = facts.locator("dd").filter({ hasText: '"List 0": 100' }).first();

  await expect(result).toContainText('"List 4": 100');
  await result.getByRole("button", { name: /^Show all/ }).click();

  await expect(result).toContainText('"List 11": 100');
  await expect(result.locator(".token.string").first()).toBeVisible();
  expect(await result.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});

test("a task's arguments and result, Python literals, read as the JSON they stand for", () => {
  expect(pythonLiteral("()")).toEqual([]);
  expect(pythonLiteral("(42, 'a')")).toEqual([42, "a"]);
  expect(pythonLiteral("{'attempts': 3, 'ok': True, 'none': None, 'f': -1.5}")).toEqual({
    attempts: 3,
    ok: true,
    none: null,
    f: -1.5,
  });
  expect(pythonLiteral("[{'to': 'ann@example.com'}, (1,)]")).toEqual([{ to: "ann@example.com" }, [1]]);
  expect(pythonLiteral("'it\\'s'")).toBe("it's");

  // Not a literal, whole: shown as it came.
  expect(pythonLiteral("<User: ann>")).toBeUndefined();
  expect(pythonLiteral("{'a': 1, 'b': ...")).toBeUndefined();
  expect(pythonLiteral("datetime.date(2026, 10, 22)")).toBeUndefined();
});
