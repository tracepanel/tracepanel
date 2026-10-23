import { Button } from "@tracepanel/ui/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@tracepanel/ui/components/ui/popover";
import { CalendarClockIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import { chipClass } from "./FilterMenu";
import { isoWithOffset, parseAbsolute, shortTime, toLocalInput } from "./time";

const PRESETS: [string, string][] = [
  ["5m", "Last 5 minutes"],
  ["15m", "Last 15 minutes"],
  ["1h", "Last hour"],
  ["6h", "Last 6 hours"],
  ["1d", "Last 24 hours"],
  ["7d", "Last 7 days"],
];

/** A since:/until: value ↔ what <input type="datetime-local"> shows (local time); written back with the offset. */
const toInput = (value: string) => {
  const date = parseAbsolute(value);
  return date ? toLocalInput(date) : "";
};
const fromInput = (value: string) => (value ? isoWithOffset(new Date(value)) : "");

function describe(since: string | undefined, until: string | undefined): string | null {
  if (!(since || until)) return null;
  const preset = PRESETS.find(([value]) => value === since);
  if (preset && !until) return preset[1];
  const show = (value: string | undefined) => {
    if (!value) return "now";
    const date = parseAbsolute(value);
    return date ? shortTime(date) : `${value} ago`;
  };
  return `${since ? show(since) : "start"} → ${show(until)}`;
}

export interface TimeRangeProps {
  since: string | undefined;
  until: string | undefined;
  /** Writes since:/until: (undefined removes the bound). */
  onChange: (since: string | undefined, until: string | undefined) => void;
  /** "Started", "Logged", "Sent", "Last seen": what the bounds apply to. */
  verb?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** A time window: quick presets, or a custom from/to, written into the search as since:/until:. */
export function TimeRange({ since, until, onChange, verb = "Started", open, onOpenChange }: TimeRangeProps) {
  const [from, setFrom] = useState(toInput(since ?? ""));
  const [to, setTo] = useState(toInput(until ?? ""));
  const summary = describe(since, until);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setFrom(toInput(since ?? ""));
          setTo(toInput(until ?? ""));
        }
        onOpenChange(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={chipClass(Boolean(summary))}>
          <CalendarClockIcon className="text-muted-foreground" />
          {summary ? <span className="max-w-64 truncate font-semibold text-brand">{summary}</span> : "Time"}
          <ChevronDownIcon className="size-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[22rem] p-0">
        <div className="border-b px-3 py-2.5 text-sm font-semibold">{verb} within</div>
        <div className="grid grid-cols-2 gap-1 p-2">
          {PRESETS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={since === value && !until}
              className="rounded-md px-2.5 py-2 text-left text-base hover:bg-accent aria-pressed:bg-brand-soft aria-pressed:font-medium aria-pressed:text-brand"
              onClick={() => {
                onChange(value, undefined);
                onOpenChange(false);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <form
          className="grid gap-2.5 border-t p-3"
          onSubmit={(event) => {
            event.preventDefault();
            onChange(fromInput(from) || undefined, fromInput(to) || undefined);
            onOpenChange(false);
          }}
        >
          <span className="text-sm font-semibold">Custom range</span>
          <label className="grid grid-cols-[48px_1fr] items-center gap-2 text-sm text-muted-foreground">
            From
            <input
              type="datetime-local"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className="h-8 rounded-md border bg-background px-2 font-mono text-sm text-foreground"
            />
          </label>
          <label className="grid grid-cols-[48px_1fr] items-center gap-2 text-sm text-muted-foreground">
            To
            <input
              type="datetime-local"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className="h-8 rounded-md border bg-background px-2 font-mono text-sm text-foreground"
            />
          </label>
          <div className="flex justify-between gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!summary}
              onClick={() => {
                onChange(undefined, undefined);
                onOpenChange(false);
              }}
            >
              Any time
            </Button>
            <Button type="submit" size="sm" disabled={!(from || to)}>
              Apply range
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
