// Log records as one table wherever they are listed: the console's Logs page and a trace's Logs tab. One line per
// record, its details opened under it; columns the reader sizes and picks, kept per browser.
import { cn } from "@tracepanel/ui/lib/utils";
import { createContext, Fragment, type KeyboardEvent, type MouseEvent, type ReactNode, useContext } from "react";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "./components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table";
import { ago, clock, duration, since } from "./format";
import { type ColumnSpec, type Columns, useColumns } from "./hooks/useColumns";
import { useStored } from "./hooks/useStored";
import { logAttrs } from "./LogRecordDetails";
import { type ColumnEdge, ColumnHead, ColumnsMenu, useColumnWidths } from "./TableColumns";
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
        "inline-flex items-center gap-1.5 font-mono text-2xs font-semibold tracking-wide uppercase",
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

/** When a record was made: the time of day, or how long after the request started (or how long ago). */
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
      {mode === "relative" ? relative : clock(time)}
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
function Message({ log }: { log: LogLike }) {
  return (
    <span className="flex min-w-0 items-baseline gap-2.5">
      <span title={log.message.slice(0, 2000)} className="max-w-full shrink-0 truncate font-mono">
        {log.message}
      </span>
      {log.exception ? <span className="min-w-0 truncate font-mono text-error">{lastLine(log.exception)}</span> : null}
    </span>
  );
}

/** A record's attributes on one line, `key=value`, in the order its details list them. */
function Attributes({ attrs }: { attrs: LogLike["attrs"] }) {
  return (
    <span className="font-mono text-xs">
      {Object.entries(logAttrs(attrs)).map(([key, value]) => (
        <span key={key} className="mr-3">
          <span className="text-muted-foreground">{key}=</span>
          {String(value)}
        </span>
      ))}
    </span>
  );
}

function leading<R extends LogLike>(mode: TimeMode, start: number | undefined): LogColumn<R>[] {
  return [
    {
      id: "time",
      label: "Time",
      width: 7,
      fixed: true,
      cell: (log) => <LogTime time={log.time} mode={mode} start={start} />,
    },
    { id: "level", label: "Level", width: 5.5, fixed: true, cell: (log) => <LogLevel level={log.level} /> },
    { id: "message", label: "Message", required: true, cell: (log) => <Message log={log} /> },
    {
      id: "logger",
      label: "Logger",
      width: 9,
      cell: (log) => <span className="font-mono text-muted-foreground">{log.logger}</span>,
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
    width: 9,
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
    <span className="font-mono text-xs" title={text}>
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
    { id: "attributes", label: "Attributes", width: 16, hidden: true, cell: (log) => <Attributes attrs={log.attrs} /> },
  ];
}

/** Which header edge resizes a column: the one facing the column that takes the rest, which has none itself. */
function edgeOf(shown: readonly ColumnSpec[], index: number): ColumnEdge | undefined {
  const flex = shown.findIndex((spec) => spec.width === undefined);
  if (index === flex) return undefined;
  return index < flex ? "end" : "start";
}

// The console's table headers (text, weight, case), a little lower for one-line rows.
const HEAD = "h-9 px-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase first:pl-4";
const CELL = "truncate px-2 py-1 first:pl-4";

// A warning or a failure marks the row's edge, as the console's other lists mark theirs.
const ROW = cn(
  "cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
  "data-[level=warning]:[&>td:first-child]:shadow-[inset_3px_0_0_var(--color-warn)]",
  "data-[level=error]:[&>td:first-child]:shadow-[inset_3px_0_0_var(--color-error)]",
  "data-[level=critical]:[&>td:first-child]:shadow-[inset_3px_0_0_var(--color-error)]",
);

/** Whether a click in a row opens it: anywhere but a link or a button in it, and not the end of selecting its text. */
function opens(event: MouseEvent): boolean {
  if (window.getSelection()?.toString()) return false;
  return !(event.target as Element).closest("a, button, [role=separator]");
}

/** The record row next to this one, up or down, past what isn't one (a record's details, a day's heading). */
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

/** What takes a column off from its header: only an attribute's, which the reader added. */
function removable(id: string, onRemove: (key: string) => void): (() => void) | undefined {
  return id.startsWith(ATTRIBUTE) ? () => onRemove(id.slice(ATTRIBUTE.length)) : undefined;
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
    <TableHeader className="bg-muted">
      <TableRow className="hover:bg-transparent">
        {columns.shown.map((spec, index) => (
          <ColumnHead
            key={spec.id}
            id={spec.id}
            onMove={(moved) => columns.move(moved, spec.id)}
            onRemove={removable(spec.id, onRemoveAttribute)}
            label={spec.label}
            width={widths.get(spec.id)}
            onWidth={(width) => columns.setWidth(spec.id, width)}
            edge={edgeOf(columns.shown, index)}
            className={HEAD}
          />
        ))}
        <TableHead className="w-9 px-1 text-right">
          <ColumnsMenu columns={columns} changed={changed} onReset={onReset}>
            {attributes}
            <DropdownMenuLabel>Time</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={mode} onValueChange={(value) => onMode(readTime(value))}>
              <DropdownMenuRadioItem value="clock" onSelect={(event) => event.preventDefault()}>
                Time of day
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="relative" onSelect={(event) => event.preventDefault()}>
                {relativeLabel}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </ColumnsMenu>
        </TableHead>
      </TableRow>
    </TableHeader>
  );
}

