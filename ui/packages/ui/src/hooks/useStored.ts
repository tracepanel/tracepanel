import { useCallback, useState } from "react";
import { readJson, writeItem } from "../lib/storage";

/**
 * A view choice this browser keeps (column widths, a time format): read once from localStorage, written on each
 * change. `read` turns whatever is stored, or nothing, into a valid value: a stale or broken entry is a default.
 */
export function useStored<T>(key: string, read: (raw: unknown) => T): [T, (next: T) => void] {
  const [value, setValue] = useState(() => read(readJson(key)));
  const set = useCallback(
    (next: T) => {
      setValue(next);
      writeItem(key, JSON.stringify(next));
    },
    [key],
  );
  return [value, set];
}
