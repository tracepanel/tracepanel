import { parseAbsolute, shortTime } from "./time";

/** "since 15:27:14 until 15:42:00", or "the last 1h": a period as people read it. */
export function describePeriod(period: string): string {
  return period
    .split(" ")
    .map((term) => {
      const [key = "", value = ""] = term.split(/:(.*)/s);
      const at = parseAbsolute(value);
      if (at) return `${key} ${shortTime(at)}`;
      return key === "since" ? `the last ${value}` : `until ${value} ago`;
    })
    .join(" ");
}

/** The period a page is looking at, and the way to see all of it; `unsupported` says why it does not apply. */
export function PeriodChip({
  period,
  allTime,
  unsupported,
}: {
  period: string;
  allTime: string;
  unsupported?: string | undefined;
}) {
  if (!period) return null;
  if (unsupported) {
    return (
      <p className="text-sm text-muted-foreground">
        {describePeriod(period)} on the list: {unsupported}.
      </p>
    );
  }
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className="rounded-md border px-2 py-0.5 font-medium text-foreground">{describePeriod(period)}</span>
      <a href={allTime} className="font-medium text-brand hover:underline">
        All time
      </a>
    </p>
  );
}
