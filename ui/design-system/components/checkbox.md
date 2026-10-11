---
sourcesHash: 64143c5457b1b7a9c7ad29ffeaa15b5423bf951bda7344e423afe49b615bd56b
id: checkbox
description: >-
  Let the user set one boolean state that belongs to a form or to a row
  selection, with an explicit checked, unchecked and (when used) indeterminate
  state. The state changes on click and stays until the next click.
status: discoverable
sources:
  - packages/ui/src/components/ui/checkbox.tsx
---

# Checkbox

## When to use

- The value is boolean or three-state (with `checked="indeterminate"`), set explicitly by the user.
- The state belongs to a form submission, or to a row selection in a [Table](table.md).

## When not to use

- The setting toggles immediately on flip without a form. The system has no Switch contract yet: log the gap in [gaps.md](../gaps.md) and use a [Button](button.md) whose label states the toggle meanwhile.
- The choice is one among several. Use radio semantics or [Dropdown menu](dropdown-menu.md).
- Activation runs a command. Use [Button](button.md).

## Public API

```tsx
<Checkbox checked={enabled} onCheckedChange={setEnabled} aria-label="Pin the trace" />
```

- Forwards the Radix Checkbox Root API: `checked`/`defaultChecked`,
  `onCheckedChange`, `required`, `disabled`, `name`/`value` (form submission as
  hidden input), `indeterminate` via `checked="indeterminate"`.
- The component renders no label. The consumer supplies one via `aria-label`,
  or places the checkbox in a `label` element next to text.

## Behaviour and states

- Click (and Space on focus) flips the state; check mark renders from `lucide-react`.
- Disabled keeps position but drops activation; `aria-invalid` ring applies for form errors.
- Rows in tables use the checkbox as the selection anchor; the row's own click behavior remains the consumer's.

## Accessibility

- Radix supplies `role="checkbox"` and state semantics on a button element.
- The consumer owns the label relationship: `aria-label` or a wrapping `label`; the check color must not be the only carrier of state.
