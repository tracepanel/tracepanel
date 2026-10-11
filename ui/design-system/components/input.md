---
sourcesHash: 45fd3f82d56f44e5a1f39074a54bc7049cd6e6a278b235f4cf0beb6cc036e07d
id: input
description: >-
  Collect one line of text the user types, for a form field, a filter box or an
  inline edit. One input owns one value; composition, validation and the label
  stay with the consumer.
status: discoverable
sources:
  - packages/ui/src/components/ui/input.tsx
---

# Input

## When to use

- The user types or edits one value as free text (names, queries, numbers as text).
- The input participates in a form (labels, validation) or stands alone as a filter.

## When not to use

- The user picks from a known set. Use [Dropdown menu](dropdown-menu.md) or a select.
- The user composes a query with structured parts (chips, filters). Use the app's search composition; Input is the text core inside it.
- The value is multi-line. Use a textarea; Input stays one line.

## Public API

```tsx
<Input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter traces" />
```

- Full native `input` surface: `type`, `value`, `defaultValue`, `onChange`,
  `disabled`, `readOnly`, `min`/`max`, `pattern`, `name`, `required`.
- The consumer owns the value (controlled or not) and the label (`label`
  element, `aria-label` or `aria-labelledby`); the placeholder is a hint, never
  the label.
- Validation feedback is visual via `aria-invalid` (ring and border in
  `destructive`); the error text and `aria-describedby` stay with the consumer.

## Behaviour and states

- Fixed height (36px), full width, one line; `min-w-0` allows shrinking inside flex rows.
- Focus-visible shows the ring; `aria-invalid` restyles border and ring.
- `type=file` renders the styled file button; `type=number` keeps native spinners.

## Accessibility

- Native input semantics; no role invention.
- The consumer supplies the label and error descriptions; the component owns none.
