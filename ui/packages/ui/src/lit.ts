// One hover, lit wherever it shows: a segment of a bar (the trace's time, a lane's calls, the Profile tab's packages)
// and its item in the legend under it, both ways. Hovering a segment lights it and its legend item; hovering the
// legend item lights every segment of it. The look is the CSS's ([data-lit]): a ring in the segment's own colour.
import type { FocusEvent, PointerEvent } from "react";

/**
 * What ties a segment to its legend item: the same key. `all` marks the legend item, which lights every segment of
 * its key; a segment lights itself and its legend item.
 */
export function litKey(key: string | undefined, all = false): Record<`data-${string}`, string | undefined> {
  return key === undefined ? {} : { "data-lit-key": key, "data-lit-all": all ? "" : undefined };
}

/**
 * Lights what `from` is (or nothing): a segment and its legend item, or a legend item and every segment of it, the
 * others stepping back then (the scope's `data-lighting`) so a share in many small pieces stands out.
 */
function light(scope: HTMLElement, from: EventTarget | null): void {
  for (const element of scope.querySelectorAll("[data-lit]")) element.removeAttribute("data-lit");
  scope.removeAttribute("data-lighting");
  const over = from instanceof Element ? from.closest<HTMLElement>("[data-lit-key]") : null;
  if (!(over && scope.contains(over))) return;
  const same = [...scope.querySelectorAll<HTMLElement>("[data-lit-key]")].filter(
    (element) => element.dataset["litKey"] === over.dataset["litKey"],
  );
  const lit = "litAll" in over.dataset ? same : [over, ...same.filter((element) => "litAll" in element.dataset)];
  for (const element of lit) element.setAttribute("data-lit", "");
  if ("litAll" in over.dataset) scope.setAttribute("data-lighting", "");
}

/** The handlers of what holds a bar and its legend: the pointer or the focus on one lights its kind in both. */
export const litScope = {
  onPointerOver: (event: PointerEvent<HTMLElement>) => light(event.currentTarget, event.target),
  onPointerLeave: (event: PointerEvent<HTMLElement>) => light(event.currentTarget, null),
  onFocus: (event: FocusEvent<HTMLElement>) => light(event.currentTarget, event.target),
  onBlur: (event: FocusEvent<HTMLElement>) => light(event.currentTarget, null),
};
