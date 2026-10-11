---
sourcesHash: 7641ffb4563e45a9aa8e5b651108844d8685e530b7f3ba73ee8dd503804594b6
id: command
description: >-
  Let the user find and run one action from a searchable, keyboard-first list:
  command palettes, pickers over a known set, quick filters. Text input narrows
  the list; selection runs the action.
status: discoverable
sources:
  - packages/ui/src/components/ui/command.tsx
---

# Command

## When to use

- The set of options is known to the system and possibly longer than a menu; the user narrows it by typing and picks one.
- The surface is keyboard-first (palette, list pickers); mouse use must keep working.

## When not to use

- The options are few and stable. Use [Dropdown menu](dropdown-menu.md); a searchable list is overhead.
- The user types free text the system stores. Use [Input](input.md); Command is a picker, not an editor.
- The pick is one boolean. Use [Checkbox](checkbox.md).

## Public API

```tsx
<CommandDialog open={open} onOpenChange={setOpen}>
  <CommandInput placeholder="Search commands" />
  <CommandList>
    <CommandGroup heading="Traces">
      <CommandItem onSelect={openTrace}>Open trace</CommandItem>
    </CommandGroup>
    <CommandEmpty>No commands found.</CommandEmpty>
  </CommandList>
</CommandDialog>
```

- Composes `Command` primitives (`CommandInput`, `CommandList`,
  `CommandGroup`, `CommandItem`, `CommandEmpty`, `CommandSeparator`,
  `CommandShortcut`) over cmdk; `CommandDialog` wraps them in a
  [Dialog](dialog.md) with a screen-reader title/description the consumer can
  override.
- `onSelect` carries the action; `CommandShortcut` renders the key hint (visual
  only, see Accessibility).
- `CommandList` scrolls at a fixed max height; groups keep their headings.

## Behaviour and states

- Selected item highlight, arrow navigation, Enter selection, Escape close (via the dialog).
- `CommandEmpty` renders when the filtered list is empty; the consumer supplies its text.

## Accessibility

- cmdk supplies combobox/listbox roles and keyboard behavior; `CommandDialog` labels the dialog for screen readers.
- Key hints are decorative; the consumer binds real shortcuts and announces actions by name, not by key.
