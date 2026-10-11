---
sourcesHash: ebc55dfbd73bb8316ec7e69af1bbebee7f52ecda8deb57bc4b323625c1f4509e
id: dropdown-menu
description: >-
  Offer a list of actions or settings behind one trigger, opened on click and
  closed on selection. A Dropdown menu holds actions; it is not a form surface
  and not a view switcher.
status: discoverable
sources:
  - packages/ui/src/components/ui/dropdown-menu.tsx
---

# Dropdown menu

## When to use

- Several related actions share one trigger and showing all of them as buttons would crowd the row (row actions, overflow menus, view options).
- Items are actions, checkbox/radio items or submenus; selection usually closes the menu.

## When not to use

- One or two actions: render [Button](button.md)s; a menu hides available actions for no gain.
- The content is a picker with text entry. Use [Popover](popover.md) with [Command](command.md) content.
- The click switches views in place. Use [Tabs](tabs.md).

## Public API

```tsx
<DropdownMenu>
  <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Row actions" /></DropdownMenuTrigger>
  <DropdownMenuContent align="start">
    <DropdownMenuLabel>Actions</DropdownMenuLabel>
    <DropdownMenuItem onSelect={open}>Open trace</DropdownMenuItem>
    <DropdownMenuSeparator />
    <DropdownMenuItem variant="destructive" onSelect={remove}>Remove</DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
```

- Radix DropdownMenu API: trigger, content, `Label`, `Item`, `Separator`,
  `Group`, `CheckboxItem`, `RadioGroup`/`RadioItem`, `Sub*`, `Shortcut`,
  `Portal`. The destructive item variant is component-owned.
- `DropdownMenuTrigger` is usually an icon [Button](button.md) with
  `aria-label`; the menu is opened by click, not hover.
- Content alignment and width (`align`, `sideOffset`, `className`) follow the popover conventions.

## Behaviour and states

- Open/close on trigger click, Escape, outside click; arrows navigate, Enter/Space select, typeahead jumps.
- Selection closes the menu unless the item says otherwise (`onSelect` + `event.preventDefault()` for checkable items that must stay open).

## Accessibility

- Radix supplies menu roles and keyboard interaction; `DropdownMenuTrigger` forwards the consumer's accessible name.
- Shortcut text is visual only: the consumer keeps real key handlers working, the rendered `<DropdownMenuShortcut>` never announces itself as the handler.