/** A local day, as the rows' times can't say it: "Monday, October 19". */
function dayOf(us: number): string {
  return new Date(us / 1000).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

/**
 * The day above a record when it is another than the record's above, or (the first) another than today: the time
 * column shows the time of day only.
 */
function DayHeading({ time, before, span }: { time: number; before: number | undefined; span: number }) {
  const day = dayOf(time);
  if (day === dayOf(before ?? Date.now() * 1000)) return null;
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={span} className="bg-muted/60 py-1 pl-4 text-xs font-semibold text-muted-foreground">
        {day}
      </TableCell>
    </TableRow>
  );
}

function LogRecordRow<R extends LogLike>({
  log,
  shown,
  open,
  onToggle,
  action,
  details,
}: {
  log: R;
  shown: readonly LogColumn<R>[];
  open: boolean;
  onToggle: () => void;
  action: ((log: R) => ReactNode) | undefined;
  details: (log: R) => ReactNode;
}) {
  return (
    <>
      <TableRow
        data-level={log.level}
        data-record=""
        tabIndex={0}
        aria-expanded={open}
        className={ROW}
        onClick={(event) => opens(event) && onToggle()}
        onKeyDown={(event) => onRowKey(event, open, onToggle)}
      >
        {shown.map((column) => (
          <TableCell key={column.id} className={CELL}>
            {column.cell(log, open)}
          </TableCell>
        ))}
        <TableCell className="px-1 py-0 text-right">{action?.(log)}</TableCell>
      </TableRow>
      {open ? (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={shown.length + 1} className="bg-muted/40 p-0 whitespace-normal">
            {details(log)}
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
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
}) {
  const [mode, setMode] = useStored(`tracepanel:columns:${table}:time`, readTime);
  const [picked, setPicked] = useStored(`tracepanel:columns:${table}:attributes`, readKeys);
  const all = [...leading<R>(mode, start), ...extra, ...attributeColumns<R>(picked), ...trailing<R>()];
  const columns = useColumns(table, all);
  const shown = columns.shown;
  // The columns menu's own column is w-9.
  const { ref, widths } = useColumnWidths(columns, 2.25);
  const reset = () => {
    columns.reset();
    setMode("clock");
    setPicked([]);
  };
  const pinned: AttributeColumns = {
    has: (key) => picked.includes(key),
    toggle: (key) => setPicked(toggled(picked, key)),
  };
  return (
    <AttributeColumnsContext.Provider value={pinned}>
      <Table ref={ref} className="table-fixed text-sm" stickyHeader={stickyHeader}>
        <LogHead
          columns={columns}
          widths={widths}
          changed={columns.changed || mode !== "clock" || picked.length > 0}
          onReset={reset}
          mode={mode}
          onMode={setMode}
          relativeLabel={start === undefined ? "Time ago" : "Since the request started"}
          attributes={<AttributeColumnsMenu keys={attributeKeys(logs)} picked={picked} onPick={setPicked} />}
          onRemoveAttribute={(key) => setPicked(picked.filter((each) => each !== key))}
        />
        <TableBody>
          {logs.map((log, index) => {
            const key = keyOf(log);
            return (
              <Fragment key={key}>
                <DayHeading time={log.time} before={logs[index - 1]?.time} span={shown.length + 1} />
                <LogRecordRow
                  log={log}
                  shown={shown}
                  open={open === key}
                  onToggle={() => onOpen(open === key ? null : key)}
                  action={action}
                  details={details}
                />
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </AttributeColumnsContext.Provider>
  );
}
