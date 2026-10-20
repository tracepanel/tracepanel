import { useCallback, useState } from "react";

function load<T>(key: string, read: (raw: unknown) => T): T {
  try {
    const raw = localStorage.getItem(key);
    return read(raw === null ? undefined : JSON.parse(raw));
  } catch {
    return read(undefined);
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private windows and blocked storage: the choice lasts until the page reloads.
  }
}

/**
 * A view choice this browser keeps (column widths, a time format): read once from localStorage, written on each
 * change. `read` turns whatever is stored, or nothing, into a valid value: a stale or broken entry is a default.
 */
export function useStored<T>(key: string, read: (raw: unknown) => T): [T, (next: T) => void] {
  const [value, setValue] = useState(() => load(key, read));
  const set = useCallback(
    (next: T) => {
      setValue(next);
      save(key, next);
    },
    [key],
  );
  return [value, set];
}
