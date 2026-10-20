import { useStored } from "./useStored";

/** A table's column as its columns menu and its header know it. */
export interface ColumnSpec {
  id: string;
  label: string;
  /** The default width in rem; none for the one column that takes the width the others leave. */
  width?: number;
  /** Hidden until the reader shows it from the columns menu. */
  hidden?: boolean;
  /** Always shown: the menu doesn't offer to hide it. */
  required?: boolean;
}

/** What the reader changed: widths dragged (px) and columns shown or hidden, by column id. */
interface ColumnPrefs {
  widths: Record<string, number>;
  shown: Record<string, boolean>;
}

const NONE: ColumnPrefs = { widths: {}, shown: {} };

function entries<T>(raw: unknown, valid: (value: unknown) => value is T): Record<string, T> {
  if (typeof raw !== "object" || raw === null) return {};
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => valid(value)));
}

const isWidth = (value: unknown): value is number => typeof value === "number" && value > 0;
const isFlag = (value: unknown): value is boolean => typeof value === "boolean";

function readPrefs(raw: unknown): ColumnPrefs {
  if (typeof raw !== "object" || raw === null) return NONE;
  const { widths, shown } = raw as Partial<Record<keyof ColumnPrefs, unknown>>;
  return { widths: entries(widths, isWidth), shown: entries(shown, isFlag) };
}

/**
 * A table's columns as this browser last left them: which are shown, how wide each was dragged. Kept per table, by
 * `table` (one key for the Logs page, another for a trace's Logs tab).
 */
export function useColumns(table: string, specs: readonly ColumnSpec[]) {
  const [prefs, setPrefs] = useStored(`tracepanel:columns:${table}`, readPrefs);
  const isShown = (spec: ColumnSpec) => spec.required || (prefs.shown[spec.id] ?? !spec.hidden);
  return {
    specs,
    shown: specs.filter(isShown),
    isShown,
    /** The dragged width in px, if the reader dragged it. */
    widthOf: (id: string): number | undefined => prefs.widths[id],
    setWidth: (id: string, width: number) =>
      setPrefs({ ...prefs, widths: { ...prefs.widths, [id]: Math.round(width) } }),
    setShown: (id: string, shown: boolean) => setPrefs({ ...prefs, shown: { ...prefs.shown, [id]: shown } }),
    /** Whether anything differs from the defaults: what the menu's reset would undo. */
    changed: Object.keys(prefs.widths).length + Object.keys(prefs.shown).length > 0,
    reset: () => setPrefs(NONE),
  };
}

export type Columns = ReturnType<typeof useColumns>;
