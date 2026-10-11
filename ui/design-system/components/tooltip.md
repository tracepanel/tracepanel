---
sourcesHash: 6a895b6710856f07b95e51ddbc1eb82c6b28053806165340ca7b51c09c6eaf0a
id: tooltip
description: >-
  Name a control or show one short hint on hover or keyboard focus, without
  interaction of its own. A Tooltip says what the control is; it never carries
  actions or form content.
status: discoverable
sources:
  - packages/ui/src/components/ui/tooltip.tsx
---

# Tooltip

## When to use

- An icon-only control needs its accessible name shown on hover and focus (a [Button](button.md) with `icon` size, an [Input](input.md) affordance).
- One short sentence clarifies what the control does before the user commits.

## When not to use

- The content is interactive or long. Use [Popover](popover.md); a tooltip is read-only and disposable.
- The information is essential to complete the task. Put it in the page; a tooltip hides by design.
- Touch-only surfaces: tooltips have no hover; the content must survive without it.

## Public API

```tsx
<TooltipProvider>
  <Tooltip>
    <TooltipTrigger asChild><Button variant="ghost" size="icon-xs" aria-label="Copy">...</Button></TooltipTrigger>
    <TooltipContent>Copy the request ID</TooltipContent>
  </Tooltip>
</TooltipProvider>
```

- Wrap the tree once in `TooltipProvider` (`delayDuration` defaults to 0); mount it near the app root.
- `TooltipContent` shows an arrow by default (`arrow={false}` removes it); `sideOffset` defaults to 0.
- The trigger's accessible name is the consumer's job; the tooltip is a visual echo of it, not a replacement (contrast 1.4.13: dismissible, hoverable, persistent obligations are Radix-supplied).

## Behaviour and states

- Opens on hover and focus after the provider delay; closes on leave, Escape and blur.
- Portals to body; flips sides on collision; fades and zooms in.

## Accessibility

- Radix wires `aria-describedby` (hover/focus) and Escape dismissal.
- The trigger keeps its own accessible name; the tooltip content should not contradict it.
