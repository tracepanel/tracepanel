import { useMemo, useState } from "react";
import type { Language } from "./highlight";
import { keyed } from "./keys";
import { cn } from "./lib/utils";
import { type Shape, shapeOf } from "./lib/values";
import { CodeLines } from "./Tokens";

/** A value of more lines than this folds to the first few, with a button that opens it. */
const FOLD_LINES = 8;
const FOLDED_LINES = 6;
/** A value of more characters than this folds to three lines. */
const FOLD_CHARS = 400;

function linesOf(shape: Shape): number {
  return shape.kind === "list" ? shape.items.length : shape.text.split("\n").length;
}

function charsOf(shape: Shape): number {
  return shape.kind === "list" ? shape.items.reduce((sum, item) => sum + item.length, 0) : shape.text.length;
}

/** What the button that opens a folded value says it opens. */
function opensTo(shape: Shape): string {
  const lines = linesOf(shape);
  if (shape.kind === "list") return `Show all ${lines.toLocaleString()} items`;
  if (lines > FOLD_LINES) return `Show all ${lines.toLocaleString()} lines`;
  return `Show all ${charsOf(shape).toLocaleString()} characters`;
}

function folds(shape: Shape): boolean {
  return linesOf(shape) > FOLD_LINES || charsOf(shape) > FOLD_CHARS;
}

/**
 * A value as the console reads it, the one look of every list of names and values: a word as it came, a list one item
 * a line, JSON and a Python repr laid out and coloured. A long one folds, a button opens it.
 */
export function AttrValue({ value }: { value: unknown }) {
  const shape = useMemo(() => shapeOf(value), [value]);
  const [open, setOpen] = useState(false);
  const long = folds(shape);
  return (
    <>
      <Shaped shape={shape} folded={long && !open} />
      {long ? <FoldButton shape={shape} open={open} onToggle={() => setOpen(!open)} /> : null}
    </>
  );
}

function FoldButton({ shape, open, onToggle }: { shape: Shape; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="mt-0.5 block font-sans text-2xs text-muted-foreground hover:text-foreground"
      aria-expanded={open}
      onClick={onToggle}
    >
      {open ? "Show less" : opensTo(shape)}
    </button>
  );
}

function Shaped({ shape, folded }: { shape: Shape; folded: boolean }) {
  if (shape.kind === "list") return <ListValue items={shape.items} folded={folded} />;
  if (shape.kind === "code") return <CodeValue text={shape.text} language={shape.language} folded={folded} />;
  return <span className={cn("whitespace-pre-wrap", folded && "line-clamp-3")}>{shape.text}</span>;
}

/** A list, one item a line; folded, its first items, each in two lines at most. */
function ListValue({ items, folded }: { items: readonly string[]; folded: boolean }) {
  const shown = folded ? items.slice(0, FOLDED_LINES) : items;
  return (
    <ul className="m-0 list-none p-0">
      {keyed(shown, (item) => item).map(({ key, item }) => (
        <li key={key} className={cn("whitespace-pre-wrap", folded && "line-clamp-2")}>
          {item}
        </li>
      ))}
    </ul>
  );
}

/** Code coloured, a line each; folded, its first lines. */
function CodeValue({ text, language, folded }: { text: string; language: Language; folded: boolean }) {
  return (
    <code className={cn("dt-syntax font-mono whitespace-pre-wrap", folded ? "line-clamp-6" : "block")}>
      <CodeLines text={text} language={language} lines={folded ? FOLDED_LINES : undefined} />
    </code>
  );
}
