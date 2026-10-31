import { Button } from "@tracepanel/ui/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@tracepanel/ui/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@tracepanel/ui/components/ui/popover";
import { cn } from "@tracepanel/ui/lib/utils";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

export interface FilterItem {
  value: string;
  label: string;
  selected: boolean;
  /** Tailwind background class for a colored dot before the label. */
  tone?: string | undefined;
  /** Shown instead of the label, e.g. the same level tag as in the table. */
  display?: ReactNode;
  /** A second pick on the row, shown at its end on hover: the Level menu's "and above". */
  action?: FilterAction | undefined;
}

export interface FilterAction {
  label: string;
  /** What it picks, said whole: "WARNING and above". */
  title: string;
  onClick: () => void;
}

export interface FilterMenuProps {
  /** Button text, e.g. "Status". */
  label: string;
  /** Menu heading, e.g. "Filter by status". */
  title: string;
  /** Shown on the button when something is picked: "5xx", "2 selected". */
  summary: string | null;
  items: readonly FilterItem[];
  /** Several values (checkboxes, menu stays open) or one (check mark, closes on pick). */
  multiple: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (value: string) => void;
  onClear: () => void;
  /** The search key the menu sets (logger): typed in its own box too (logger:org), it is left out of the match. */
  searchKey?: string | undefined;
}

const SEARCH_FROM = 7;
const NONE = "\u0000";

/** A filter's chip above a list (Time, Status, Route…), lit when it filters: one look for all of them. On the dark
 * theme filled; on white a hairline box, smaller and lighter than the content it filters. */
export function chipClass(active: boolean): string {
  return cn(
    "h-7 gap-1.5 bg-muted px-2.5 text-sm font-medium shadow-none light:h-6.5 light:border-border light:bg-card light:text-xs light:text-text-2",
    active && "border-brand/40 bg-brand-soft hover:bg-brand-soft light:bg-brand-soft",
  );
}

/** A filter button with a searchable, keyboard-driven list (shadcn Popover + Command), GitHub-style. */
export function FilterMenu({
  label,
  title,
  summary,
  items,
  multiple,
  open,
  onOpenChange,
  onSelect,
  onClear,
  searchKey,
}: FilterMenuProps) {
  // Nothing is highlighted until the pointer or the arrow keys pick a row: cmdk marks the first one when the value
  // is empty, so it starts at one no row has.
  const [active, setActive] = useState(NONE);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setActive(NONE);
        onOpenChange(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={chipClass(Boolean(summary))}>
          {label}
          {summary ? (
            <>
              <span className="text-muted-foreground">·</span>
              <span className="max-w-40 truncate font-semibold text-brand">{summary}</span>
            </>
          ) : null}
          <ChevronDownIcon className="size-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      {/* As wide as its longest value, within bounds. */}
      <PopoverContent align="start" className="w-auto max-w-80 min-w-52 p-1">
        <Command value={active} onValueChange={setActive} filter={(value, search) => matches(value, search, searchKey)}>
          <div className="flex items-center justify-between gap-4 px-2.5 pt-1.5 pb-1 text-sm font-medium text-muted-foreground">
            {title}
            {summary ? (
              <button
                type="button"
                className="text-sm font-medium text-brand hover:underline"
                onClick={() => {
                  onClear();
                  onOpenChange(false);
                }}
              >
                Clear
              </button>
            ) : null}
          </div>
          {items.length >= SEARCH_FROM ? <CommandInput placeholder={`Filter ${label.toLowerCase()}…`} /> : null}
          <CommandList>
            <CommandEmpty>Nothing matches.</CommandEmpty>
            <CommandGroup className="p-0">
              {items.map((item) => (
                <CommandItem
                  key={item.value}
                  value={item.label}
                  onSelect={() => {
                    onSelect(item.value);
                    if (!multiple) onOpenChange(false);
                  }}
                  className="group gap-2.5 px-2.5 py-1.5 text-base"
                >
                  {multiple ? <CheckBox checked={item.selected} /> : null}
                  <ItemLabel item={item} />
                  {item.action ? <RowAction action={item.action} /> : null}
                  {!multiple && item.selected ? (
                    <CheckIcon className="ml-auto size-4 text-brand" strokeWidth={2.5} />
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** A row's box in a menu of several picks. */
function CheckBox({ checked }: { checked: boolean }) {
  return (
    <span
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[0.25rem] border border-muted-foreground/40",
        checked && "border-primary bg-primary text-primary-foreground",
      )}
    >
      {checked ? <CheckIcon className="size-3" strokeWidth={3} /> : null}
    </span>
  );
}

/** A row's value: as the console shows it elsewhere, else its label after its colored dot. */
function ItemLabel({ item }: { item: FilterItem }) {
  if (item.display) return item.display;
  return (
    <>
      {item.tone ? <span className={cn("size-2 shrink-0 rounded-full", item.tone)} aria-hidden="true" /> : null}
      <span className="truncate">{item.label}</span>
    </>
  );
}

/** A row's second pick at its end, there on hover or when the keys reach the row; its click is its own. */
function RowAction({ action }: { action: FilterAction }) {
  return (
    <button
      type="button"
      aria-label={action.title}
      title={action.title}
      className="-my-1 ml-auto shrink-0 rounded px-1.5 py-0.5 text-sm text-muted-foreground opacity-0 group-hover:opacity-100 group-data-[selected=true]:opacity-100 hover:bg-background hover:text-foreground focus-visible:opacity-100"
      onClick={(event) => {
        event.stopPropagation();
        action.onClick();
      }}
    >
      {action.label}
    </button>
  );
}

/** A row the menu's box finds: its text contains what was typed, a typed `key:` (logger:org) left out. */
function matches(value: string, search: string, key: string | undefined): number {
  const typed = search.trim().toLowerCase();
  const wanted = key && typed.startsWith(`${key}:`) ? typed.slice(key.length + 1) : typed;
  return value.toLowerCase().includes(wanted) ? 1 : 0;
}
