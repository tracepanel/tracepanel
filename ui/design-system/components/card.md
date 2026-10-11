---
sourcesHash: 45632d6d8f10976dcd4616c9fdad4a4c0a8d714fc59566d47e600b3d4c6df291
id: card
description: >-
  Group related content into one bordered, raised surface with a header, an
  optional action corner, a body and a footer. A Card is a layout contract for
  a self-contained block, not a popover and not a page section divider.
status: discoverable
sources:
  - packages/ui/src/components/ui/card.tsx
---

# Card

## When to use

- The content forms one self-contained unit a reader can lift out of the page (a summary, a settings group, an empty state).
- The block needs a title plus optional description and one corner action slot.

## When not to use

- The content floats above the page on user intent. Use [Popover](popover.md).
- The surface only divides space; no title and no self-contained meaning. Use layout utilities or [Separator](separator.md).
- Rows of repeating tabular data. Use [Table](table.md).

## Public API

```tsx
<Card>
  <CardHeader>
    <CardTitle>Service: checkout-api</CardTitle>
    <CardDescription>Traces of the last hour</CardDescription>
    <CardAction><Button variant="ghost" size="icon-sm">...</Button></CardAction>
  </CardHeader>
  <CardContent>...</CardContent>
  <CardFooter>...</CardFooter>
</Card>
```

- Parts are composed, not props: `CardHeader`, `CardTitle`, `CardDescription`,
  `CardAction`, `CardContent`, `CardFooter`. `CardAction` occupies the header's
  second grid column automatically.
- The consumer owns heading order: `CardTitle` renders a `div`; wrap it in an
  `h2`/`h3` or place it inside one when the card's title belongs to the page's
  outline.
- Spacing between parts is component-owned (`gap-6`, `px-6`); a `className` on
  parts adjusts that locally under the documented escape convention.

## Behaviour and states

- Static container; no state of its own. Interactive content inside brings its own behavior.
- `bg-card`, one border, small shadow; nested cards are not a supported composition (flatten instead).

## Accessibility

- The container is presentational; content semantics stay with the consumer.
- A header structure with `CardAction` keeps the action off the title's reading line order in the grid, not in the DOM: the action renders after the title. Keep the action's accessible name self-sufficient.
