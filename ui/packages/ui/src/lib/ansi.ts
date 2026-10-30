// ANSI escape sequences: a control sequence (colours and styles, `ESC[1;32m`; 8-bit CSI too), an operating system
// command up to its terminator (a hyperlink, `ESC]8;;url ESC\`), or ESC and one character.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape sequences are what it finds.
const ANSI = /(?:\u001b\[|\u009b)[ -?]*[@-~]?|\u001b[\]P_^X][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[^[\]P_^X]?/g;

/**
 * A log record's text without its ANSI colours, as a terminal shows it. The agent drops them when a trace arrives;
 * records stored before it did still have them.
 */
export function withoutAnsi(text: string): string {
  return text.includes("\u001b") || text.includes("\u009b") ? text.replace(ANSI, "") : text;
}

/**
 * A log record's text as a row shows it, on one line: from its first line with words when it starts with borders
 * only (a table's or a banner's `├───┬───`, `=====`), which say nothing on a row. All of it in its details.
 */
export function messageLine(message: string): string {
  const text = withoutAnsi(message);
  const lines = text.split("\n");
  const first = lines.findIndex((line) => /[\p{L}\p{N}]/u.test(line));
  return first > 0 ? lines.slice(first).join("\n") : text;
}
