// A GraphQL request's name from the body it sends: the widget's rule, which the agent shares, over its cases.
import { readFileSync } from "node:fs";
import { graphqlName } from "../../packages/ui/src/lib/graphql.ts";
import { expect, test } from "../fixtures.ts";

interface Case {
  body: string;
  name: string | null;
}

const CASES: Case[] = JSON.parse(readFileSync(new URL("../../../schema/graphql-names.json", import.meta.url), "utf8"));

test("the shared cases: a named operation's body names its request, any other none", () => {
  const names = CASES.map(({ body }) => ({ body, name: graphqlName(body) ?? null }));

  expect(names).toEqual(CASES);
});
