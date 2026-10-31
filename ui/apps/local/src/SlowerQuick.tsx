import { Button } from "@tracepanel/ui/components/ui/button";
import { type FormEvent, useState } from "react";
import { FilterMenu } from "./FilterMenu";
import { durationMs, durationTerm, msText } from "./slower";

/** A search's filter, as the search bar keeps it. */
interface Term {
  key: string;
  op: string;
  value: string;
}

/** From how many milliseconds a page calls a row slow, as the agent says (`/api/values`' `slow`). */
export interface SlowLimit {
  ms: number;
  /** The page's apps or databases have limits of their own: this is the lowest default. */
  mixed: boolean;
}

interface Preset {
  label: string;
  ms: number;
}

/** The presets where the agent has no slow time for a page (Redis, a broker, a model). */
const WITHOUT: readonly number[] = [100, 1000, 5000];
/** The presets after the page's slow time. */
const AFTER: readonly number[] = [1000, 5000];
/** The longest time one may type: a day. */
const MOST_MS = 86_400_000;

/** The page's slow time first ("Slow (over 100 ms)"), then 1 s and 5 s; without one, 100 ms, 1 s, 5 s. */
export function presets(limit: SlowLimit | undefined): Preset[] {
  if (!limit) return WITHOUT.map((ms) => ({ label: msText(ms), ms }));
  const slow = {
    label: limit.mixed ? `Over ${msText(limit.ms)} (default)` : `Slow (over ${msText(limit.ms)})`,
    ms: limit.ms,
  };
  return [slow, ...AFTER.filter((ms) => ms > limit.ms).map((ms) => ({ label: msText(ms), ms }))];
}

/** A typed time in milliseconds, or null: a positive number up to a day. */
export function typedMs(text: string): number | null {
  const value = text.trim();
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const ms = Number(value);
  return ms > 0 && ms <= MOST_MS ? ms : null;
}

const isSlower = (term: Term) => term.key === "duration" && (term.op === ">" || term.op === ">=");

interface SlowerQuickProps<T extends Term> {
  filters: T[];
  limit: SlowLimit | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (filters: T[], close: boolean) => void;
  make: (key: string, op: string, value: string) => T;
}

/**
 * Slower than: the page's slow time, 1 s, 5 s, or a time of one's own, as `duration>500ms`. Every page with times
 * has it, the same menu: requests, tasks and the rest, and each system's calls.
 */
export function SlowerQuick<T extends Term>({
  filters,
  limit,
  open,
  onOpenChange,
  onChange,
  make,
}: SlowerQuickProps<T>) {
  const current = filters.find(isSlower);
  const rest = filters.filter((term) => !isSlower(term));
  const currentMs = current ? durationMs(current.value) : null;
  const options = presets(limit);
  const active = options.find((option) => currentMs === option.ms && current?.op === ">");
  const pick = (ms: number) => onChange([...rest, make("duration", ">", durationTerm(ms))], true);
  return (
    <FilterMenu
      label="Slower than"
      title="Slower than"
      summary={active?.label ?? (currentMs === null ? null : `> ${msText(currentMs)}`)}
      items={options.map((option) => ({ value: String(option.ms), label: option.label, selected: option === active }))}
      multiple={false}
      open={open}
      onOpenChange={onOpenChange}
      onSelect={(value) => (active && String(active.ms) === value ? onChange(rest, true) : pick(Number(value)))}
      onClear={() => onChange(rest, true)}
      footer={<OwnTime initial={active || currentMs === null ? "" : String(currentMs)} onPick={pick} />}
    />
  );
}

/** "> ___ ms": a time of one's own, written when it is one. */
function OwnTime({ initial, onPick }: { initial: string; onPick: (ms: number) => void }) {
  const [text, setText] = useState(initial);
  const ms = typedMs(text);
  const wrong = text.trim() !== "" && ms === null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ms !== null) onPick(ms);
  };
  return (
    <form className="mt-1 border-t px-2.5 pt-2 pb-1.5" onSubmit={submit} aria-label="Slower than a time of your own">
      <div className="flex items-center gap-2 text-base">
        <span className="text-muted-foreground">&gt;</span>
        <input
          type="text"
          inputMode="decimal"
          value={text}
          placeholder="750"
          aria-label="Milliseconds"
          aria-invalid={wrong || undefined}
          className="h-7 w-20 rounded-md border border-input bg-background px-2 font-mono text-sm outline-none focus:border-ring aria-invalid:border-error"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
        />
        <span className="text-muted-foreground">ms</span>
        <Button type="submit" size="sm" variant="outline" className="ml-auto h-7" disabled={ms === null}>
          Apply
        </Button>
      </div>
      {wrong ? <p className="mt-1 text-sm text-error">A number of milliseconds, up to a day.</p> : null}
    </form>
  );
}
