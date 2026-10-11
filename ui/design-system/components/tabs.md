---
sourcesHash: e976b142a72d333619b67438ccceb72b816de3823819b810ed1321ddcdeed10c
id: tabs
description: >-
  Switch between sibling views of one context when only one view is visible at
  a time. Tabs keep the context's identity stable while its content changes;
  they do not paginate and they do not navigate between screens.
status: discoverable
sources:
  - packages/ui/src/components/ui/tabs.tsx
---

# Tabs

## When to use

- One context owns several sibling presentations (list/board, request/details) and the user switches between them in place.
- The switch preserves the context (no route change, no data reload).

## When not to use

- The click navigates to another screen or route. Use navigation (routes), not Tabs.
- The sections stack and belong in one reading flow. Show them stacked; Tabs hide content by design.
- A row of actions opens panels. Use [Dropdown menu](dropdown-menu.md) or [Popover](popover.md).

## Public API

```tsx
<Tabs defaultValue="details">
  <TabsList variant="line">
    <TabsTrigger value="details">Details</TabsTrigger>
    <TabsTrigger value="payload">Payload</TabsTrigger>
  </TabsList>
  <TabsContent value="details">...</TabsContent>
  <TabsContent value="payload">...</TabsContent>
</Tabs>
```

- Radix Tabs API on all four parts. `orientation` defaults to `horizontal`.
- `TabsList variant`: `default` (segmented, tinted track) or `line` (text with
  an active underline). `line` suits dense panels; `default` suits standalone
  sections.
- One `TabsContent` per `value`; uncontrolled `defaultValue` or controlled
  `value`/`onValueChange`. Content mounts per Radix default (unmount when
  hidden); keep expensive state above the Tabs if hiding would lose it.

## Behaviour and states

- Arrow keys move between triggers when the list has focus; activation follows Radix's automatic pattern.
- Active trigger is styled by state (`data-[state=active]`), never by consumer classes.

## Accessibility

- Radix supplies `role="tablist"`, `role="tab"`, `aria-selected`, and focus management; consumers label the group when the screen holds several tab sets (`aria-label` on `Tabs`).
