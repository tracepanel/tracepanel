# Tracepanel UI open gaps

Keep unresolved system gaps here. Move closed entries in full to the archive named
in DESIGN.md with their disposition, closure date and basis. Resolution requires
demonstrating the original Expected result.

## Open gaps

### The widget cannot consume the design tokens

- **Source:** `packages/widget/src/index.ts` (the page widget)
- **Need:** The widget's badge and panel should follow the same palette as the console and the panel, in its Shadow DOM root.
- **Actual result:** The widget carries a second, hardcoded copy of the palette inside its TypeScript template, so a token change in styles.css leaves the widget behind.
- **Expected result:** One token change updates the console, the panel and the widget; no palette literal lives outside styles.css (and its generated distribution for Shadow DOM).
- **Evidence:** Hardcoded hex values in `packages/widget/src/index.ts` that duplicate `--dt-*` values from `packages/ui/src/styles.css`.
- **Next step:** Hand off to craft: generate the widget's palette from the token file at build time (or distribute a Shadow DOM-compatible token sheet), then delete the second copy.
- **Decision needed:** None; the mechanism choice (build-time generation versus a distributed token sheet) belongs to the craft workflow.

### No compact Badge variant for dense rows

- **Source:** Network inspector rows and similar dense lists (legacy `.dt-chip` users)
- **Need:** Annotate rows that are shorter than the Badge's natural height with a status chip that does not stretch the row.
- **Actual result:** Badge has no size or compact variant; dense surfaces keep the legacy `.dt-chip` class from the legacy stylesheet instead of the system component.
- **Expected result:** A documented Badge variant (or size) that fits dense rows, and the legacy `.dt-chip` call sites migrating to it.
- **Evidence:** `badge.tsx` has only a `variant` axis; the legacy `.dt-chip` definition and its call sites live in the legacy layer of `packages/ui/src/styles.css`.
- **Next step:** Hand off to craft: define the compact variant's contract and intended use, then migrate call sites.
- **Decision needed:** Whether the compact size belongs to Badge or to a separate dense-chip contract.
