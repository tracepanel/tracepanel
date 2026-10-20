// A table's columns as the reader arranges them: a header edge to drag for a wider or narrower column, and a menu to
// show or hide columns. The choices live in useColumns, per browser.

import { cn } from "@tracepanel/ui/lib/utils";
import { Columns3CogIcon, GripVerticalIcon, XIcon } from "lucide-react";
import {
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "./components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { TableHead } from "./components/ui/table";
import { useCloseOnBlur } from "./hooks/useCloseOnBlur";
import type { Columns } from "./hooks/useColumns";

/** The narrowest a column gets, and what the column that takes the rest keeps at least. */
const MIN_WIDTH = 40;
const MIN_REST = 160;
/** The arrow keys move the edge as a drag would. */
const KEY_STEPS = new Map([
  ["ArrowLeft", -16],
  ["ArrowRight", 16],
]);

/** Which edge of its header a column is dragged by: the one toward the column that takes the rest. */
export type ColumnEdge = "start" | "end";

function rowOf(head: HTMLTableCellElement): HTMLTableRowElement | null {
  return head.parentElement instanceof HTMLTableRowElement ? head.parentElement : null;
}

/** What the other columns of a fixed width take. */
function othersWidth(head: HTMLTableCellElement): number {
  const others = Array.from(rowOf(head)?.cells ?? []).filter(
    (cell) => cell !== head && !cell.hasAttribute("data-flex"),
  );
  return others.reduce((sum, cell) => sum + cell.offsetWidth, 0);
}

function roomOf(head: HTMLTableCellElement): number {
  return head.closest("[data-slot=table-container]")?.clientWidth ?? Number.POSITIVE_INFINITY;
}

/** The widest a column can get with every other column as it is and the flexible one at its minimum. */
function widest(head: HTMLTableCellElement): number {
  return roomOf(head) - othersWidth(head) - MIN_REST;
}

function clamp(head: HTMLTableCellElement, width: number): number {
  return Math.max(MIN_WIDTH, Math.min(width, widest(head)));
}

/** Where a cell's text ends, truncated or not: an ellipsis only paints over text that is laid out in full. */
function textRight(cell: Element): number {
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let right = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    range.selectNodeContents(node);
    right = Math.max(right, range.getBoundingClientRect().right);
  }
  return right;
}

function contentWidth(cell: HTMLTableCellElement): number {
  const right = textRight(cell);
  if (right === 0) return 0;
  return right - cell.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(cell).paddingRight);
}

/** The column's cells: its header, and its cell in each record's row (not the opened details under one). */
function columnCells(head: HTMLTableCellElement): HTMLTableCellElement[] {
  const count = rowOf(head)?.cells.length ?? 0;
  const rows = Array.from(head.closest("table")?.tBodies[0]?.rows ?? []);
  const cells = rows.filter((row) => row.cells.length === count).map((row) => row.cells[head.cellIndex]);
  return [head, ...cells.filter((cell) => cell !== undefined)];
}

/** As wide as its widest value: what a double click on the edge does. */
function fitted(head: HTMLTableCellElement): number {
  return clamp(head, Math.ceil(Math.max(...columnCells(head).map(contentWidth))) + 1);
}

/** What an arrow key does to the width: toward the column that takes the rest narrows the other way. */
function keyStep(key: string, edge: ColumnEdge): number {
  const step = KEY_STEPS.get(key) ?? 0;
  return edge === "end" ? step : -step;
}

/** The width a key gives a column: an arrow moves its edge, Enter fits it to its values; other keys none. */
function keyWidth(head: HTMLTableCellElement, key: string, edge: ColumnEdge): number | undefined {
  if (key === "Enter") return fitted(head);
  const step = keyStep(key, edge);
  return step === 0 ? undefined : clamp(head, head.offsetWidth + step);
}

function headOf(handle: HTMLElement): HTMLTableCellElement | null {
  return handle.closest("th");
}

