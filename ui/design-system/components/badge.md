---
sourcesHash: ec862c85fb49b30a11cc4bb8d5c9facde964f90c65371a28dfb5d3e6ecdf3cb5
id: badge
description: >-
  Annotate an item with a concise status, category or count while the reader
  scans a list or a header. Static display: a Badge never initiates an action
  and never holds a body longer than one line.
status: discoverable
sources:
  - packages/ui/src/components/ui/badge.tsx
---

# Badge

## When to use

- The label names a status, a category or a count of one identifiable item, and it fits one line at the badge size.
- The reader scans several items and the label helps sort them by eye (method chips, service names, counts).

## When not to use

- The element is a target of a user action. Use [Button](button.md); a Badge annotates, it does not act.
- The label is an instruction or a message with a body. Write prose or use [Tooltip](tooltip.md) for a hint on hover.
- The value is a request or response payload detail that deserves a full line. Use text.

## Public API

```tsx
<Badge variant="outline">GET</Badge>
```

- `variant` defaults to `default` (filled primary). Use `secondary` for neutral
  metadata, `destructive` for error states, `outline` for chips that sit on
  tinted surfaces, `ghost`/`link` only where an anchor wraps the badge.
- `asChild` renders a child (typically an `a`) with the badge classes when the
  annotation itself navigates (a linked count). The child owns semantics.
- Other props forward to `span`. `className` merges last; reserved for
  documented escapes, not new looks.

## Behaviour and states

- One line, `whitespace-nowrap`, `rounded-full`; long values overflow clipped rather than wrapping.
- Focus ring styling exists for the wrapped-anchor case; a plain span is not focusable.
- A live-updating count is the consumer's responsibility (announcements, not the badge's own).

## Accessibility

- Renders a `span` (or slotted child): no role, no semantics of its own.
- The consumer supplies the meaning the color implies in the text itself; color alone never carries a status (WCAG 1.4.1). Pair a colored dot or tint with a text label.
