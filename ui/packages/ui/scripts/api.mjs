// Generates src/api.gen.ts from the console's API contract, the repository's schema/openapi.yaml (with the
// trace.schema.json next to it), or TRACEPANEL_SCHEMA=/path/to/openapi.yaml.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import openapiTs, { astToString } from "openapi-typescript";

const here = dirname(fileURLToPath(import.meta.url));
const contract = resolve(process.env.TRACEPANEL_SCHEMA ?? resolve(here, "../../../../schema/openapi.yaml"));
const traceSchema = resolve(dirname(contract), "trace.schema.json");

let code = astToString(await openapiTs(pathToFileURL(contract)));

// openapi-typescript inlines trace.schema.json as components.schemas["trace.schema"] but points references to its
// $defs at components.schemas directly; send them to where the definitions actually are.
const defs = Object.keys(JSON.parse(readFileSync(traceSchema, "utf8")).$defs);
const pattern = new RegExp(`components\\["schemas"\\]\\["(${defs.join("|")})"\\]`, "g");
code = code.replace(pattern, 'components["schemas"]["trace.schema"]["$defs"]["$1"]');

writeFileSync(
  resolve(here, "../src/api.gen.ts"),
  `// Generated from schema/openapi.yaml by \`pnpm api\`. Do not edit.\n${code}`,
);
process.stdout.write(`api.gen.ts written from ${contract}\n`);
