// Library frames named by the package they belong to: what a reader scans for ("faststream", "sqlalchemy"), not
// every module on the way down, which never fits on one line.

/** Namespaces that start a package's name rather than make it: com.acme.web is acme's, not com's. */
const DOMAINS = new Set(["com", "org", "io", "net", "dev", "co", "me", "ai", "app"]);

/** The package a frame's module is in: faststream for faststream._internal.endpoint, net/http for net/http.(*conn). */
export function packageOf(module: string): string {
  if (module.startsWith("@")) return module.split("/").slice(0, 2).join("/");
  return module.includes("/") ? pathPackage(module) : dottedPackage(module);
}

/** A Python or JVM module: its first part, or its first two under a domain (org.springframework). */
function dottedPackage(module: string): string {
  const [first = module, second] = module.split(".");
  return second !== undefined && DOMAINS.has(first) ? `${first}.${second}` : first;
}

/** A Go or Node module path: up to its last part's first dot (net/http, github.com/acme/kit, express/lib/router). */
function pathPackage(module: string): string {
  const slash = module.lastIndexOf("/");
  const dot = module.indexOf(".", slash + 1);
  return dot === -1 ? module : module.slice(0, dot);
}

/** The packages of these modules, in the order they first appear, each with how many frames it has. */
export function packageCounts(modules: readonly string[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const module of modules) {
    const name = packageOf(module);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count }));
}

/** One line for a group of library frames: "faststream ×9 · sqlalchemy". */
export function packagesLine(modules: readonly string[]): string {
  return packageCounts(modules)
    .map(({ name, count }) => (count > 1 ? `${name} ×${count}` : name))
    .join(" · ");
}
