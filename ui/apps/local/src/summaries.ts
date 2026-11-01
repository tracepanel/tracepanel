import type { DataSource, TraceSummary } from "@tracepanel/ui";
import { useEffect, useState } from "react";

/** Traces by their id, as the agent lists them: loaded again when the ids change. */
export function useSummaries(ids: readonly string[], source: DataSource): ReadonlyMap<string, TraceSummary> {
  const key = ids.join(",");
  const [found, setFound] = useState<ReadonlyMap<string, TraceSummary>>(() => new Map());
  // biome-ignore lint/correctness/useExhaustiveDependencies: the ids, by their key.
  useEffect(() => {
    if (!ids.length) return;
    let current = true;
    source.listTraces({ ids, limit: ids.length }).then(
      (traces) => current && setFound(new Map(traces.map((trace) => [trace.id, trace]))),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [key, source]);
  return found;
}
