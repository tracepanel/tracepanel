// One load at a time of the same thing: the panel's list, the trace's tabs and its call tree each ask for a trace's
// chain (and the trace, and its links) on their own clocks, often at once. An ask while the same one is in flight
// shares its answer instead of fetching it again; the next ask after it answered fetches anew (the answer may have
// grown: a service's trace arrives after its caller's). The agent's ETag makes that one cheap when nothing changed.
import type { DataSource } from "@tracepanel/ui";

/** `load`, its calls with the same key while one is in flight sharing that one's answer. */
function shared<T>(load: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const flying = new Map<string, Promise<T>>();
  return (key) => {
    const asked = flying.get(key);
    if (asked) return asked;
    const answer = load(key);
    flying.set(key, answer);
    const forget = () => {
      if (flying.get(key) === answer) flying.delete(key);
    };
    answer.then(forget, forget);
    return answer;
  };
}

/** The source, its loads of a trace, its chain and its links shared while in flight. */
export function sharingLoads(source: DataSource): DataSource {
  const chain = source.chain?.bind(source);
  return {
    ...source,
    getTrace: shared((id) => source.getTrace(id)),
    related: shared((id) => source.related(id)),
    ...(chain ? { chain: shared((id) => chain(id)) } : {}),
  };
}
