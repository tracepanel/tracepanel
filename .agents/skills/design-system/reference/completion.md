# Complete the selected work

Called when the selected scope is ready or only blocked work remains. The caller
supplies its scope, settled decisions, completion criteria, existing progress and
check results. Perform one final reconciliation before any requested independent
review, then clean up completed work. Return coverage and retained limitations.

When verification is skipped, omit reconciliation and rechecks. Update documents,
links and progress during the work and cleanup itself, following the
[shared verification rule](model.md#skipped-and-unavailable-verification).

## Reconcile final results

Check ready changes as work proceeds and reuse their actual results here. Compare
the requested outcomes and completion criteria with the resulting files and evidence
once, including every planned task and step when a plan exists. Checked boxes alone
are not evidence. Run only missing enabled checks or those invalidated by later
changes; reaching the end of a batch or migration does not invalidate earlier results.

Cover changed public promises, documents and affected dependencies, including
promises governed by a changed shared rule and incoming references or transferred
content from deleted documents. Check source paths, links, configured commands,
responsibilities and authoritative rules against actual project state. Resolve links
from their containing files and operational paths from the repository root.
Use instructions throughout the work; reread relevant parts of DESIGN.md, AGENTS.md
or CLAUDE.md when the result may conflict with them, rather than rereading unchanged
instruction files in full at completion.

Reuse contract audits and implementation/consumer evidence for the promises they
still cover. Correct actionable in-scope mismatches, reopen incorrectly completed
steps and finish omitted work. After corrections, check only affected promises,
content and dependencies. Report unreadable files, actual failures and unresolved
normative decisions without claiming those parts complete; continue independent work.
Apply the shared verification rule to skipped or unavailable checks.

Complete when the selected scope meets the caller's completion conditions; otherwise
report the partial result and keep unfinished work and blockers in existing progress.
Keep any plan and evidence needed for this reconciliation until it has finished.
Independent assessment remains a separate tool, enabled only by an explicit request
or project policy under the saved verification choice.

## Clean up completed work

After the caller's entire selected scope meets its completion rules, including
enabled final reconciliation and required checks, automatically clean up
before its final report. Preserve materials needed by independent unfinished work.
A batch boundary, pause, blocker or pending required check is not completion: retain progress and execution materials
needed to resume. Skipped or unavailable checks alone do not prevent cleanup.

Inspect artifacts and their references by continuing purpose, not filename or age.
Remove completed plans and progress, one-off migration scripts, temporary copies,
scratch outputs, logs and reviewer responses used only to execute this work. Include
older documents and scripts fully superseded within the authorised scope.
Keep contracts, indexes, active instructions, working tests, examples and
meaningful source references, decisions and limitations. Preserve pre-existing user
materials outside the calling scope; a filename containing evidence is not a deletion rule. Cleanup does not authorise unrelated skill or workflow
replacement.

Before deleting a file or section, transfer its still-useful rules, decisions,
recommendations and known defects to the appropriate permanent
documents: DESIGN.md, contracts, authoritative rules or the existing gap journal.
Repair incoming links, imports and command
references to the retained content. Keep unresolved defects explicit;
cleanup does not establish that a defect was repaired.

Treat `design-system/adoption.md` as execution state. Once its completed plan and
assessment have served final checks, remove them under this rule. Preserve independent
unfinished migration or API analysis with its inputs, findings, decisions and next
action; completing one step does not start or discard the other. Delete the file and
its DESIGN.md link only when no continuing work remains and lasting results have been
transferred. Preserve decisions needed by any authorised handoff at the destination
specified by the caller before removing their execution file.
Keep only the continuation state needed to resume unfinished work; no execution
history archive is required.

When verification is enabled, check only the consequences of cleanup: transferred
content and affected links, imports and command references. Rerun other enabled
checks only if these changes invalidated their results, respecting the saved
verification choice; cleanup does not restart final reconciliation. Complete when
disposable artifacts are removed, lasting information remains reachable and
continuation state is intact. Retain artifacts whose purpose cannot be
established and report that unresolved cleanup alongside removed and retained paths.
