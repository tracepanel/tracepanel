import { ChevronDownIcon } from "lucide-react";
import type React from "react";
import { Children, type CSSProperties, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { Card } from "./components/ui/card";
import { duration } from "./format";
import { useStored } from "./hooks/useStored";
import { cn } from "./lib/utils";
import type { HistogramBucket, LogBucket, SeriesBucket } from "./types";

// Series colors are theme tokens (--dt-chart-1/2), validated with the dataviz palette checker on each theme's
// surface: lightness band, chroma, CVD and normal-vision separation, contrast — all pass.
const P50 = "var(--dt-chart-1)";
const P95 = "var(--dt-chart-2)";
const CALLS = P50;

type Series = readonly SeriesBucket[];

/* ---------- chart frame ---------- */

function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => entry && setWidth(Math.max(entry.contentRect.width, 240)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

const HEIGHT = 240;
const PAD = { top: 16, right: 56, bottom: 24, left: 52 };

/** A top for a count axis: four whole-number ticks, so small counts never repeat a label. */
function niceCount(value: number): number {
  return Math.max(4, Math.ceil(niceMax(value) / 4) * 4);
}

/** A top for the y axis that splits into four round ticks (0, ¼, ½, ¾, max). */
function niceMax(value: number): number {
  if (value <= 0) return 4;
  const quarter = value / 4;
  const magnitude = 10 ** Math.floor(Math.log10(quarter));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= quarter) ?? 10;
  return step * magnitude * 4;
}

/** Time of day on the 24-hour clock the tables use; seconds are shown when the whole range is short. */
function clock(us: number, withSeconds = false): string {
  return new Date(us / 1000).toLocaleTimeString(
    [],
    withSeconds
      ? { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
      : { hour: "2-digit", minute: "2-digit", hour12: false },
  );
}

const SHORT_RANGE_US = 10 * 60 * 1_000_000;

interface Hover {
  x: number;
  y: number;
  content: ReactNode;
}

function Tooltip({ hover }: { hover: Hover | null }) {
  if (!hover) return null;
  return (
    <div
      className="pointer-events-none absolute z-10 grid min-w-36 -translate-x-1/2 -translate-y-[calc(100%+10px)] gap-0.5 rounded-md border bg-popover px-2.5 py-2 text-base whitespace-nowrap text-popover-foreground shadow-md [&_i]:inline-block [&_i]:size-2.5 [&_i]:rounded-[0.1875rem] [&_span]:flex [&_span]:items-center [&_span]:gap-1.5"
      style={{ left: hover.x, top: hover.y }}
    >
      {hover.content}
    </div>
  );
}

/** A chart's folding: whether it is folded to its title, and what folds or unfolds it. */
interface Folding {
  folded: boolean;
  onFold: (folded: boolean) => void;
}

/** A chart's title: with `folding`, a button that folds the chart to it and opens it again. */
function FrameTitle({ title, folding }: { title: string; folding: Folding | undefined }) {
  if (!folding) return <span>{title}</span>;
  return (
    <button
      type="button"
      aria-expanded={!folding.folded}
      onClick={() => folding.onFold(!folding.folded)}
      className="-ml-1 inline-flex items-center gap-1 rounded-md px-1 hover:bg-accent"
    >
      <ChevronDownIcon
        aria-hidden="true"
        className={cn("size-4 text-muted-foreground transition-transform", folding.folded && "-rotate-90")}
      />
      {title}
    </button>
  );
}

type Plot = (width: number, setHover: (hover: Hover | null) => void) => ReactNode;

/** The chart, mounted only while it is open: it measures its width as it mounts. */
function FoldedPlot({ folded, children }: { folded: boolean; children: Plot }) {
  return folded ? null : <FramePlot>{children}</FramePlot>;
}

/** The chart itself, with its tooltip. */
function FramePlot({ children }: { children: Plot }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<Hover | null>(null);
  return (
    <div className="relative [&_svg]:block [&_svg]:overflow-visible" ref={ref} onPointerLeave={() => setHover(null)}>
      {children(width, setHover)}
      <Tooltip hover={hover} />
    </div>
  );
}

function Frame({
  title,
  legend,
  folding,
  children,
}: {
  title: string;
  legend?: ReactNode;
  /** The chart folds to its title from there, as the page keeps it. */
  folding?: Folding | undefined;
  children: (width: number, setHover: (hover: Hover | null) => void) => ReactNode;
}) {
  const folded = folding?.folded === true;
  return (
    <Card className={cn("m-0 gap-2 rounded-xl px-5 pt-4 pb-3 shadow-none", folded && "py-2.5")}>
      <div className="flex items-center justify-between gap-3 text-md font-semibold">
        <FrameTitle title={title} folding={folding} />
        {folded ? null : legend}
      </div>
      <FoldedPlot folded={folded}>{children}</FoldedPlot>
    </Card>
  );
}

function AxisY({
  max,
  width,
  format,
  height = HEIGHT,
}: {
  max: number;
  width: number;
  format: (value: number) => string;
  height?: number;
}) {
  const ticks = height < HEIGHT ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  const plot = height - PAD.top - PAD.bottom;
  return (
    <g className="[&_line]:stroke-(--dt-grid) [&_text]:fill-muted-foreground [&_text]:text-xs [&_text]:tabular-nums">
      {ticks.map((tick) => {
        const y = PAD.top + plot * (1 - tick);
        return (
          <g key={tick}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y} y2={y} />
            <text x={PAD.left - 8} y={y + 4} textAnchor="end">
              {tick === 0 ? "0" : format(max * tick)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function AxisX({
  series,
  width,
  height = HEIGHT,
}: {
  series: readonly { start: number; end: number }[];
  width: number;
  height?: number;
}) {
  const first = series[0];
  const last = series.at(-1);
  if (!first || !last) return null;
  const seconds = last.end - first.start < SHORT_RANGE_US;
  return (
    <g className="[&_line]:stroke-(--dt-grid) [&_text]:fill-muted-foreground [&_text]:text-xs [&_text]:tabular-nums">
      <text x={PAD.left} y={height - 6}>
        {clock(first.start, seconds)}
      </text>
      <text x={width - PAD.right} y={height - 6} textAnchor="end">
        {clock(last.end, seconds)}
      </text>
    </g>
  );
}

/* ---------- latency over time: p50 and p95 on one axis ---------- */

interface LegendItem {
  key: string;
  label: string;
  color?: string;
  className?: string;
}

/** Click a series to hide or show it; the last visible one stays. */
function useSeriesToggle(): [ReadonlySet<string>, (key: string, all: readonly LegendItem[]) => void] {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string, all: readonly LegendItem[]) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else if (all.filter((item) => !next.has(item.key)).length > 1) next.add(key);
      return next;
    });
  return [hidden, toggle];
}

function Legend({
  items,
  hidden,
  onToggle,
  extra,
}: {
  items: readonly LegendItem[];
  hidden: ReadonlySet<string>;
  onToggle: (key: string, all: readonly LegendItem[]) => void;
  extra?: ReactNode;
}) {
  return (
    <span className="flex items-center gap-1.5 text-base font-medium text-muted-foreground">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          aria-pressed={!hidden.has(item.key)}
          title={hidden.has(item.key) ? `Show ${item.label}` : `Hide ${item.label}`}
          onClick={() => onToggle(item.key, items)}
          className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-accent hover:text-foreground aria-[pressed=false]:opacity-45 aria-[pressed=false]:[&>span]:line-through"
        >
          <i
            className={cn("inline-block size-2.5 rounded-[0.1875rem]", item.className)}
            style={item.color ? { background: item.color } : undefined}
          />
          <span>{item.label}</span>
        </button>
      ))}
      {extra}
    </span>
  );
}

const LATENCY: LegendItem[] = [
  { key: "p50", label: "p50", color: P50 },
  { key: "p95", label: "p95", color: P95 },
];

export function LatencyChart({ series }: { series: Series }) {
  const [hidden, toggle] = useSeriesToggle();
  const showP50 = !hidden.has("p50");
  const showP95 = !hidden.has("p95");
  const legend = <Legend items={LATENCY} hidden={hidden} onToggle={toggle} />;
  return (
    <Frame title="Latency over time" legend={legend}>
      {(width, setHover) => {
        const max = niceMax(Math.max(...series.map((bucket) => (showP95 ? (bucket.p95 ?? 0) : (bucket.p50 ?? 0))), 1));
        const plotW = width - PAD.left - PAD.right;
        const plotH = HEIGHT - PAD.top - PAD.bottom;
        const x = (index: number) =>
          PAD.left + (series.length <= 1 ? plotW / 2 : (index / (series.length - 1)) * plotW);
        const y = (value: number) => PAD.top + plotH * (1 - value / max);
        const path = (pick: (bucket: Series[number]) => number | null) => {
          // Buckets without calls are skipped, not drawn as gaps: no traffic is not missing data.
          let d = "";
          series.forEach((bucket, index) => {
            const value = pick(bucket);
            if (value === null) return;
            d += `${d ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
          });
          return d;
        };
        let lastIndex = -1;
        series.forEach((bucket, index) => {
          if (bucket.p95 !== null) lastIndex = index;
        });
        const last = series[lastIndex];
        const points = series.flatMap((bucket, index) =>
          bucket.calls > 0 && series.filter((item) => item.calls > 0).length <= 20 ? [{ bucket, index }] : [],
        );
        return (
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label="p50 and p95 latency over time"
            onPointerMove={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              const index = Math.round(((event.clientX - box.left - PAD.left) / plotW) * (series.length - 1));
              const bucket = series[Math.min(Math.max(index, 0), series.length - 1)];
              if (!bucket || bucket.calls === 0) return setHover(null);
              setHover({
                x: x(series.indexOf(bucket)),
                y: PAD.top,
                content: (
                  <>
                    <b>
                      {clock(bucket.start)}–{clock(bucket.end)}
                    </b>
                    <span>
                      <i style={{ background: P50 }} />
                      p50 {duration(bucket.p50 ?? 0)}
                    </span>
                    <span>
                      <i style={{ background: P95 }} />
                      p95 {duration(bucket.p95 ?? 0)}
                    </span>
                    <span className="text-muted-foreground">
                      {bucket.calls} {bucket.calls === 1 ? "call" : "calls"}
                    </span>
                  </>
                ),
              });
            }}
          >
            <AxisY max={max} width={width} format={(value) => duration(value)} />
            <AxisX series={series} width={width} />
            {showP95 ? (
              <path
                d={path((bucket) => bucket.p95)}
                fill="none"
                style={{ stroke: P95 }}
                strokeWidth={2}
                strokeLinejoin="round"
              />
            ) : null}
            {showP50 ? (
              <path
                d={path((bucket) => bucket.p50)}
                fill="none"
                style={{ stroke: P50 }}
                strokeWidth={2}
                strokeLinejoin="round"
              />
            ) : null}
            {points.map(({ bucket, index }) => (
              <g key={bucket.start}>
                {showP95 ? (
                  <circle
                    cx={x(index)}
                    cy={y(bucket.p95 ?? 0)}
                    r={4}
                    style={{ fill: P95 }}
                    className="stroke-card stroke-2"
                  />
                ) : null}
                {showP50 ? (
                  <circle
                    cx={x(index)}
                    cy={y(bucket.p50 ?? 0)}
                    r={4}
                    style={{ fill: P50 }}
                    className="stroke-card stroke-2"
                  />
                ) : null}
              </g>
            ))}
            {last ? (
              <g className="[&_text]:fill-text-2 [&_text]:text-xs [&_text]:font-semibold">
                {/* p95 >= p50, so p95 sits above; keep the labels at least one line apart. */}
                {showP95 ? (
                  <text
                    x={x(lastIndex) + 8}
                    y={showP50 ? Math.min(y(last.p95 ?? 0) + 4, y(last.p50 ?? 0) + 4 - 14) : y(last.p95 ?? 0) + 4}
                  >
                    p95
                  </text>
                ) : null}
                {showP50 ? (
                  <text x={x(lastIndex) + 8} y={y(last.p50 ?? 0) + 4}>
                    p50
                  </text>
                ) : null}
              </g>
            ) : null}
          </svg>
        );
      }}
    </Frame>
  );
}

/** Where a bar chart's bars go: the plot's height, a slot per bar, a bar's width, the baseline, and which bar a
 * pointer is over. */
function barLayout(width: number, height: number, count: number) {
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const slot = plotW / Math.max(count, 1);
  const indexAt = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return Math.min(Math.max(Math.floor((event.clientX - box.left - PAD.left) / slot), 0), count - 1);
  };
  return { plotH, slot, barW: Math.max(Math.min(slot - 2, 18), 2), base: PAD.top + plotH, indexAt };
}

/* ---------- calls over time: bars, errors stacked on top; drag to pick a time range ---------- */

interface CallsChartProps {
  series: Series;
  title?: string;
  noun?: string;
  /** Called with the picked range [start, end) in epoch µs; enables click and drag selection. */
  onSelect?: ((start: number, end: number) => void) | undefined;
  /** Whether failed calls are a thing here: off for an N+1 or a slow query, where nothing "errors". */
  errors?: boolean;
}

export function CallsChart({
  series,
  title = "Calls over time",
  noun = "call",
  onSelect,
  errors = true,
}: CallsChartProps) {
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const plural = `${noun}s`;
  const [hidden, toggle] = useSeriesToggle();
  const showOk = !hidden.has("ok");
  const showErrors = errors && !hidden.has("errors");
  const items: LegendItem[] = [
    { key: "ok", label: plural, color: CALLS },
    ...(errors ? [{ key: "errors", label: "errors", className: "bg-error" }] : []),
  ];
  const legend = (
    <Legend
      items={items}
      hidden={hidden}
      onToggle={toggle}
      extra={onSelect ? <span className="pl-1.5 font-normal">drag to zoom</span> : null}
    />
  );
  return (
    <Frame title={title} legend={legend}>
      {(width, setHover) => {
        // Hidden layers drop out of the scale too, so what is left fills the chart.
        const visible = (bucket: Series[number]) =>
          (showOk ? bucket.calls - bucket.errors : 0) + (showErrors ? bucket.errors : 0);
        const max = niceCount(Math.max(...series.map(visible), 1));
        const { plotH, slot, barW, base, indexAt } = barLayout(width, HEIGHT, series.length);
        const low = drag ? Math.min(drag.from, drag.to) : 0;
        const high = drag ? Math.max(drag.from, drag.to) : 0;
        return (
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label={`${plural} and errors over time`}
            data-brush={onSelect ? "" : undefined}
            onPointerDown={(event) => {
              if (!onSelect || event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              const index = indexAt(event);
              setDrag({ from: index, to: index });
            }}
            onPointerMove={(event) => {
              if (drag) setDrag({ from: drag.from, to: indexAt(event) });
            }}
            onPointerUp={() => {
              const first = series[low];
              const last = series[high];
              if (drag && onSelect && first && last) onSelect(first.start, last.end);
              setDrag(null);
            }}
            onPointerCancel={() => setDrag(null)}
          >
            <AxisY max={max} width={width} format={(value) => String(Math.round(value))} />
            <AxisX series={series} width={width} />
            {drag ? (
              <rect
                className="fill-brand/15 stroke-brand/60"
                x={PAD.left + low * slot}
                y={PAD.top}
                width={(high - low + 1) * slot}
                height={plotH}
                rx={4}
              />
            ) : null}
            {series.map((bucket, index) => {
              if (bucket.calls === 0) return null;
              const left = PAD.left + index * slot + (slot - barW) / 2;
              const ok = showOk ? bucket.calls - bucket.errors : 0;
              const errors = showErrors ? bucket.errors : 0;
              const okH = (ok / max) * plotH;
              const errH = (errors / max) * plotH;
              return (
                <g
                  key={bucket.start}
                  onPointerEnter={() =>
                    setHover({
                      x: left + barW / 2,
                      y: base - okH - errH,
                      content: (
                        <>
                          <b>
                            {clock(bucket.start, true)}–{clock(bucket.end, true)}
                          </b>
                          <span>
                            {bucket.calls} {bucket.calls === 1 ? noun : plural}
                          </span>
                          {bucket.errors > 0 ? (
                            <span className="text-error">
                              {bucket.errors} {bucket.errors === 1 ? "error" : "errors"}
                            </span>
                          ) : null}
                          {bucket.slow > 0 ? <span className="text-muted-foreground">{bucket.slow} slow</span> : null}
                        </>
                      ),
                    })
                  }
                >
                  <rect x={left - 2} y={PAD.top} width={barW + 4} height={plotH} fill="transparent" />
                  {ok > 0 ? (
                    <rect x={left} y={base - okH} width={barW} height={okH} rx={2} style={{ fill: CALLS }} />
                  ) : null}
                  {errors > 0 ? (
                    <rect
                      x={left}
                      y={base - okH - errH - (ok > 0 ? 2 : 0)}
                      width={barW}
                      height={Math.max(errH, 2)}
                      rx={2}
                      className="fill-error"
                    />
                  ) : null}
                </g>
              );
            })}
          </svg>
        );
      }}
    </Frame>
  );
}

/* ---------- log records over time: a bar per slice, its levels stacked; drag to pick a time range ---------- */

/** The levels from the bottom of a bar up, each in the color its records' dot has in the table. */
const LOG_LEVELS: readonly (LegendItem & { levels: readonly string[] })[] = [
  { key: "debug", label: "debug", className: "bg-muted-foreground/50", levels: ["debug"] },
  { key: "info", label: "info", className: "bg-info", levels: ["info"] },
  { key: "warning", label: "warning", className: "bg-warn", levels: ["warning"] },
  { key: "error", label: "error", className: "bg-error", levels: ["error", "critical"] },
];

const FILL: Record<string, string> = {
  debug: "fill-muted-foreground/50",
  info: "fill-info",
  warning: "fill-warn",
  error: "fill-error",
};

/** The records of a slice in each level the legend shows, bottom up. */
function stacked(bucket: LogBucket, hidden: ReadonlySet<string>): { key: string; count: number }[] {
  return LOG_LEVELS.filter((level) => !hidden.has(level.key)).map((level) => ({
    key: level.key,
    count: level.levels.reduce((sum, name) => sum + (bucket.levels[name] ?? 0), 0),
  }));
}

/** A slice's tooltip: its time, then its records by level. */
/** A slice's time: from–to, or, for a slice under a second, when and how long. */
function sliceTime(start: number, end: number): string {
  const from = clock(start, true);
  const to = clock(end, true);
  return from === to ? `${from} · ${duration(end - start)}` : `${from}–${to}`;
}

function LogTip({ bucket }: { bucket: LogBucket }) {
  return (
    <>
      <b>{sliceTime(bucket.start, bucket.end)}</b>
      <span>
        {bucket.count} {bucket.count === 1 ? "record" : "records"}
      </span>
      {stacked(bucket, new Set()).map(({ key, count }) =>
        count > 0 ? (
          <span key={key} className={key === "error" ? "text-error" : key === "warning" ? "text-warn" : undefined}>
            {count} {key}
          </span>
        ) : null,
      )}
    </>
  );
}

/** Picking slices by dragging across them: the indexes from and to, while the pointer is down. */
function useBrush(count: number, onSelect: ((low: number, high: number) => void) | undefined) {
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const low = drag ? Math.min(drag.from, drag.to) : 0;
  const high = drag ? Math.max(drag.from, drag.to) : 0;
  const handlers = (indexAt: (event: React.PointerEvent<SVGSVGElement>) => number) =>
    onSelect === undefined || count === 0
      ? {}
      : {
          onPointerDown: (event: React.PointerEvent<SVGSVGElement>) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            const index = indexAt(event);
            setDrag({ from: index, to: index });
          },
          onPointerMove: (event: React.PointerEvent<SVGSVGElement>) => {
            if (drag) setDrag({ from: drag.from, to: indexAt(event) });
          },
          onPointerUp: () => {
            if (drag) onSelect(low, high);
            setDrag(null);
          },
          onPointerCancel: () => setDrag(null),
        };
  return { drag: drag !== null, low, high, handlers };
}

const LOG_HEIGHT = 132;

/**
 * Log records over time: a bar per slice of the period, its levels stacked, debug at the bottom and errors on top.
 * A level hides from the legend; with `onSelect`, a drag across the bars picks their time range [start, end) in µs.
 */
const readFolded = (raw: unknown): boolean => raw === true;

export function LogsChart({
  series,
  onSelect,
}: {
  series: readonly LogBucket[];
  onSelect?: ((start: number, end: number) => void) | undefined;
}) {
  const [hidden, toggle] = useSeriesToggle();
  // Folded to its title, as this browser last left it: room for more records.
  const [folded, setFolded] = useStored("tracepanel:logs:chart-folded", readFolded);
  const brush = useBrush(
    series.length,
    onSelect &&
      ((low, high) => {
        const first = series[low];
        const last = series[high];
        if (first && last) onSelect(first.start, last.end);
      }),
  );
  const legend = (
    <Legend
      items={LOG_LEVELS}
      hidden={hidden}
      onToggle={toggle}
      extra={onSelect ? <span className="pl-1.5 font-normal">drag to zoom</span> : null}
    />
  );
  return (
    <Frame title="Records over time" legend={legend} folding={{ folded, onFold: setFolded }}>
      {(width, setHover) => {
        const total = (bucket: LogBucket) => stacked(bucket, hidden).reduce((sum, level) => sum + level.count, 0);
        const max = niceCount(Math.max(...series.map(total), 1));
        const { plotH, slot, barW, base, indexAt } = barLayout(width, LOG_HEIGHT, series.length);
        return (
          <svg
            width={width}
            height={LOG_HEIGHT}
            role="img"
            aria-label="Log records over time, by level"
            data-brush={onSelect ? "" : undefined}
            {...brush.handlers(indexAt)}
          >
            <AxisY max={max} width={width} height={LOG_HEIGHT} format={(value) => String(Math.round(value))} />
            <AxisX series={series} width={width} height={LOG_HEIGHT} />
            {brush.drag ? (
              <rect
                className="fill-brand/15 stroke-brand/60"
                x={PAD.left + brush.low * slot}
                y={PAD.top}
                width={(brush.high - brush.low + 1) * slot}
                height={plotH}
                rx={4}
              />
            ) : null}
            {series.map((bucket, index) => {
              const left = PAD.left + index * slot + (slot - barW) / 2;
              return (
                <LogBar
                  key={bucket.start}
                  levels={stacked(bucket, hidden)}
                  left={left}
                  width={barW}
                  base={base}
                  scale={plotH / max}
                  onHover={() =>
                    // An empty slice has nothing to say.
                    setHover(
                      bucket.count > 0
                        ? {
                            x: left + barW / 2,
                            y: base - total(bucket) * (plotH / max),
                            content: <LogTip bucket={bucket} />,
                          }
                        : null,
                    )
                  }
                  hitTop={PAD.top}
                  hitHeight={plotH}
                />
              );
            })}
          </svg>
        );
      }}
    </Frame>
  );
}

/** A slice's bar: its levels stacked bottom up, with a hit area the slice's full height for its tooltip. */
function LogBar({
  levels,
  left,
  width,
  base,
  scale,
  onHover,
  hitTop,
  hitHeight,
}: {
  levels: readonly { key: string; count: number }[];
  left: number;
  width: number;
  base: number;
  scale: number;
  onHover: () => void;
  hitTop: number;
  hitHeight: number;
}) {
  let top = base;
  return (
    <g onPointerEnter={onHover}>
      <rect x={left - 2} y={hitTop} width={width + 4} height={hitHeight} fill="transparent" />
      {levels.map(({ key, count }) => {
        if (count === 0) return null;
        const height = Math.max(count * scale, 2);
        top -= height;
        return <rect key={key} x={left} y={top} width={width} height={height} rx={1.5} className={FILL[key]} />;
      })}
    </g>
  );
}

/* ---------- latency distribution ---------- */

export function Histogram({
  histogram,
  p50,
  p95,
}: {
  histogram: readonly HistogramBucket[];
  p50: number;
  p95: number;
}) {
  return (
    <Frame title="Latency distribution">
      {(width, setHover) => {
        const max = niceCount(Math.max(...histogram.map((bucket) => bucket.count), 1));
        const plotW = width - PAD.left - PAD.right;
        const plotH = HEIGHT - PAD.top - PAD.bottom;
        const slot = plotW / Math.max(histogram.length, 1);
        const base = PAD.top + plotH;
        const xOf = (us: number) => {
          const index = histogram.findIndex((bucket) => us >= bucket.from && us < bucket.to);
          const bucket = histogram[index];
          if (!bucket || index < 0) return null;
          const within = bucket.to > bucket.from ? (us - bucket.from) / (bucket.to - bucket.from) : 0.5;
          return PAD.left + (index + within) * slot;
        };
        const markers = [
          { label: "p50", value: p50, color: P50, row: 0 },
          { label: "p95", value: p95, color: P95, row: 1 },
        ];
        return (
          <svg width={width} height={HEIGHT} role="img" aria-label="How many calls took how long">
            <AxisY max={max} width={width} format={(value) => String(Math.round(value))} />
            {histogram.map((bucket, index) => {
              const h = (bucket.count / max) * plotH;
              const left = PAD.left + index * slot + 1;
              return (
                <g
                  key={bucket.from}
                  onPointerEnter={() =>
                    setHover({
                      x: left + slot / 2,
                      y: base - h,
                      content: (
                        <>
                          <b>
                            {duration(bucket.from)} – {duration(bucket.to)}
                          </b>
                          <span>
                            {bucket.count} {bucket.count === 1 ? "call" : "calls"}
                          </span>
                        </>
                      ),
                    })
                  }
                >
                  <rect x={left - 1} y={PAD.top} width={slot} height={plotH} fill="transparent" />
                  {bucket.count > 0 ? (
                    <rect
                      x={left}
                      y={base - h}
                      width={Math.max(slot - 2, 1)}
                      height={h}
                      rx={2}
                      style={{ fill: CALLS }}
                      opacity={0.75}
                    />
                  ) : null}
                </g>
              );
            })}
            {markers.map((marker) => {
              const x = xOf(marker.value);
              if (x === null) return null;
              return (
                <g key={marker.label} className="[&_text]:fill-text-2 [&_text]:text-xs [&_text]:font-semibold">
                  <line
                    x1={x}
                    x2={x}
                    y1={PAD.top}
                    y2={base}
                    style={{ stroke: marker.color }}
                    strokeWidth={2}
                    strokeDasharray="4 3"
                  />
                  <text x={x + 4} y={PAD.top + 10 + marker.row * 16}>
                    {marker.label} {duration(marker.value)}
                  </text>
                </g>
              );
            })}
            {histogram[0] ? (
              <g className="[&_line]:stroke-(--dt-grid) [&_text]:fill-muted-foreground [&_text]:text-xs [&_text]:tabular-nums">
                <text x={PAD.left} y={HEIGHT - 6}>
                  {duration(histogram[0].from)}
                </text>
                <text x={width - PAD.right} y={HEIGHT - 6} textAnchor="end">
                  {duration(histogram.at(-1)?.to ?? 0)}
                </text>
              </g>
            ) : null}
          </svg>
        );
      }}
    </Frame>
  );
}

/* ---------- stat tile ---------- */

/**
 * Stat tiles in one row; where they don't fit, in two even rows (8 as 4 and 4, 7 as 4 and 3), then two a row: never
 * one left alone on a row of its own.
 */
export function StatGrid({ label, className, children }: { label?: string; className?: string; children: ReactNode }) {
  const count = Children.toArray(children).length;
  const style = { "--stats": count, "--stats-half": Math.ceil(count / 2) } as CSSProperties;
  return (
    <section
      className={cn(
        "grid grid-cols-[repeat(var(--stats),minmax(0,1fr))] gap-2.5 max-[1280px]:grid-cols-[repeat(var(--stats-half),minmax(0,1fr))] max-[640px]:grid-cols-2",
        className,
      )}
      style={style}
      aria-label={label}
    >
      {children}
    </section>
  );
}

const STAT = "grid content-start gap-1.5 rounded-xl border bg-card px-5 py-4";

export function Stat({
  label,
  value,
  sub,
  tone,
  onClick,
}: {
  label: string;
  value: string;
  sub?: string | undefined;
  tone?: "warn" | "error" | undefined;
  /** Makes the tile a button, e.g. to filter by what it counts. */
  onClick?: (() => void) | undefined;
}) {
  const body = (
    <>
      <span className="text-base font-medium text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-4xl leading-tight font-semibold tracking-[-0.02em] tabular-nums",
          tone === "warn" && "text-warn",
          tone === "error" && "text-error",
        )}
      >
        {value}
      </span>
      {sub ? <span className="text-base text-text-2">{sub}</span> : null}
    </>
  );
  return onClick ? (
    <button
      type="button"
      className={cn(STAT, "cursor-pointer text-left hover:border-input hover:bg-accent")}
      onClick={onClick}
    >
      {body}
    </button>
  ) : (
    <div className={STAT}>{body}</div>
  );
}
