---
sourcesHash: f28e05b8c557414fed7e522cb10b5e1cf8f29534a113f6d61f1ed30d7f0a332c
id: button
description: >-
  Invoke one immediate action, submit one form or navigate to one destination
  through a native button or link. The variant carries the action's
  consequence: destructive for state-destroying actions, outline or secondary
  for lower-priority ones, ghost for toolbars and dense rows.
status: discoverable
sources:
  - packages/ui/src/components/ui/button.tsx
---

# Button

## When to use

- The element triggers exactly one action on activation: submit, open, close, copy, navigate.
- The label names that action or destination in the imperative ("Refresh", "Open trace").
- The action fires once per activation. Repeated or held activation is out of scope.

## When not to use

- The element annotates another item with status or metadata. Use [Badge](badge.md); a Badge is not a target of the action, a Button is.
- The element switches between views of one context. Use [Tabs](tabs.md).
- The element selects one boolean state in a form. Use [Checkbox](checkbox.md).
- A menu of several actions is needed. Use [Dropdown menu](dropdown-menu.md); a Button opens it, it does not contain it.

## Public API

```tsx
<Button variant="outline" size="sm" onClick={openTrace}>Open trace</Button>
```

- `variant` defaults to `default` (filled primary). Choose `destructive` when
  the action destroys or overwrites stored state; the accessible name must
  still name the action ("Delete group", never "Delete"). Choose `outline` or
  `secondary` when the action is real but must not dominate the view. Choose
  `ghost` for toolbar and row affordances where the button sits beside content.
  Choose `link` when the element looks like a link but runs client code.
- `size` defaults to `default` (36px tall). Use `sm` or `xs` in dense rows and
  toolbars when the surrounding row height demands it; use `lg` only for
  empty-state or page-level calls to action. `icon*` sizes exist for a single
  icon without a label; an icon-only button must carry `aria-label` naming the
  action.
- `asChild` renders the child element (typically an `a`) with the button's
  classes and behavior, per the Radix Slot contract. The child then owns the
  navigation semantics; the consumer keeps the href.
- All other props forward to the native `button` (or the slotted child):
  `disabled`, `type`, `form`, data attributes. `className` merges last and is
  reserved for the documented escapes (see DESIGN.md); a different look for an
  existing variant is a craft request, not a `className` payload.

## Behaviour and states

- Disabled buttons keep their variant's fill at 50% opacity and drop pointer events.
- `aria-invalid` styling exists for form-submitting buttons in an invalid form.
- Focus shows the ring on `focus-visible` (keyboard focus), not on click.
- The element shrinks-0 and keeps one line; overflow is the consumer's layout problem, not a scroll affordance.

## Accessibility

- Renders `button` (or the slotted element) with native activation semantics.
- The consumer owns the accessible name; an icon-only call must add `aria-label`.
- `data-variant` and `data-size` are exposed for tests and the design system's own tooling.
