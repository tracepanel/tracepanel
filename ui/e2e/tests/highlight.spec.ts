// The source around an error's frame, highlighted by the console's own tokenizer: each language an SDK sends.
import { languageOf, type SourceToken, tokenizeLines } from "../../packages/ui/src/highlight.ts";
import { expect, test } from "../fixtures.ts";

/** The tokens of a line as `type:text`, plain ones as their text without the spaces around it. */
const shown = (line: SourceToken[] | undefined): string[] =>
  (line ?? [])
    .filter((token) => token.text.trim())
    .map((token) => (token.type === "plain" ? token.text.trim() : `${token.type}:${token.text}`));

test("each SDK's files have their language, others none", () => {
  const languages = ["app.py", "app.go", "server.js", "routes.ts", "page.tsx", "Main.java", "App.kt", "views.rb"].map(
    languageOf,
  );

  expect(languages).toEqual(["python", "go", "javascript", "javascript", "javascript", "java", "kotlin", null]);
});

test("Python: keywords, strings, comments, decorators and calls", () => {
  const lines = tokenizeLines(
    ['@app.get("/books")', "def books(limit=10):  # all of them", "    return list(None)"],
    "python",
  );

  expect(lines.map(shown)).toEqual([
    ["decorator:@app.get", "punctuation:(", 'string:"/books"', "punctuation:)"],
    [
      "keyword:def",
      "function:books",
      "punctuation:(",
      "limit",
      "operator:=",
      "number:10",
      "punctuation:)",
      "operator::",
      "comment:# all of them",
    ],
    ["keyword:return", "builtin:list", "punctuation:(", "boolean:None", "punctuation:)"],
  ]);
});

test("JavaScript and TypeScript: template strings, keywords and calls", () => {
  const lines = tokenizeLines(
    ["const book = await db.query(`SELECT 1`); // one", "throw new Error('missing');"],
    "javascript",
  );

  expect(lines.map(shown)).toEqual([
    [
      "keyword:const",
      "book",
      "operator:=",
      "keyword:await",
      "db",
      "punctuation:.",
      "function:query",
      "punctuation:(",
      "string:`SELECT 1`",
      "punctuation:)",
      "punctuation:;",
      "comment:// one",
    ],
    [
      "keyword:throw",
      "keyword:new",
      "builtin:Error",
      "punctuation:(",
      "string:'missing'",
      "punctuation:)",
      "punctuation:;",
    ],
  ]);
});

test("Java: annotations, types and a block comment across lines", () => {
  const lines = tokenizeLines(
    ["/* the books", "   of an author */", "@GetMapping public List<Book> books(long id) {"],
    "java",
  );

  expect(lines.map(shown)).toEqual([
    ["comment:/* the books"],
    ["comment:   of an author */"],
    [
      "decorator:@GetMapping",
      "keyword:public",
      "builtin:List",
      "operator:<",
      "class-name:Book",
      "operator:>",
      "function:books",
      "punctuation:(",
      "keyword:long",
      "id",
      "punctuation:)",
      "punctuation:{",
    ],
  ]);
});

test("a Go frame's source shows highlighted in the trace", async ({ page, request }) => {
  const found = (await (
    await request.get(`/api/traces?q=${encodeURIComponent("route:/boom service:api")}&limit=1`)
  ).json()) as { traces: { id: string }[] };
  await page.goto(`/#/t/${found.traces[0]?.id}`);
  await page.getByRole("tab", { name: /^Error/ }).click();
  const current = page.locator(".dt-source li[data-current]").first();

  await expect(current).toContainText('books["missing"]++');
  await expect(current.locator(".token.string")).toHaveText('"missing"');
  await expect(page.locator(".dt-source .token.keyword", { hasText: /^func$/ }).first()).toBeVisible();
});