/** The edge to drag; arrow keys move it too, Enter or a double click fits the column to its values. */
function ResizeHandle({
  label,
  edge,
  width,
  onDraft,
  onWidth,
}: {
  label: string;
  edge: ColumnEdge;
  width: number | undefined;
  onDraft: (width: number | undefined) => void;
  onWidth: (width: number) => void;
}) {
  const start = useRef<{ x: number; width: number; last: number } | null>(null);
  const sign = edge === "end" ? 1 : -1;
  const down = (event: PointerEvent<HTMLDivElement>) => {
    const head = headOf(event.currentTarget);
    if (!head) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { x: event.clientX, width: head.offsetWidth, last: head.offsetWidth };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const head = headOf(event.currentTarget);
    if (!start.current || !head) return;
    start.current.last = clamp(head, start.current.width + sign * (event.clientX - start.current.x));
    onDraft(start.current.last);
  };
  const up = () => {
    if (start.current) onWidth(start.current.last);
    start.current = null;
    onDraft(undefined);
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const head = headOf(event.currentTarget);
    const next = head ? keyWidth(head, event.key, edge) : undefined;
    if (next === undefined) return;
    event.preventDefault();
    onWidth(next);
  };
  const fit = (event: { currentTarget: HTMLElement }) => {
    const head = headOf(event.currentTarget);
    if (head) onWidth(fitted(head));
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> can't be focused and dragged; a separator role can.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize the ${label} column`}
      aria-valuenow={width === undefined ? undefined : Math.round(width)}
      aria-valuemin={MIN_WIDTH}
      tabIndex={0}
      title="Drag to resize, double-click to fit"
      className={cn(
        "absolute inset-y-0 z-10 w-2 cursor-col-resize touch-none outline-none",
        "after:absolute after:inset-y-2 after:left-1/2 after:w-px after:bg-border",
        "hover:after:inset-y-0 hover:after:bg-ring focus-visible:after:inset-y-0 focus-visible:after:w-0.5 focus-visible:after:bg-ring",
        edge === "end" ? "-right-1" : "-left-1",
      )}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
      onDoubleClick={fit}
    />
  );
}

/**
 * Each shown column's width in px, as dragged or by default: scaled down together when the room left to the column
 * that takes the rest would fall under its minimum (a narrow panel, one column too many shown).
 */
function fitWidths(columns: Columns, room: number, rem: number): Map<string, number> {
  const wanted = columns.shown.flatMap((spec) =>
    spec.width === undefined ? [] : [[spec.id, columns.widthOf(spec.id) ?? spec.width * rem] as const],
  );
  const total = wanted.reduce((sum, [, width]) => sum + width, 0);
  const scale = room > 0 && total + MIN_REST > room ? Math.max(room - MIN_REST, 0) / total : 1;
  return new Map(wanted.map(([id, width]) => [id, Math.floor(width * scale)]));
}

/**
 * The columns' widths in the room the table has, kept current as it resizes. `reserved` (rem) is what columns outside
 * the spec take, a menu's; `ref` goes on the table.
 */
export function useColumnWidths(columns: Columns, reserved: number) {
  const ref = useRef<HTMLTableElement>(null);
  const [room, setRoom] = useState({ width: 0, rem: 16 });
  useLayoutEffect(() => {
    const container = ref.current?.parentElement;
    if (!container) return;
    const measure = () =>
      setRoom({
        width: container.clientWidth,
        rem: Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  return { ref, widths: fitWidths(columns, room.width - reserved * room.rem, room.rem) };
}

/** A header cell's width: as dragged right now, or as set; none for the column that takes the rest. */
function sized(width: number | undefined, draft: number | undefined) {
  const shown = draft ?? width;
  return { flex: width === undefined, shown, style: shown === undefined ? undefined : { width: `${shown}px` } };
}

// What a header carries while it is dragged onto another: its column's id.
const DRAGGED = "application/x-tracepanel-column";

/** A header a column can be dropped on: `onMove` gets the dropped column's id; `over` while one is above it. */
function useDrop(onMove: ((moved: string) => void) | undefined) {
  const [over, setOver] = useState(false);
  if (onMove === undefined) return { over, props: {} };
  const carries = (event: DragEvent) => event.dataTransfer.types.includes(DRAGGED);
  return {
    over,
    props: {
      onDragOver: (event: DragEvent) => {
        if (!carries(event)) return;
        event.preventDefault();
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (event: DragEvent) => {
        setOver(false);
        const moved = event.dataTransfer.getData(DRAGGED);
        if (moved) onMove(moved);
      },
    },
  };
}

/** The header's name, dragged to move its column before or after another. */
function DragLabel({ id, label, movable }: { id: string; label: string; movable: boolean }) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: moving a column is a pointer shortcut; the menu's reset undoes it.
    <span
      draggable={movable}
      title={movable ? "Drag to move the column" : undefined}
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAGGED, id);
        event.dataTransfer.effectAllowed = "move";
      }}
      className={cn("block truncate", movable && "cursor-grab active:cursor-grabbing")}
    >
      {/* A grip on hover: the name can be dragged onto another header. */}
      {movable ? (
        <GripVerticalIcon
          aria-hidden="true"
          className="absolute top-1/2 left-0 size-3 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity group-hover/head:opacity-70"
        />
      ) : null}
      {label}
    </span>
  );
}

