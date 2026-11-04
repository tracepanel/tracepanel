// What a trace's view shows besides its tab and the part of its time picked: the row selected in the call tree, the
// rows folded or opened, the Profile tab's Time or Memory and Your code or All frames, its stretch. Each part keeps
// its own in here by a key, as plain strings; the host keeps them for Back (the panel's history, the console's
// history entries) and puts the ones a link should carry in the address (VIEW_PARAMS).

import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";

/** A view's state by key: what each part of it remembers. */
export type ViewMemory = Readonly<Record<string, string>>;

const NO_MEMORY: ViewMemory = {};

/** The keys a view remembers. */
export const VIEW_KEYS = {
  /** The row selected in the call tree (a span's id, or another row's key). */
  span: "span",
  /** The call tree's rows folded or opened from where they start, as JSON. */
  folded: "folded",
  /** The Profile tab: `memory` where it shows the memory instead of the time. */
  profileKind: "profile",
  /** The Profile tab's flame: `own` (your code) or `all` (all frames). */
  frames: "frames",
  /** The stretches the Profile tab was opened at, `from-to` in µs since the trace started, comma-separated. */
  stretch: "at",
} as const;

/**
 * The keys a link carries in the address (the console's URL, the panel's hash): a reload or a shared link opens the
 * same view. The folded rows stay with the history entry only: too long for an address, and nothing a link means.
 */
const VIEW_PARAMS: readonly string[] = [VIEW_KEYS.span, VIEW_KEYS.profileKind, VIEW_KEYS.frames, VIEW_KEYS.stretch];

/** A view's memory: what it remembers now, and the way to change it. */
export interface ViewMemoryHeld {
  /** What it remembers now: a part shown again (the call tree, back on its tab) starts from it. */
  get: (key: string) => string | undefined;
  set: (key: string, value: string | undefined) => void;
}

const MemoryContext = createContext<ViewMemoryHeld | null>(null);

/**
 * A trace's view's memory: it starts from `initial` (a link's, or the history entry Back returns to) and tells the
 * host each change. The view itself changes it too (an issue's Show selects its row).
 */
export function useViewMemory(
  initial: ViewMemory | undefined,
  onChange: ((memory: ViewMemory) => void) | undefined,
): ViewMemoryHeld {
  const current = useRef<ViewMemory>(initial ?? NO_MEMORY);
  const told = useRef(onChange);
  told.current = onChange;
  const [held] = useState<ViewMemoryHeld>(() => ({
    get: (key) => current.current[key],
    set: (key, value) => {
      if (current.current[key] === value) return;
      const { [key]: _, ...rest } = current.current;
      current.current = value === undefined ? rest : { ...rest, [key]: value };
      told.current?.(current.current);
    },
  }));
  return held;
}

/** Where the parts of a trace's view keep what they remember (useRemembered). */
export function ViewMemoryScope({ memory, children }: { memory: ViewMemoryHeld; children: ReactNode }) {
  return <MemoryContext value={memory}>{children}</MemoryContext>;
}

/**
 * A part's state, remembered under `key` in the view around it: it starts from what the view remembers now (`read`
 * turns the string back into the value; undefined where it isn't one), else `fallback`. Outside a view, plain state.
 */
export function useRemembered<T>(
  key: string,
  fallback: T | (() => T),
  read: (value: string) => T | undefined,
  write: (value: T) => string | undefined,
): [T, (next: T) => void] {
  const held = useContext(MemoryContext);
  const [value, setValue] = useState<T>(() => {
    const saved = held?.get(key);
    const restored = saved === undefined ? undefined : read(saved);
    if (restored !== undefined) return restored;
    return typeof fallback === "function" ? (fallback as () => T)() : fallback;
  });
  const remember = useCallback(
    (next: T) => {
      setValue(next);
      held?.set(key, write(next));
    },
    [held, key, write],
  );
  return [value, remember];
}

/** What a view remembers that a link carries, from an address's params. */
export function memoryFromParams(params: Readonly<Record<string, string | undefined>>): ViewMemory {
  return Object.fromEntries(VIEW_PARAMS.flatMap((key) => (params[key] ? [[key, params[key]]] : [])));
}
