// The browser's storage, which can throw: blocked in a private window or by a policy, full, or missing where a file
// is opened. A choice that can't be kept then lasts as long as the page, so a read is "nothing stored" and a write
// does nothing.

type Area = "localStorage" | "sessionStorage";

/** The value under `key`, null when there is none or storage can't be read. */
export function readItem(key: string, area: Area = "localStorage"): string | null {
  try {
    return window[area].getItem(key);
  } catch {
    return null;
  }
}

/** Keeps `value` under `key`, or forgets it when null. */
export function writeItem(key: string, value: string | null, area: Area = "localStorage"): void {
  try {
    if (value === null) window[area].removeItem(key);
    else window[area].setItem(key, value);
  } catch {
    // The choice lasts as long as the page.
  }
}

/** The JSON under `key`, undefined when there is none, it is broken or storage can't be read. */
export function readJson(key: string, area: Area = "localStorage"): unknown {
  const text = readItem(key, area);
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
