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
  /** Kept at its width when the table is narrow: its content has one width (a time, a level), cut it would say less. */
  fixed?: boolean;
}

/** What the reader changed: widths dragged (px), columns shown or hidden, by column id, and the columns' order. */
interface ColumnPrefs {
  widths: Record<string, number>;
  shown: Record<string, boolean>;
  order: string[];
}

const NONE: ColumnPrefs = { widths: {}, shown: {}, order: [] };

function entries<T>(raw: unknown, valid: (value: unknown) => value is T): Record<string, T> {
  if (typeof raw !== "object" || raw === null) return {};
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => valid(value)));
}

const isWidth = (value: unknown): value is number => typeof value === "number" && value > 0;
const isFlag = (value: unknown): value is boolean => typeof value === "boolean";

function readPrefs(raw: unknown): ColumnPrefs {
  if (typeof raw !== "object" || raw === null) return NONE;
  const { widths, shown, order } = raw as Partial<Record<keyof ColumnPrefs, unknown>>;
  return { widths: entries(widths, isWidth), shown: entries(shown, isFlag), order: ids(order) };
}

function ids(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
}

/** The specs in the reader's order: the ones it placed first as placed, the others after, as the table lists them. */
function ordered<S extends ColumnSpec>(specs: readonly S[], order: readonly string[]): S[] {
  const rank = (spec: S) => {
    const at = order.indexOf(spec.id);
    return at === -1 ? order.length + specs.indexOf(spec) : at;
  };
  return [...specs].sort((a, b) => rank(a) - rank(b));
}

/** The ids in order with `moved` put where `target` is. */
function placed(current: readonly string[], moved: string, target: string): string[] {
  const without = current.filter((id) => id !== moved);
  const at = without.indexOf(target);
  if (at === -1) return [...current];
  const before = current.indexOf(moved) > current.indexOf(target);
  return [...without.slice(0, before ? at : at + 1), moved, ...without.slice(before ? at : at + 1)];
}

/**
 * A table's columns as this browser last left them: which are shown, how wide each was dragged. Kept per table, by
 * `table` (one key for the Logs page, another for a trace's Logs tab).
 */
export function useColumns<S extends ColumnSpec>(table: string, given: readonly S[]) {
  const [prefs, setPrefs] = useStored(`tracepanel:columns:${table}`, readPrefs);
  const isShown = (spec: ColumnSpec) => spec.required || (prefs.shown[spec.id] ?? !spec.hidden);
  const specs = ordered(given, prefs.order);
  return {
    specs,
    shown: specs.filter(isShown),
    /** Puts the `moved` column where `target` is, the others after it shifting along. */
    move: (moved: string, target: string) =>
      setPrefs({
        ...prefs,
        order: placed(
          specs.map((spec) => spec.id),
          moved,
          target,
        ),
      }),
    isShown,
    /** The dragged width in px, if the reader dragged it. */
    widthOf: (id: string): number | undefined => prefs.widths[id],
    setWidth: (id: string, width: number) =>
      setPrefs({ ...prefs, widths: { ...prefs.widths, [id]: Math.round(width) } }),
    setShown: (id: string, shown: boolean) => setPrefs({ ...prefs, shown: { ...prefs.shown, [id]: shown } }),
    /** Whether anything differs from the defaults: what the menu's reset would undo. */
    changed: Object.keys(prefs.widths).length + Object.keys(prefs.shown).length + prefs.order.length > 0,
    reset: () => setPrefs(NONE),
  };
}

export type Columns = ReturnType<typeof useColumns>;
