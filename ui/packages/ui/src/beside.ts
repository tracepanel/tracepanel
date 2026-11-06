import { createContext, useContext } from "react";

/**
 * Shown beside the panel's waterfall: what its rows or the details' own title already say is left out (a database's
 * alias, a scope's summary and filters, a profile's heading), and tables are dense.
 */
export const Beside = createContext(false);

export function useBeside(): boolean {
  return useContext(Beside);
}
