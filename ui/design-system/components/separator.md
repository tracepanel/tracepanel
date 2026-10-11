---
sourcesHash: b3503fc007fed6b627e9db108a8b4a9c22ed41df9bb936058f5f9d070e93e30b
id: separator
description: >-
  Mark the boundary between two groups of content with a hairline, horizontal
  or vertical, inside one composition. A Separator divides; it never carries
  content and never collapses sections.
status: discoverable
sources:
  - packages/ui/src/components/ui/separator.tsx
---

# Separator

## When to use

- Two groups of content need a visual boundary that spacing alone does not give (a toolbar from a list, actions from a body).
- The divider is purely visual: `decorative` (default), no semantic split.

## When not to use

- The split carries meaning for assistive technology (a real region change). Give the region its own semantics; a separator adds no structure beyond `role="separator"` when made non-decorative.
- Space alone is enough. Prefer spacing over hairlines; this system keeps structure from borders, not from shadows or repeated dividers.

## Public API

```tsx
<Separator />
<Separator orientation="vertical" className="h-4" />
```

- `orientation` defaults to `horizontal` (1px tall, full width); `vertical`
  needs the consumer to give it height (the element is `h-full w-px` inside a
  sized row).
- `decorative` defaults to `true` (hidden from the accessibility tree). Set
  `false` only when the boundary itself is meaningful to navigation; the Radix
  root then exposes `role="separator"`.
- `className` adjusts color or length; the hairline stays 1px.

## Behaviour and states

- Static. No interaction, no focus (decorative), no state.

## Accessibility

- Decorative by default (no role). Non-decorative renders `role="separator"` with orientation.
