# Record a design-system gap

Read [the shared model](model.md) and
DESIGN.md for the journal and archive; the defaults are `design-system/gaps.md` and
`design-system/gaps-archive.md`. Apply
[missing-context handling](model.md#missing-project-context) rather than guessing paths.
When recording or resolving a choice gap, read the applicable
[basis rule](formats.md#check-the-basis-for-choices); recording does not establish a standard.

Record systemic missing capabilities, misleading rules, contract drift or a design
reference that conflicts with required rules. This includes token roles and definitions.
Missing request facts and product-specific choices within permitted freedom are not
gaps. A persistent missing verification capability is a tooling gap; a transient
outage is a verification limit.

## Record exceptions

Record every escape-hatch use and design-lint suppression in the journal, including
authorised product-specific exceptions. Capture the source location, end-user need,
actual and expected result, affected rule, reason and evidence, and any required
approval. Link each use to its entry using the project's annotation convention.
Reuse an entry for a shared cause and retain every use location. Ordinary
product-specific fallback within permitted freedom alone needs no entry.
Recording an exception or suppressing a warning does not grant authorisation or
establish a reusable design-system rule. Follow the recording and review procedures
below; an explanation alone does not resolve the underlying limitation.

## Record and resolve

Reuse a matching open entry or add one per independent cause. Preserve the request,
actual result, original Expected result and reproducible evidence: source paths,
deciding clauses, failed checks or measurements. State what must become possible,
including discoverability when needed. Categories are optional. A matching description
sentence alone does not demonstrate resolution.

State the next actionable step and any required decision or missing evidence.
Use A/B/C labels only for a concrete automation need; they do not establish priority,
cost or repair authority. Existing labels need no bulk migration.

Record without asking. After saving, report each added or supplemented gap to the
user with its exact journal heading and a clickable `path:line` link. Use the
heading's 1-based line number verified in the saved journal after all edits. For
multiple gaps, use one list item per entry.

Recording neither blocks product work nor authorises repairs. Hand system work to
the separate [craft workflow](craft.md),
which requires authorised design-system scope. Internal component and business-logic
repairs belong to project development; retain their contract drift until the original
expectation is demonstrated. Craft archives an in-scope entry as Resolved
only after proving its original expectation, including admission when required.

For reviewing existing entries, merging duplicates, dismissing erroneous records
or recognising already-resolved gaps, follow [triage](triage.md). Journal cleanup
does not repair the system or authorise a rule change.

## Archive an entry

Every entry leaving the open journal moves in full to the archive named in DESIGN.md.
Preserve its source, original expectation, evidence and original date when present.
Set Status and add Closed date (`YYYY-MM-DD`) with the disposition's basis:

| Status | Required basis |
| --- | --- |
| Resolved | Resolution and Verified by: what changed or already fulfils the expectation, with reproducible verification evidence. |
| Dismissed | Reason: evidence that the record is not a system gap; dismissal does not mean a repair. |
| Merged | Merged into: a link to the retained entry, and the shared cause justifying the merge. |

For a merge, preserve all sources and expectations in the retained open entry before
archiving the duplicate's original record. Keep entry and evidence links valid when
moving records. Preserve existing archive entries; create a missing archive with a
title when first needed. Remove the open entry only after its archive record is saved,
then report the disposition and evidence. Retain uncertain entries in the open journal.

Keep the archive after adding entries. Follow [archive maintenance](archive-cleanup.md)
for searching its history or an explicitly requested cleanup.
