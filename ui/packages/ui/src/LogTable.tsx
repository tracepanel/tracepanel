// Log records as one table wherever they are listed: the console's Logs page and a trace's Logs tab. One line per
// record, its details opened under it; columns the reader sizes and picks, kept per browser.

import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { cn } from "@tracepanel/ui/lib/utils";
import {
  createContext,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "./components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableRow } from "./components/ui/table";
import { ago, duration, since, stamp } from "./format";
import { type ColumnSpec, type Columns, useColumns } from "./hooks/useColumns";
import { useStored } from "./hooks/useStored";
import { logAttrs } from "./LogRecordDetails";
import { withoutAnsi } from "./lib/ansi";
import { bodyCell, ColumnsHeader, MENU_REM, useColumnWidths } from "./TableColumns";
import type { Log } from "./types";

type LogLike = Pick<Log, "time" | "level" | "logger" | "message" | "exception" | "attrs">;

/** A column of the table: its spec, and what its cell shows for a record (`open`: its details are shown). */
export interface LogColumn<R> extends ColumnSpec {
  cell: (log: R, open: boolean) => ReactNode;
}

const LEVEL_TEXT: Record<string, string> = {
  debug: "text-muted-foreground",
  info: "text-muted-foreground",
  warning: "text-warn",
  error: "text-error",
  critical: "text-error",
};

const LEVEL_DOT: Record<string, string> = {
  debug: "bg-muted-foreground/50",
  info: "bg-info",
  warning: "bg-warn",
  error: "bg-error",
  critical: "bg-error ring-2 ring-error/30",
};

/** A log level as a colored dot and its name: the same in every list of records and in the Level filter. */
export function LogLevel({ level }: { level: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-xs font-semibold tracking-wide uppercase",
        LEVEL_TEXT[level] ?? LEVEL_TEXT["debug"],
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 shrink-0 rounded-full", LEVEL_DOT[level] ?? LEVEL_DOT["debug"])}
      />
      {level}
    </span>
  );
}

/** When a record was made: its day and time, or how long after the request started (or how long ago). */
type TimeMode = "clock" | "relative";

const readTime = (raw: unknown): TimeMode => (raw === "relative" ? "relative" : "clock");

function LogTime({ time, mode, start }: { time: number; mode: TimeMode; start: number | undefined }) {
  const at = new Date(time / 1000);
  const relative = start === undefined ? ago(time) : `+${duration(Math.max(time - start, 0))}`;
  const said = start === undefined ? ago(time) : since(time, start);
  return (
    <time
      className="text-muted-foreground tabular-nums"
      dateTime={at.toISOString()}
      title={`${at.toLocaleString()}, ${said}`}
    >
      {mode === "relative" ? relative : stamp(time)}
    </time>
  );
}

/** An exception's last line: its type and message, what the record is about once it failed. */
function lastLine(text: string): string {
  return text.trimEnd().split("\n").pop() ?? text;
}

/**
 * The message on one line (the whole of it on hover, and in the details), text to select and copy: the row opens the
 * record. An exception's last line follows in what the message leaves.
 */
function Message({ log, terms }: { log: LogLike; terms: readonly string[] }) {
  const message = withoutAnsi(log.message);
  return (
    <span className="flex min-w-0 items-baseline gap-2.5">
      <span title={message.slice(0, 2000)} className="max-w-full shrink-0 truncate font-mono">
        <Marked text={message} terms={terms} />
      </span>
      {log.exception ? (
        <span className="min-w-0 truncate font-mono text-error">{lastLine(withoutAnsi(log.exception))}</span>
      ) : null}
    </span>
  );
}

/** The text with what the search's words found in it marked, case aside. */
export function Marked({ text, terms }: { text: string; terms: readonly string[] }) {
  const words = terms.filter(Boolean).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length === 0) return text;
  // Split on a capturing group: the found words land at the odd places.
  const parts = text.split(new RegExp(`(${words.join("|")})`, "i"));
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one text, in its order.
      <mark key={index} className="rounded-xs bg-warn/25 text-inherit">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

/** A record's attributes on one line, `key=value`, in the order its details list them. */
function Attributes({ attrs }: { attrs: LogLike["attrs"] }) {
  return (
    <span className="font-mono">
      {Object.entries(logAttrs(attrs)).map(([key, value]) => (
        <span key={key} className="mr-3">
          <span className="text-muted-foreground">{key}=</span>
          {typeof value === "string" ? value : JSON.stringify(value)}
        </span>
      ))}
    </span>
  );
}

function leading<R extends LogLike>(
  mode: TimeMode,
  start: number | undefined,
  terms: readonly string[],
): LogColumn<R>[] {
  return [
    {
      id: "time",
      label: "Time",
      // The whole stamp, to the millisecond, at the larger dark text: Oct 23 07:44:12.345.
      width: 13.5,
      fixed: true,
      cell: (log) => <LogTime time={log.time} mode={mode} start={start} />,
    },
    { id: "level", label: "Level", width: 7, fixed: true, cell: (log) => <LogLevel level={log.level} /> },
    { id: "message", label: "Message", required: true, cell: (log) => <Message log={log} terms={terms} /> },
    {
      id: "logger",
      label: "Logger",
      width: 10.5,
      drop: 2,
      cell: (log) => <span className="font-mono text-muted-foreground">{withoutAnsi(log.logger)}</span>,
    },
  ];
}

/** The attribute columns of the table a record's details open in: whether a key is one, and to make it one or not. */
export interface AttributeColumns {
  has: (key: string) => boolean;
  toggle: (key: string) => void;
}

const AttributeColumnsContext = createContext<AttributeColumns | null>(null);

/** The attribute columns of the table around: null outside one. */
export function useAttributeColumns(): AttributeColumns | null {
  return useContext(AttributeColumnsContext);
}

function toggled(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((each) => each !== key) : [...keys, key];
}

/** Attribute keys the reader made columns of, as stored: a list of strings, anything else none. */
const readKeys = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((key): key is string => typeof key === "string") : [];

/** How many attribute keys the menu offers: the records' own, most common first. */
const OFFERED = 40;

/** The attribute keys of the records listed, most common first: what the menu offers as columns. */
function attributeKeys(logs: readonly LogLike[]): string[] {
  const counts = new Map<string, number>();
  for (const log of logs) {
    for (const key of Object.keys(log.attrs)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, OFFERED)
    .map(([key]) => key);
}

// An attribute column's id: this, then the attribute's key.
const ATTRIBUTE = "attr:";

/** A column per attribute the reader picked: its value in each record, nothing where a record has none. */
function attributeColumns<R extends LogLike>(keys: readonly string[]): LogColumn<R>[] {
  return keys.map((key) => ({
    id: `${ATTRIBUTE}${key}`,
    label: key,
    width: 10.5,
    // Shown while picked, whatever was stored: it comes and goes from Attribute columns, a record or its header, so
    // the columns list above doesn't offer it a second time.
    required: true,
    cell: (log) => <AttributeValue value={log.attrs[key]} />,
  }));
}

function AttributeValue({ value }: { value: unknown }) {
  if (value === undefined || value === null) return <span className="text-muted-foreground/60">—</span>;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (
    <span className="font-mono" title={text}>
      {text}
    </span>
  );
}

/** The columns menu's list of attribute keys: one checked shows that attribute as a column. */
function AttributeColumnsMenu({
  keys,
  picked,
  onPick,
}: {
  keys: readonly string[];
  picked: readonly string[];
  onPick: (keys: string[]) => void;
}) {
  const offered = [...new Set([...picked, ...keys])];
  if (offered.length === 0) return null;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>Attribute columns</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-80 w-64 overflow-y-auto">
        {offered.map((key) => (
          <DropdownMenuCheckboxItem
            key={key}
            checked={picked.includes(key)}
            onCheckedChange={(checked) => onPick(checked ? [...picked, key] : picked.filter((each) => each !== key))}
            onSelect={(event) => event.preventDefault()}
            className="font-mono text-xs"
          >
            {key}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function trailing<R extends LogLike>(): LogColumn<R>[] {
  return [
    // Every attribute on one line; Attribute columns picks one for a column of its own.
    {
      id: "attributes",
      label: "All attributes",
      width: 17.5,
      hidden: true,
      cell: (log) => <Attributes attrs={log.attrs} />,
    },
  ];
}

// A warning or a failure marks the row's edge, as the console's other lists mark theirs.
const ROW = cn(
  "cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
  // Debug records are the quiet ones: their text steps back, as a console dims its verbose lines.
  "data-[level=debug]:text-muted-foreground",
  "data-[level=warning]:[&>td:first-child]:shadow-[inset_3px_0_0_var(--color-warn)]",
  "data-[level=error]:[&>td:first-child]:shadow-[inset_3px_0_0_var(--color-error)]",
  "data-[level=critical]:[&>td:first-child]:shadow-[inset_3px_0_0_var(--color-error)]",
);

/** Whether a click in a row opens it: anywhere but a link or a button in it, and not the end of selecting its text. */
function opens(event: MouseEvent): boolean {
  if (window.getSelection()?.toString()) return false;
  return !(event.target as Element).closest("a, button, [role=separator]");
}

/** The record row next to this one, up or down, past what isn't one (a record's details). */
function neighbour(row: HTMLElement, by: number): HTMLElement | undefined {
  const rows = [...(row.parentElement?.querySelectorAll<HTMLElement>("[data-record]") ?? [])];
  return rows[rows.indexOf(row) + by];
}

/** A record row's keys: the arrows move to the next record, Enter or Space opens and closes it, Escape closes it. */
type RowKey = (row: HTMLElement, open: boolean, onToggle: () => void) => void;
// A Map: the keys are as KeyboardEvent.key spells them.
const ROW_KEYS = new Map<string, RowKey>([
  ["ArrowDown", (row) => neighbour(row, 1)?.focus()],
  ["ArrowUp", (row) => neighbour(row, -1)?.focus()],
  ["Enter", (_, __, onToggle) => onToggle()],
  [" ", (_, __, onToggle) => onToggle()],
  ["Escape", (_, open, onToggle) => open && onToggle()],
]);

function onRowKey(event: KeyboardEvent<HTMLTableRowElement>, open: boolean, onToggle: () => void) {
  const key = ROW_KEYS.get(event.key);
  // A key in a control inside the row (a details' button) is the control's.
  if (!key || event.target !== event.currentTarget) return;
  key(event.currentTarget, open, onToggle);
  event.preventDefault();
}

/**
 * What takes a column off from its header, as the columns menu would: any column that may go (Message stays). An
 * attribute's is unpicked, so the record's details offer it again; any other is hidden, the menu shows it back.
 */
function removable(spec: ColumnSpec, columns: Columns, onRemove: (key: string) => void): (() => void) | undefined {
  if (spec.id.startsWith(ATTRIBUTE)) return () => onRemove(spec.id.slice(ATTRIBUTE.length));
  return spec.required ? undefined : () => columns.setShown(spec.id, false);
}

function LogHead({
  columns,
  widths,
  changed,
  onReset,
  mode,
  onMode,
  relativeLabel,
  attributes,
  onRemoveAttribute,
}: {
  columns: Columns;
  widths: ReadonlyMap<string, number>;
  changed: boolean;
  onReset: () => void;
  mode: TimeMode;
  onMode: (mode: TimeMode) => void;
  relativeLabel: string;
  /** The menu's attribute columns. */
  attributes: ReactNode;
  onRemoveAttribute: (key: string) => void;
}) {
  return (
    <ColumnsHeader
      columns={columns}
      widths={widths}
      changed={changed}
      onReset={onReset}
      onRemove={(spec) => removable(spec, columns, onRemoveAttribute)}
    >
      {attributes}
      <DropdownMenuLabel>Time</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={mode} onValueChange={(value) => onMode(readTime(value))}>
        <DropdownMenuRadioItem value="clock" onSelect={(event) => event.preventDefault()}>
          Date and time
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="relative" onSelect={(event) => event.preventDefault()}>
          {relativeLabel}
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </ColumnsHeader>
  );
}

/**
 * A row opened as the table mounts (from the page's address, a link to a record) scrolled into view; a row opened later
 * is where the reader clicked it already. Before the table windows its rows: they are all there to find it among.
 */
function useRevealOpened(body: RefObject<HTMLTableSectionElement | null>) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: as it mounts only.
  useLayoutEffect(() => {
    body.current?.querySelector("[data-record][aria-expanded=true]")?.scrollIntoView({ block: "center" });
  }, []);
}

/** What the table's body lists, a line each: a record, and its details under it when open. */
type Line<R> = { kind: "record"; key: string; log: R } | { kind: "details"; key: string; log: R };

function linesOf<R extends LogLike>(logs: readonly R[], keyOf: (log: R) => string, open: string | null): Line<R>[] {
  return logs.flatMap((log): Line<R>[] => {
    const key = keyOf(log);
    const record: Line<R> = { kind: "record", key, log };
    return key === open ? [record, { kind: "details", key: `open:${key}`, log }] : [record];
  });
}

/** A line's height before it is measured: a record's one line, details' a guess. */
const ESTIMATE: Record<Line<unknown>["kind"], number> = { record: 31, details: 320 };

/** What a line's row needs from the table: its columns, the opened record, and the place's details and button. */
interface RowContext<R> {
  shown: readonly LogColumn<R>[];
  open: string | null;
  onOpen: (key: string | null) => void;
  action: ((log: R) => ReactNode) | undefined;
  details: (log: R) => ReactNode;
}

/** A windowed row's place among the lines, and what measures it: its height counts once it is drawn. */
interface Placed {
  index: number;
  measure: ((element: Element | null) => void) | undefined;
}

function LogRecordRow<R extends LogLike>({
  log,
  rowKey,
  context,
  placed,
}: {
  log: R;
  rowKey: string;
  context: RowContext<R>;
  placed: Placed;
}) {
  const { shown, open, onOpen, action } = context;
  const opened = open === rowKey;
  const onToggle = () => onOpen(opened ? null : rowKey);
  return (
    <TableRow
      ref={placed.measure}
      data-index={placed.index}
      data-level={log.level}
      data-record=""
      tabIndex={0}
      aria-expanded={opened}
      className={ROW}
      onClick={(event) => opens(event) && onToggle()}
      onKeyDown={(event) => onRowKey(event, opened, onToggle)}
    >
      {shown.map((column) => (
        <TableCell key={column.id} className={cn(bodyCell("compact"), "truncate")}>
          {column.cell(log, opened)}
        </TableCell>
      ))}
      <TableCell className="px-1 py-0 text-right">{action?.(log)}</TableCell>
    </TableRow>
  );
}

function DetailsRow<R>({ log, context, placed }: { log: R; context: RowContext<R>; placed: Placed }) {
  return (
    <TableRow ref={placed.measure} data-index={placed.index} className="hover:bg-transparent">
      <TableCell colSpan={context.shown.length + 1} className="bg-muted/40 p-0 whitespace-normal">
        {context.details(log)}
      </TableCell>
    </TableRow>
  );
}

function LineRow<R extends LogLike>({
  line,
  context,
  placed,
}: {
  line: Line<R>;
  context: RowContext<R>;
  placed: Placed;
}) {
  if (line.kind === "details") return <DetailsRow log={line.log} context={context} placed={placed} />;
  return <LogRecordRow log={line.log} rowKey={line.key} context={context} placed={placed} />;
}

/** The height of the rows not drawn, above or below the window: one empty row keeps the scrollbar true. */
function Spacer({ height, span }: { height: number; span: number }) {
  if (height <= 0) return null;
  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a spacer is no row to read or reach, only the height of those not drawn.
    <tr aria-hidden="true" style={{ height }}>
      <td colSpan={span} className="p-0" />
    </tr>
  );
}

/** The page's scrolling section the table is in, once it is mounted; none when the table lists every row. */
function useScroller(body: RefObject<HTMLTableSectionElement | null>, windowed: boolean): HTMLElement | null {
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setScroller(windowed ? (body.current?.closest<HTMLElement>("[data-scroll]") ?? null) : null);
  }, [body, windowed]);
  return scroller;
}

/**
 * Where the body starts in the scrolling section's content: what lies above it (the chart, the header row) moves it,
 * so it is measured again whenever the section's content changes size.
 */
function useScrollMargin(body: RefObject<HTMLTableSectionElement | null>, scroller: HTMLElement | null): number {
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    if (!scroller) return;
    const measure = () => setMargin(offsetIn(body.current, scroller));
    measure();
    const observer = new ResizeObserver(measure);
    for (const child of scroller.children) observer.observe(child);
    return () => observer.disconnect();
  }, [body, scroller]);
  return margin;
}

