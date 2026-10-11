# Set up the project

Run for an explicit project connection request, including repeat connection or
continuation. Read [the shared model](model.md). Inspect the current artifacts and
reuse established decisions; complete missing connection work and restore artifacts
that follow unambiguously from authoritative sources. Prior completion is not a
reason to stop. Preserve correct artifacts without duplicate pointers or a new
completion marker. Honour an explicit request to leave an existing connection unchanged.
An explicit migration request for an already connected project goes directly to
[migrate](migrate.md).

For substantial independent connection work, follow [delegation](delegation.md)
when subagents are available and permitted.

Use plain language in the user's language. Introduce a contract as documented rules
for using a component. Explain decisions by their practical effects; internal stages
and batches are the agent's responsibility.

## Survey the existing sources

Read applicable root and nested project instructions, DESIGN.md or a legacy profile,
existing contracts, UI libraries, tokens, themes, public usage and verification
commands. Inspect representative consumers and find pages from code when useful;
a user-selected page is not required. Preserve project workflows and link their
rules at authoritative locations under the
[shared responsibility boundary](model.md#authority-and-task-scope).
Report conflicting sources and unknown design decisions; continue independent work
and ask only about unresolved decisions that block dependent actions.

Ordinary connection does not determine an agent mode, consolidate instruction files,
create or normalise symlinks, or audit other skills for compatibility. Instruction
reorganisation and compatibility audits require separate requests. Read instructions
that actually govern the affected work without expanding into a repository-wide
skill audit. Keep installed skills at their actual local or global locations.

Complete when the existing sources, contracts, applicable rules and missing context
are known. Surveying undocumented UI does not authorise its migration.

## Connect the project

Use [the DESIGN.md template](../assets/DESIGN.md) to create or complete root DESIGN.md.
Preserve existing design content and link authoritative sources. Record actual paths,
commands and missing tools; source conflicts remain explicit. Existing profiles may
supply facts, but DESIGN.md becomes the framework's entry point.

Moving existing contracts is part of connection and requires no full-migration choice.
Move existing component/layout/pattern contracts into their respective group directories;
move the entire Purpose into frontmatter `description`, remove the Purpose section, and
add [frontmatter](formats.md#contract-frontmatter) from evidenced identity, lifecycle
and actual source files. Preserve valid public promises and eligibility during moves.
Store each pattern as a separate contract using [the pattern template](../assets/patterns.md).
Update incoming links, index links, document-relative references and examples that
resolve relative imports from the moved document. Keep root-relative code paths intact.
IDs remain unique across components, layouts and patterns; report collisions before
choosing a new identity. Empty groups are valid. Complete these moves when the standard
locations and metadata are updated and affected links repaired; validate them
after the verification decision below.
For documents mixing contracts and process instructions, apply the
[contract structure](model.md#designmd-and-indexes): always move the contract
content into `design-system/` and leave only the non-contract information and
instructions at the old path. Preserve their invocation and references; route each
incoming link to the content it needs. Mixed content is not a reason to defer the
contract move. Unresolved rules remain explicit rather than silently discarded.
Link an existing token catalogue or directly usable definitions without duplicating
it. Record absent token sources explicitly rather than inventing definitions.

Generate COMPONENTS.md, LAYOUTS.md and PATTERNS.md from the resulting contracts using
[the index command](../assets/inventory.md). Index generation is connection work;
validation follows the verification decision below.

Place the main DESIGN.md and installed `design-system` pointer in root AGENTS.md;
create a minimal AGENTS.md if absent. Preserve existing CLAUDE.md content and add a
short pointer there only when needed to make the routing reachable. Keep existing
symlinks and edit their shared source once. Leave external or unreadable targets
unchanged and report the specific limitation. Respect nested instructions in the
affected scope; update only pointers or references affected by this connection.
Keep the project workflow as the entrypoint, with design-system responsible for
contract/system work and selection and reuse; preserve the caller's other stages.

For a new empty project, DESIGN.md, instruction pointers, empty indexes and links to
available sources suffice. Use the existing brief or selected library; leave unknown
design decisions for real tasks instead of creating a starter component set.
Reuse existing gap journals and archives. Create them when there are entries to
record under [gap handling](gaps.md); omit template links to nonexistent journals.
A request to connect and build the first screen authorises both stages: complete
connection, then continue the requested [craft](craft.md) and [use](use.md) work.

Complete preparation when DESIGN.md reaches the sources, indexes and available
verification instructions, existing contracts and affected references are updated,
and missing capabilities are explicit. Operational paths resolve from the project
root; Markdown links resolve from their containing files.

## Choose migration and verification

After preparing the connection, show the remaining undocumented reusable components,
layouts and patterns and the scope that full migration would cover. For an existing
project with remaining work, offer one explicit decision: complete automatic
contracts-only migration (recommended), or finish with the connection. Explain that
migration creates missing contracts and updates indexes while preserving code and
appearance, covering the whole project unless the user limits the area.
Start migration only after explicit confirmation. Reuse already supplied authority;
a request to connect and document all reusable UI already authorises that work.

In that same round, explain applicable connection and migration checks and unavailable
capabilities, and offer to run or skip verification, recommending run. For an empty
project or a scope with no remaining migration, ask only about verification.
Reuse an explicit or saved choice when it applies to this operation. Wait for a
missing choice before checks; preparing documents and indexes may proceed.
Save the choice in DESIGN.md for this operation and the selected migration handoff,
not unrelated later work. A refusal skips validators, audits, tests, builds, browser
checks, demonstrations, independent review and final reconciliation. Follow the
[shared verification rule](model.md#skipped-and-unavailable-verification).
Declining migration does not decline connection verification.

The migration decision does not block connection completion. Without confirmation,
report the uncovered UI and finish connection under the selected verification choice.
Do not replace this decision with a menu of procedures or a batch-size question.

## Report the connection and continue

When verification is enabled, perform one
[final reconciliation](completion.md#reconcile-final-results) of changed documents,
contract moves, affected links and instruction pointers, reusing current evidence.
Connection without changed contract boundaries needs no contract discovery gate.
Use [independent review](delegation.md#review-the-final-result) only when explicitly
requested or required by project policy and verification is enabled.
Apply [completion cleanup](completion.md#clean-up-completed-work) even when checks
are skipped; preserve decisions and materials needed by selected or unfinished work.
Report connection complete only when its own required work is complete. Report
DESIGN.md, linked sources, changed artifacts, remaining uncovered UI and unresolved
decisions. Report actual check results in the response without a separate evidence
archive. Migration interruption does not invalidate a completed connection.

After migration confirmation, hand off to [migrate](migrate.md) with **mode 3 —
contracts only**, the whole project or explicitly limited area, the verification
choice and current survey. These are settled inputs: no repeated mode, scope or
verification question. The common migration procedure creates missing contracts,
updates indexes, saves progress and continues all batches without repeated approval.
Ask about unresolved normative decisions while continuing independent work; infer
no unknown rules. Standalone migration retains its existing mode choices.

For an analogous-page demonstration explicitly requested by the task or required by
project policy, use the procedure below subject to the verification choice.
Its absence does not make ordinary connection incomplete.

## Optional setup demonstration

When an analogous-page demonstration is requested, use an existing page found during
setup or named by the task. Give a fresh worker an analogous request, root DESIGN.md
and public sources in an isolated copy. Run build with actual discovery, then verify
the resulting page and a deliberate composition violation. Report the demonstration
result, commands run and browser-check outcomes in the response. Report its limits separately from
the completed connection; this does not authorise admission of unadmitted entities.
