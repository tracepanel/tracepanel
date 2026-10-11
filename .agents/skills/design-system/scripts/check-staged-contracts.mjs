#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { checkContractFile, frontmatter } from "./check-contract.mjs";

function checkStagedContracts() {
  const projectRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trimEnd();
  const git = (...args) => execFileSync("git", args, { cwd: projectRoot, encoding: "utf8" });

  // Treat renames as deletion + addition so both source paths select contracts.
  const changedPaths = new Set(
    git("diff", "--cached", "--name-only", "--no-renames", "-z").split("\0").filter(Boolean),
  );
  if (!changedPaths.size) return;

  // Local delta (documented in .agents/SOURCES.md): contracts may live in a
  // workspace subdirectory (ui/design-system/), so the design-system prefix
  // matches anywhere in the path instead of only at the repository root.
  const contractPaths = git("ls-files", "-z").split("\0")
    .filter((path) => /(?:^|\/)design-system\/(components|layouts|patterns)\/.+\.md$/.test(path));
  if (!contractPaths.length) return;

  const snapshot = mkdtempSync(join(tmpdir(), "design-contracts-"));
  try {
    git("checkout-index", "--all", `--prefix=${snapshot}${sep}`);
    for (const contractPath of contractPaths) {
      const stagedFile = join(snapshot, contractPath);
      const { metadata } = frontmatter(readFileSync(stagedFile, "utf8"));
      const sources = Array.isArray(metadata.sources) ? metadata.sources : [];
      const affected = changedPaths.has(contractPath) || sources.some((source) => changedPaths.has(source));
      if (!affected) continue;

      const kind = contractPath.match(/(?:^|\/)design-system\/([a-z]+)\//)[1].slice(0, -1);
      let problems;
      try {
        problems = checkContractFile(stagedFile, { kind });
      } catch (error) {
        problems = [error.message];
      }
      if (!problems.length) console.log(`ok  ${contractPath}`);
      else {
        process.exitCode = 1;
        console.log(`FAIL ${contractPath}`);
        for (const problem of problems) console.log(`  - ${problem}`);
      }
    }
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

try {
  checkStagedContracts();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