function offsetIn(element: Element | null, scroller: HTMLElement): number {
  if (!element) return 0;
  return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

/** The lines drawn, and the heights of those above and below them that are not. */
interface LineWindow {
  indexes: readonly number[];
  before: number;
  after: number;
  measure: Placed["measure"];
}

/**
 * The lines in view and a screenful around them, in the page's scrolling section: thousands of records loaded keep
 * the page as light as a hundred. Without the section (`windowed` off, or before it is found), every line.
 */
function useLineWindow<R>(
  lines: readonly Line<R>[],
  body: RefObject<HTMLTableSectionElement | null>,
  windowed: boolean,
): LineWindow {
  const scroller = useScroller(body, windowed);
  const margin = useScrollMargin(body, scroller);
  const virtualizer = useVirtualizer<HTMLElement, Element>({
    count: lines.length,
    getScrollElement: () => scroller,
    estimateSize: useCallback((index: number) => ESTIMATE[lines[index]?.kind ?? "record"], [lines]),
    getItemKey: useCallback((index: number) => lines[index]?.key ?? index, [lines]),
    overscan: 12,
    scrollMargin: margin,
    enabled: scroller !== null,
    useFlushSync: false,
  });
  return scroller ? windowOf(virtualizer, margin) : everyLine(lines);
}

function everyLine(lines: readonly unknown[]): LineWindow {
  return { indexes: lines.map((_, index) => index), before: 0, after: 0, measure: undefined };
}

/** The lines the virtualizer has in its window, and the room of those above and below it. */
function windowOf(virtualizer: Virtualizer<HTMLElement, Element>, margin: number): LineWindow {
  const items = virtualizer.getVirtualItems();
  const top = items[0]?.start ?? margin;
  const bottom = items.reduce((end, item) => Math.max(end, item.end), margin);
  return {
    indexes: items.map((item) => item.index),
    before: top - margin,
    after: virtualizer.getTotalSize() - (bottom - margin),
    measure: virtualizer.measureElement,
  };
}

/** What the table draws of the records: its lines, the window of them in view, the attribute keys they have. */
function useLogLines<R extends LogLike>(
  logs: readonly R[],
  keyOf: (log: R) => string,
  open: string | null,
  windowed: boolean,
) {
  // Worked out again when the records change, not on each render: a long list has thousands.
  const offered = useMemo(() => attributeKeys(logs), [logs]);
  const lines = useMemo(() => linesOf(logs, keyOf, open), [logs, keyOf, open]);
  const body = useRef<HTMLTableSectionElement>(null);
  useRevealOpened(body);
  const view = useLineWindow(lines, body, windowed);
  return { offered, lines, body, view };
}

/**
 * Records, newest or oldest first as given, one line each. `table` names where the reader's column choices are kept;
 * `columns` adds the place's own columns after Logger; `start` (a trace's) makes relative times "+12 ms" instead of
 * "3m ago". `open` and `onOpen` hold the opened record by its key; `details` is what opens under it, `action` a
 * button at the row's end.
 */
export function LogTable<R extends LogLike>({
  table,
  logs,
  keyOf,
  columns: extra = [],
  start,
  open,
  onOpen,
  details,
  action,
  stickyHeader = false,
  highlight = [],
  windowed = false,
}: {
  table: string;
  logs: readonly R[];
  keyOf: (log: R) => string;
  columns?: readonly LogColumn<R>[];
  start?: number | undefined;
  open: string | null;
  onOpen: (key: string | null) => void;
  details: (log: R) => ReactNode;
  action?: ((log: R) => ReactNode) | undefined;
  stickyHeader?: boolean;
  /** The search's words, marked where a message has them. */
  highlight?: readonly string[] | undefined;
  /** Draws only the rows in view of the page's scrolling section (`[data-scroll]`): for lists that grow long. */
  windowed?: boolean;
}) {
  const [mode, setMode] = useStored(`tracepanel:columns:${table}:time`, readTime);
  const [picked, setPicked] = useStored(`tracepanel:columns:${table}:attributes`, readKeys);
  const all = [...leading<R>(mode, start, highlight), ...extra, ...attributeColumns<R>(picked), ...trailing<R>()];
  // The columns menu has a column of its own.
  const { ref, columns, widths } = useColumnWidths(useColumns(table, all), MENU_REM);
  const shown = columns.shown;
  const reset = () => {
    columns.reset();
    setMode("clock");
    setPicked([]);
  };
  const { offered, lines, body, view } = useLogLines(logs, keyOf, open, windowed);
  const context: RowContext<R> = { shown, open, onOpen, action, details };
  const span = shown.length + 1;
  const pinned: AttributeColumns = {
    has: (key) => picked.includes(key),
    toggle: (key) => setPicked(toggled(picked, key)),
  };
  return (
    <AttributeColumnsContext.Provider value={pinned}>
      {/* The console's header and text, compact rows: a stream of records read many lines at once (TableColumns). */}
      <Table ref={ref} className="table-fixed text-base" stickyHeader={stickyHeader}>
        <LogHead
          columns={columns}
          widths={widths}
          changed={columns.changed || mode !== "clock" || picked.length > 0}
          onReset={reset}
          mode={mode}
          onMode={setMode}
          relativeLabel={start === undefined ? "Time ago" : "Since the request started"}
          attributes={<AttributeColumnsMenu keys={offered} picked={picked} onPick={setPicked} />}
          onRemoveAttribute={(key) => setPicked(picked.filter((each) => each !== key))}
        />
        <TableBody ref={body}>
          <Spacer height={view.before} span={span} />
          {view.indexes.map((index) => {
            const line = lines[index];
            return line ? (
              <LineRow key={line.key} line={line} context={context} placed={{ index, measure: view.measure }} />
            ) : null;
          })}
          <Spacer height={view.after} span={span} />
        </TableBody>
      </Table>
    </AttributeColumnsContext.Provider>
  );
}
