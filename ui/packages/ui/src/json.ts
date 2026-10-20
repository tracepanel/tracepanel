// JSON as the console shows it wherever text may be JSON: a request's body, a log record's message.

/** JSON text indented two spaces a level; null when the text isn't JSON. */
export function indentedJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

/** A JSON object or array, indented: a message that is a document, not one value (a number, a quoted word). */
export function jsonDocument(text: string): string | null {
  return /^\s*[[{]/.test(text) ? indentedJson(text) : null;
}
