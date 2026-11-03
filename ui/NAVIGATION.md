# Navigation

How moving between traces and pages works in the console and in the panel.
Every change to links, tabs or Back keeps to these rules, and
`e2e/tests/navigation.spec.ts` checks them.

## 1. Back returns to exactly where you were

Back puts the view back as you left it: the same trace, the same tab, the
same row selected in the call tree, the same rows folded or opened, the same
part of the time picked (kinds of calls, a stretch, the Logs chip), the same
Profile choices (Time or Memory, Your code or All frames, the stretch it was
opened at) and the same scroll. Opening a linked trace keeps the whole view;
Back or Esc returns to it. A chain of linked traces (A, then B, then C) goes
back one step at a time.

What a view remembers lives in one place, `ViewMemory` (`useRemembered` in
`packages/ui/src/lib/viewMemory.tsx`): a part of the view that should come
back keeps its state there, under its own key.

## 2. A linked trace opens where the click promises

- A row of the call tree ("Open the task's trace", "Open the trace it served",
  a related trace, a workflow step) opens the linked trace on its **call
  tree**, its root row selected.
- A flame, "Open its profile", or a code row of a call's trace opens that
  trace's **Profile**, at the stretch the code row stands for. A code row says
  so in its tooltip.
- An app's row in the panel's list (that app's part of a row's chain, such
  as "FA text-campaigns" over its requests) opens the row's trace on its
  **call tree**, the call where that app's part starts selected (the rows on
  the way opened), its other tabs under that app. Never the tab last picked:
  the row means that app's part, not a trace to read.
- A call of a view or an action in the panel's list (a GraphQL operation through a
  gateway) opens the trace that answered it, on its call tree; while that trace is
  on its way, or when none answers it ("not traced"), the view's call tree, which
  has the call.
- A link that names a tab opens it: an issue's latest occurrence opens its
  Issues or Error tab, a log record its Logs tab or its row in the call tree,
  an email or an AWS call its row in the call tree, the latest call of a
  query its row in the call tree.

## 3. A trace opened fresh opens on one rule

A trace opened fresh (from a list, a search, the panel's list, Follow new)
opens, in the panel and in the console alike, on:
1. the tab its link names, if any;
2. else Error, when it failed;
3. else the tab you last picked in a trace's tab bar, when it has it;
4. else its call tree.

The last tab picked is kept in this browser and shared by the panel and the
console. Profile and App are never kept: they say little about most traces,
so picking them doesn't carry over to the next trace. Back is not a fresh
open: it returns to the tab you left (rule 1).

A row of the panel's list says it in its tooltip when it opens on the tab
last picked, as in "Opens on DB, the tab you used last (the call tree where
it has none)". It says nothing while that tab is the call tree.

## 4. The console: the address is the view

The trace page's address holds its tab, its row (`span`), the part of its
time picked (`part`, `range`, `logs`), its app (`under`) and its Profile
choices (`profile`, `frames`, `at`): a reload or a shared link opens the same
view. The rows folded stay with the history entry (too long for an address).

A trace opened from another one keeps that trace's whole address as its way
back (`from`). The crumbs show the real path: the list it started at, then
each trace on the way. Esc and "Back to" go where the browser's Back goes:
when the entry before is that page, they go Back (so Forward still works),
else they open its address.

## 5. The panel: its own history

The panel lives in the app's page; its iframe's address never reaches the
page's history. A linked trace opened in the panel pushes the view on screen
onto a stack of its own (kept for the browser tab's session), and Back or Esc
pops it as in rule 1. The Back button names where it goes, such as
"← Call tree · GET /shelf"; docked right, it shows the arrow alone and says
the same in its tooltip and accessible name. Opening a trace another way (the
list, Follow new) drops the stack. Esc with nothing to go back to closes the
panel. There is no Forward.

## 6. Other links

Links to pages of the console (an issue, a group, a service, the logs around
a trace, Explore) open those pages; from the panel they open the console in a
new tab. The browser's Back returns from them in the console.

Each list row has one accessible name: its method and whole path (or its
kind and name), its status, its time, its findings, as in
"GET /api/openapi.json, 200, 12 ms".
