// Which queries the console offers to explain: the agent's rule, which every SDK shares, over its cases.
import { readFileSync } from "node:fs";
import { explainRefusal } from "../../packages/ui/src/explainable.ts";
import { expect, test } from "../fixtures.ts";

interface Case {
  sql: string;
  explain: string | null;
  analyze: string | null;
}

const CASES: Case[] = JSON.parse(readFileSync(new URL("../../../schema/explainable.json", import.meta.url), "utf8"));

test("the shared cases: a SELECT or a WITH that only reads is explained, one that changes data says why", () => {
  const verdicts = CASES.map(({ sql }) => ({
    sql,
    explain: explainRefusal(sql, false),
    analyze: explainRefusal(sql, true),
  }));

  expect(verdicts).toEqual(CASES);
});
