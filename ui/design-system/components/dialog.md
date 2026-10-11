---
sourcesHash: 1aaf89893bc285fbb6bda8fc6693a0937d31628218dc0101fde62f0cadd94924
id: dialog
description: >-
  Hold the user's attention on one task that must finish or be cancelled
  explicitly before the page continues: confirmations, detail inspection,
  forms. A Dialog blocks the page behind an overlay until it closes.
status: discoverable
sources:
  - packages/ui/src/components/ui/dialog.tsx
---

# Dialog

## When to use

- The task is a decision gate: confirm a destructive action, complete a form, read details that must be seen before continuing.
- The content needs the full modal treatment: overlay, focus capture, explicit close.

## When not to use

- Dismissal must be cheap and side content should stay visible. Use [Popover](popover.md).
- The content is a hint. Use [Tooltip](tooltip.md).
- The flow is a command palette with search. Use [Command](command.md) (it composes a Dialog internally).

## Public API

```tsx
<Dialog>
  <DialogTrigger asChild><Button variant="destructive">Clear</Button></DialogTrigger>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Clear stored traces?</DialogTitle>
      <DialogDescription>This removes every stored span for this service.</DialogDescription>
    </DialogHeader>
    <DialogFooter>
      <Button variant="outline" onClick={close}>Cancel</Button>
      <Button variant="destructive" onClick={clear}>Clear</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

- Radix Dialog API. `DialogContent` owns the overlay, the close button
  (`showCloseButton`, default on) and the portal; the consumer composes header,
  title, description and footer.
- The destructive-action order is component policy: confirming action right,
  cancel left, confirming button carries `variant="destructive"`. The
  consumer supplies labels and callbacks; the composition rule is the system's.
- `DialogTitle` is required by Radix (accessible name); `DialogDescription`
  gives `aria-describedby`. Close is wired to Escape and the overlay click
  unless `onInteractOutside`/`onEscapeKeyDown` say otherwise.

## Behaviour and states

- Overlay fades; content animates in/out; focus moves in and returns to the trigger on close.
- Background content is inert while open (focus capture); scroll lock is Radix-owned.

## Accessibility

- `role="dialog"`, `aria-modal`, labelled by the title, described by the description.
- The consumer keeps the description honest about consequences ("what this will delete") and never relies on color alone for the destructive meaning.