/** A column the reader added, taken off from its header. */
function RemoveColumn({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Remove the ${label} column`}
      title={`Remove the ${label} column`}
      onClick={onRemove}
      className="absolute top-1/2 right-2 flex size-4 -translate-y-1/2 items-center justify-center rounded-sm bg-muted text-muted-foreground opacity-0 transition-opacity group-hover/head:opacity-100 hover:text-foreground focus-visible:opacity-100"
    >
      <XIcon className="size-3" />
    </button>
  );
}

/** A header's own buttons: the remove one, for a column the reader added, and the resize handle, on its edge. */
function HeadControls({
  label,
  onRemove,
  edge,
  width,
  onDraft,
  onWidth,
}: {
  label: string;
  onRemove: (() => void) | undefined;
  edge: ColumnEdge | undefined;
  width: number | undefined;
  onDraft: (width: number | undefined) => void;
  onWidth: (width: number) => void;
}) {
  return (
    <>
      {onRemove ? <RemoveColumn label={label} onRemove={onRemove} /> : null}
      {edge ? <ResizeHandle label={label} edge={edge} width={width} onDraft={onDraft} onWidth={onWidth} /> : null}
    </>
  );
}

/**
 * A column's header cell, `width` px wide; without one, it takes what the others leave. `edge` puts the resize handle
 * on the side that faces that column; none, the column has no handle. With `onMove`, its name drags onto another
 * header to move the column there; with `onRemove`, a button on hover takes the column off.
 */
export function ColumnHead({
  id,
  label,
  width,
  onWidth,
  edge,
  onMove,
  onRemove,
  className,
}: {
  id: string;
  label: string;
  width: number | undefined;
  onWidth: (width: number) => void;
  edge?: ColumnEdge | undefined;
  onMove?: ((moved: string) => void) | undefined;
  onRemove?: (() => void) | undefined;
  className?: string | undefined;
}) {
  const [draft, setDraft] = useState<number | undefined>(undefined);
  const { flex, shown, style } = sized(width, draft);
  const drop = useDrop(onMove);
  return (
    <TableHead
      data-flex={flex || undefined}
      style={style}
      className={cn("group/head relative", drop.over && "bg-brand-soft", className)}
      // Its name is its label: the resize handle inside has a name of its own.
      aria-label={label}
      {...drop.props}
    >
      <DragLabel id={id} label={label} movable={onMove !== undefined} />
      <HeadControls label={label} onRemove={onRemove} edge={edge} width={shown} onDraft={setDraft} onWidth={onWidth} />
    </TableHead>
  );
}

/**
 * The columns menu: each column that may go, shown or hidden; `children` adds the table's own view options; reset
 * goes back to the defaults.
 */
export function ColumnsMenu({
  columns,
  changed,
  onReset,
  children,
}: {
  columns: Columns;
  /** Whether a reset would change anything: the columns or the table's own options. */
  changed: boolean;
  onReset: () => void;
  children?: ReactNode;
}) {
  // In the panel a click on the page doesn't reach the menu: it closes when the frame loses focus.
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useCloseOnBlur(open, close);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="Columns" title="Columns">
          <Columns3CogIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Columns</DropdownMenuLabel>
        {columns.specs
          .filter((spec) => !spec.required)
          .map((spec) => (
            <DropdownMenuCheckboxItem
              key={spec.id}
              checked={columns.isShown(spec)}
              onCheckedChange={(checked) => columns.setShown(spec.id, checked === true)}
              // The menu stays open: several columns are usually changed at once.
              onSelect={(event) => event.preventDefault()}
            >
              {spec.label}
            </DropdownMenuCheckboxItem>
          ))}
        {children}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!changed} onSelect={onReset}>
          Reset to defaults
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
