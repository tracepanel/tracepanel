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

/** A value printed (a dump), as `shown` gives each of its lines. */
const value = (text: string, language: Parameters<typeof tokenizeLines>[1]): string[][] =>
  tokenizeLines(text.split("\n"), language, true).map(shown);

test("a JavaScript value as util.inspect prints it: class names, keys, nested and collections", () => {
  expect(value("Order { id: 7, type: 'book', items: [Array], total: 12n }", "javascript")).toEqual([
    [
      "class-name:Order",
      "punctuation:{",
      "id",
      "operator::",
      "number:7",
      "punctuation:,",
      "type",
      "operator::",
      "string:'book'",
      "punctuation:,",
      "items",
      "operator::",
      "punctuation:[",
      "builtin:Array",
      "punctuation:]",
      "punctuation:,",
      "total",
      "operator::",
      "number:12n",
      "punctuation:}",
    ],
  ]);

  expect(value("Map(2) { 'a' => 1, 'b' => null } [Function: price]", "javascript")).toEqual([
    [
      "builtin:Map",
      "punctuation:(",
      "number:2",
      "punctuation:)",
      "punctuation:{",
      "string:'a'",
      "operator:=>",
      "number:1",
      "punctuation:,",
      "string:'b'",
      "operator:=>",
      "boolean:null",
      "punctuation:}",
      "punctuation:[",
      "builtin:Function",
      "operator::",
      "price",
      "punctuation:]",
    ],
  ]);
});

test("a Go value as its pretty printer prints it: types, slices, maps, pointers and nil", () => {
  expect(
    value('main.Order{ID: 7, Items: []int{1, 2},\n  Tags: map[string]int{"x": 1}, Next: &{}, Err: nil}', "go"),
  ).toEqual([
    [
      "main",
      "punctuation:.",
      "class-name:Order",
      "punctuation:{",
      "ID",
      "operator::",
      "number:7",
      "punctuation:,",
      "Items",
      "operator::",
      "punctuation:[",
      "punctuation:]",
      "builtin:int",
      "punctuation:{",
      "number:1",
      "punctuation:,",
      "number:2",
      "punctuation:}",
      "punctuation:,",
    ],
    [
      "Tags",
      "operator::",
      "keyword:map",
      "punctuation:[",
      "builtin:string",
      "punctuation:]",
      "builtin:int",
      "punctuation:{",
      'string:"x"',
      "operator::",
      "number:1",
      "punctuation:}",
      "punctuation:,",
      "Next",
      "operator::",
      "operator:&",
      "punctuation:{",
      "punctuation:}",
      "punctuation:,",
      "Err",
      "operator::",
      "boolean:nil",
      "punctuation:}",
    ],
  ]);
});

test("a Java or Kotlin value as toString prints it: classes, records, maps, lists and null", () => {
  expect(value("Order(id=7, total=12.50, tags=[1, 2], meta={a=1, default=null})", "java")).toEqual([
    [
      "function:Order",
      "punctuation:(",
      "id",
      "operator:=",
      "number:7",
      "punctuation:,",
      "total",
      "operator:=",
      "number:12.50",
      "punctuation:,",
      "tags",
      "operator:=",
      "punctuation:[",
      "number:1",
      "punctuation:,",
      "number:2",
      "punctuation:]",
      "punctuation:,",
      "meta",
      "operator:=",
      "punctuation:{",
      "a",
      "operator:=",
      "number:1",
      "punctuation:,",
      "default",
      "operator:=",
      "boolean:null",
      "punctuation:}",
      "punctuation:)",
    ],
  ]);

  expect(value("Order[id=7, paid=false] Order@1b6d3586", "java")).toEqual([
    [
      "class-name:Order",
      "punctuation:[",
      "id",
      "operator:=",
      "number:7",
      "punctuation:,",
      "paid",
      "operator:=",
      "boolean:false",
      "punctuation:]",
      "class-name:Order",
      "@1b6d3586",
    ],
  ]);

  expect(value("Order(id=7, note=null)", "kotlin")).toEqual([
    [
      "function:Order",
      "punctuation:(",
      "id",
      "operator:=",
      "number:7",
      "punctuation:,",
      "note",
      "operator:=",
      "boolean:null",
      "punctuation:)",
    ],
  ]);
});

test("in source a keyword before a colon stays a keyword", () => {
  expect(tokenizeLines(["default: return"], "go").map(shown)).toEqual([
    ["keyword:default", "operator::", "keyword:return"],
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
