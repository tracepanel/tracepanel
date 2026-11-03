// The browser tab's list as the widget keeps it and hands it to the panel (`tracepanel:tab`): each page load, view,
// action and request of the tab, with what the widget knows of it before (or instead of) its trace. One contract for
// the two sides: the widget writes it, the panel's list reads it.

/** What a row of the tab says on its own (the widget's summary): the panel shows it before its trace is stored. */
export interface EntrySummary {
  name: string;
  status: number | null;
  /** Unix epoch microseconds. */
  start: number;
  /** Microseconds. */
  duration: number;
  queries: number;
  issues: number;
  /** Which findings (n+1, duplicates…), once the agent has them: the panel's row names them before its trace loads. */
  kinds?: string[] | undefined;
  /** Sent by htmx: the element that sent it, where the answer went, whether it loaded a page. */
  htmx?: HtmxInfo | undefined;
  /** A view or an action recorded in the browser (tracepanel-js), not a request: its requests come under it. */
  kind?: "page" | undefined;
  failed?: boolean | undefined;
  /**
   * In flight (lib/live): a request the page still waits for (its id the widget's own, "~" and a number, until its
   * answer names its trace), or a view still open. Its time ticks from `start`.
   */
  open?: boolean | undefined;
  /** An open view whose calls have all answered: its time stops here (epoch µs, the last answer) until it ends. */
  until?: number | undefined;
  /** A view the SPA was sent to at once from another route ("/sms-campaigns"), which left the list for it. */
  redirectedFrom?: string | undefined;
  /**
   * A call of a view or an action that answered without Tracepanel's headers (a gateway's, a service's over OTLP): no
   * trace of its own to list (its id stays the widget's); the view's trace has it, and its row stands until that
   * trace does.
   */
  untraced?: boolean | undefined;
  /** The id it had while in flight ("~…"): its row keeps that identity from in flight to stored. */
  key?: string | undefined;
  /** The host a request went to ("api.example.com:8443"): a view's calls are grouped by it. */
  host?: string | undefined;
  /**
   * A request that flew: when the page made it and when its answer came (epoch µs), as the browser timed it. Its row
   * says the time the page waited for it (never less than its server's), in flight, answered and stored alike.
   */
  clock?: { start: number; end: number } | undefined;
  /** The W3C span id the call carried on, when the widget saw it: the call's identity in its view's trace. */
  span?: string | undefined;
}

/** What htmx says about a request it sent. */
export interface HtmxInfo {
  /** The element that sent it, as people see it: its label, its text, its id. */
  trigger?: string | undefined;
  /** Where htmx swaps the answer: "#rows-todo". */
  target?: string | undefined;
  /** A boosted link or form: a page load done by htmx. */
  boosted?: boolean | undefined;
}

/** A row of the tab: a page load or a view (parent null), or a request, an action or a call under one. */
export interface TabEntry {
  id: string;
  parent: string | null;
  summary?: EntrySummary | undefined;
}
