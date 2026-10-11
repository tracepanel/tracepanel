---
sourcesHash: 3a4b3578b7272dc0de2b2bf07a3d3edc300eb7adf6b6bb445daa335357568505
id: popover
description: >-
  Show anchored, non-blocking content next to a trigger until the user dismisses
  it: filters, pickers, detail summaries. The page stays usable; the popover
  floats above it and closes on outside interaction.
status: discoverable
sources:
  - packages/ui/src/components/ui/popover.tsx
---

# Popover

## When to use

- Content belongs to a trigger's context but must not push the page (filter forms, pickers, a detail preview).
- Dismissal is cheap: outside click, Escape or trigger re-click; the popover is not a decision gate.

## When not to use

- The user must decide before continuing. Use [Dialog](dialog.md); a popover closes too easily to hold a decision.
- The content is one hint on hover. Use [Tooltip](tooltip.md); a popover is interactive and click-anchored.
- A command palette or search list. Use [Command](command.md) inside a Dialog; popover content is not a text-entry surface by contract.

## Public API

```tsx
<Popover>
  <PopoverTrigger asChild><Button variant="outline">Filters</Button></PopoverTrigger>
  <PopoverContent align="start" className="w-80">
    <PopoverHeader><PopoverTitle>Filters</PopoverTitle></PopoverHeader>
    ...
  </PopoverContent>
</Popover>
```

- Radix Popover API; `PopoverContent` defaults `align="center"`,
  `sideOffset={4}`; width defaults to `w-72` and is adjusted per use via
  `className` (this is the sanctioned width override, not a style escape).
- `PopoverHeader`, `PopoverTitle`, `PopoverDescription` are optional slots.
- Controlled composition: `open`/`onOpenChange` for triggerless or
  programmatically closed popovers; `PopoverAnchor` positions against a
  non-trigger element.

## Behaviour and states

- Portals to body; collisions flip sides; entrance/exit animate.
- Closes on outside pointer down, Escape, and (default) trigger re-click. Focus returns to the trigger.

## Accessibility

- Radix wires trigger/content ids and the dialog pattern for the popover.
- The consumer keeps interactive content reachable: a popover with focusable content traps nothing, so keyboard users can reach it while open and Escape returns them.
