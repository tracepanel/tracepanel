import { createContext, useContext, useEffect, useState } from "react";
import type { Trace } from "./types";

/**
 * How the console learns whether a trace's app profiles a request when asked (its hello says so), and, in the panel,
 * how to ask: its Profile toggle, turned on from where the trace's time says nothing recorded what ran.
 */
export interface Profiling {
  /** Whether the connected app of a service profiles on request; none where nothing can say (a snapshot). */
  profiles?: ((service: string) => Promise<boolean>) | undefined;
  /** Turns profiling on for this browser's next requests (the panel's toggle); none on the console's page. */
  turnOn?: (() => void) | undefined;
}

export const ProfilingContext = createContext<Profiling>({});

// What each app answered, once: every trace of it asks the same.
const answered = new Map<string, Promise<boolean>>();

/**
 * Whether Profile can be offered for this trace: its app is connected and profiles on request. Not known, not
 * offered: an SDK that doesn't profile, an app that turned it off, one that isn't connected.
 */
export function useProfilingOf(trace: Trace): { available: boolean; turnOn: (() => void) | undefined } {
  const { profiles, turnOn } = useContext(ProfilingContext);
  const service = trace.attrs["service.name"];
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!profiles || typeof service !== "string") return;
    let current = true;
    const asked = answered.get(service) ?? profiles(service).catch(() => false);
    answered.set(service, asked);
    asked.then((yes) => current && setAvailable(yes));
    return () => {
      current = false;
    };
  }, [profiles, service]);
  return { available, turnOn };
}
