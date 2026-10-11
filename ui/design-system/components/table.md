---
sourcesHash: 91d69fb48704537ede546bf5f565609bf0f9839c5a4b5b5a644e7c51e727e37e
id: table
description: >-
  Present tabular data with native table semantics: header, body, optional
  footer and caption, row hover and selection states. The Table renders what
  the consumer hands it; sorting, selection and virtualization stay with the
  caller.
status: discoverable
sources:
  - packages/ui/src/components/ui/table.tsx
---

# Table

## When to use

- The data is genuinely tabular: rows of records, columns of attributes, headers that name the columns.
- Row selection, expansion or hover feedback complements a list the consumer controls.

## When not to use

- The content is a definition pair or a property sheet. Use a plain list or description list; a table without columns is layout noise.
- The rows are interactive cards. Use the list components; a Table's semantics say "data grid reading", not "clickable cards".

## Public API

```tsx
<Table>
  <TableHeader>
    <TableRow><TableHead>Method</TableHead><TableHead>Status</TableHead></TableRow>
  </TableHeader>
  <TableBody>
    <TableRow data-state={selected ? "selected" : undefined}>
      <TableCell>GET</TableCell><TableCell>200</TableCell>
    </TableRow>
  </TableBody>
</Table>
```

- All parts compose: `Table`, `TableHeader`, `TableBody`, `TableFooter`,
  `TableRow`, `TableHead`, `TableCell`, `TableCaption`. The root wraps the
  table in an overflow-x container; wide tables scroll, they do not shrink.
- Row states: `data-state="selected"` and `aria-expanded` restyle the row;
  the consumer sets them. Cells keep one line (`whitespace-nowrap`); long
  values truncate at the cell level by the consumer.
- `className` on parts adjusts alignment and width; column widths come from
  the consumer's markup, not from the system.

## Behaviour and states

- Static layout; hover/selected/expanded styles are the only owned states.
- The header row's bottom border and the last body row's border removal are component-owned.

## Accessibility

- Native `table`/`thead`/`tbody`/`tr`/`th`/`td` semantics.
- The consumer supplies `scope` on header cells when the table is complex, and
  keeps selection state perceivable (`aria-selected` or visible text), since
  `data-state` styling alone is not an announcement.
