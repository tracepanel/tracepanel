import { createContext, useContext } from "react";

/**
 * Whether the trace's app profiles a request when asked, and, in the panel, how to ask: its Profile toggle, turned on
 * from where the trace's time says nothing recorded what ran.
 */
export interface Profiling {
  /** The app profiles on request (its hello says so); unknown, it is taken to. */
  available: boolean;
  /** Turns profiling on for this browser's next requests (the panel's toggle); none on the console's page. */
  turnOn?: (() => void) | undefined;
}

export const ProfilingContext = createContext<Profiling>({ available: true });

export function useProfiling(): Profiling {
  return useContext(ProfilingContext);
}
