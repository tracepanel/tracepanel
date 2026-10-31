// What served a page: the framework when it is one we name, else the language.
// Plain data, no React: the console's panel and the page widget both draw from it.

/**
 * Each runtime a label can name: its name, and the letters of its monogram, the badge we draw for it. A monogram is
 * ours: two letters in the console's own type on a faint square, in the theme's icon colour, no brand's shape or
 * colour (drawn by the .dt-monogram style, the console's and the widget's).
 */
const RUNTIMES = {
  django: { name: "Django", letters: "Dj" },
  fastapi: { name: "FastAPI", letters: "FA" },
  flask: { name: "Flask", letters: "Fl" },
  starlette: { name: "Starlette", letters: "St" },
  falcon: { name: "Falcon", letters: "Fc" },
  aiohttp: { name: "aiohttp", letters: "ai" },
  python: { name: "Python", letters: "Py" },
  go: { name: "Go", letters: "Go" },
  gin: { name: "Gin", letters: "Gi" },
  echo: { name: "Echo", letters: "Ec" },
  grpc: { name: "gRPC", letters: "gR" },
  express: { name: "Express", letters: "Ex" },
  fastify: { name: "Fastify", letters: "Fy" },
  koa: { name: "Koa", letters: "Ko" },
  hono: { name: "Hono", letters: "Ho" },
  nestjs: { name: "NestJS", letters: "Ns" },
  nextjs: { name: "Next.js", letters: "Nx" },
  nuxt: { name: "Nuxt", letters: "Nu" },
  node: { name: "Node.js", letters: "Nd" },
  bun: { name: "Bun", letters: "Bn" },
  deno: { name: "Deno", letters: "Dn" },
  browser: { name: "Browser", letters: "Br" },
  spring: { name: "Spring", letters: "Sp" },
  springboot: { name: "Spring Boot", letters: "SB" },
  ktor: { name: "Ktor", letters: "Kt" },
  quarkus: { name: "Quarkus", letters: "Qk" },
  java: { name: "Java", letters: "J" },
  kotlin: { name: "Kotlin", letters: "Kl" },
  aspnet: { name: "ASP.NET Core", letters: "AS" },
  dotnet: { name: ".NET", letters: ".N" },
  rails: { name: "Rails", letters: "Rl" },
  ruby: { name: "Ruby", letters: "Rb" },
  laravel: { name: "Laravel", letters: "Lv" },
  symfony: { name: "Symfony", letters: "Sf" },
  php: { name: "PHP", letters: "Ph" },
  phoenix: { name: "Phoenix", letters: "Px" },
  elixir: { name: "Elixir", letters: "El" },
  erlang: { name: "Erlang", letters: "Er" },
  actix: { name: "Actix Web", letters: "Ax" },
  rocket: { name: "Rocket", letters: "Rk" },
  rust: { name: "Rust", letters: "Rs" },
  vapor: { name: "Vapor", letters: "Vp" },
  swift: { name: "Swift", letters: "Sw" },
  cpp: { name: "C++", letters: "C+" },
} as const satisfies Record<string, { name: string; letters: string }>;

/** The runtimes a label can name. */
export type RuntimeKind = keyof typeof RUNTIMES;

/** Every runtime a label can name, for the tests that check each one has a mark. */
export const RUNTIME_KINDS = Object.keys(RUNTIMES) as RuntimeKind[];

/** An owner's logo, drawn unaltered: its path, its box, and its own colours (a radial gradient's stops). */
export interface BrandLogo {
  viewBox: string;
  path: string;
  /** The gradient's centre and radius, in the box's units. */
  gradient: { cx: number; cy: number; r: number; stops: readonly (readonly [offset: number, color: string])[] };
}

/**
 * How a runtime is drawn: its owner's logo where the owner's policy lets a tool show it to refer to the runtime, our
 * neutral globe for a page in the browser (no browser's brand), else its monogram.
 */
export type RuntimeMark =
  | { type: "logo"; logo: BrandLogo }
  | { type: "browser" }
  | { type: "monogram"; letters: string };

// A logo shows only where its owner's published policy allows it, unaltered, in a third party's product to refer to
// the runtime; ui/packages/ui/src/icons/BRANDS.md lists each brand, its policy and the condition we follow. Kotlin's
// allows its icon "among other programming languages icons to refer to Kotlin language": the icon from the Kotlin
// Foundation's own kit (kotlin_logos.zip, "Kotlin icon.svg"), its shape and colours as published.
const LOGOS: Partial<Record<RuntimeKind, BrandLogo>> = {
  kotlin: {
    viewBox: "0 0 48 48",
    path: "M48 48H0V0H48L23.505 23.6475L48 48Z",
    gradient: {
      cx: 48,
      cy: 0,
      r: 48,
      stops: [
        [0, "#E44857"],
        [0.504494, "#C711E1"],
        [1, "#7F52FF"],
      ],
    },
  },
};

/** How a runtime is drawn: its owner's logo where allowed, the globe for the browser, else our monogram. */
export function runtimeMark(kind: RuntimeKind): RuntimeMark {
  const logo = LOGOS[kind];
  if (logo) return { type: "logo", logo };
  if (kind === "browser") return { type: "browser" };
  return { type: "monogram", letters: RUNTIMES[kind].letters };
}

// lucide's globe (ISC), a page in the browser: the console's GlobeIcon, drawn in the page widget too.
export const BROWSER_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>';

// Names as the SDKs write them in the label, matched whatever their case: the Go SDK writes "gin", "echo", "grpc".
const FRAMEWORKS = new Map<string, RuntimeKind>([
  ["Django", "django"],
  ["FastAPI", "fastapi"],
  ["Flask", "flask"],
  ["Starlette", "starlette"],
  ["Express", "express"],
  ["NestJS", "nestjs"],
  ["Next.js", "nextjs"],
  ["Nuxt", "nuxt"],
  ["Spring Boot", "springboot"],
  ["Spring", "spring"],
  ["Ktor", "ktor"],
  ["Quarkus", "quarkus"],
  ["ASP.NET", "aspnet"],
  ["Rails", "rails"],
  ["Laravel", "laravel"],
  ["Symfony", "symfony"],
  ["Phoenix", "phoenix"],
  ["Actix", "actix"],
  ["Rocket", "rocket"],
  ["Vapor", "vapor"],
  ["Fastify", "fastify"],
  ["Koa", "koa"],
  ["Hono", "hono"],
  ["Gin", "gin"],
  ["Echo", "echo"],
  ["gRPC", "grpc"],
  ["aiohttp", "aiohttp"],
  ["Falcon", "falcon"],
]);
const LANGUAGES = new Map<string, RuntimeKind>([
  ["Python", "python"],
  ["Go", "go"],
  ["Node", "node"],
  ["Bun", "bun"],
  ["Browser", "browser"],
  ["Java", "java"],
  ["Kotlin", "kotlin"],
  [".NET", "dotnet"],
  ["Ruby", "ruby"],
  ["PHP", "php"],
  ["Rust", "rust"],
  ["Elixir", "elixir"],
  ["Erlang", "erlang"],
  ["Swift", "swift"],
  ["C++", "cpp"],
  ["Deno", "deno"],
]);
const FRAMEWORKS_BY_CASE = new Map([...FRAMEWORKS].map(([name, kind]) => [name.toLowerCase(), kind]));

/**
 * Reads the label the SDKs send, "Python 3.12 · Django 6.0", "Node 26 · Next.js 16.4" or "Go 1.27 · net/http".
 * A plain ASGI or WSGI app, or Go's net/http, is no framework named here: it is its language; Bun.serve is Bun.
 */
export function runtimeKind(label: string): RuntimeKind | null {
  const [language = "", framework = ""] = label.split(" · ");
  const words = framework.split(" ");
  // A name of two words first: "Spring Boot 4.1" is Spring Boot, a plain Spring MVC app (from OpenTelemetry) Spring.
  const named = (name: string) => FRAMEWORKS_BY_CASE.get(name.toLowerCase());
  const frameworkKind = named(words.slice(0, 2).join(" ")) ?? named(words[0] ?? "");
  const [languageName = ""] = language.split(" ");
  return frameworkKind ?? LANGUAGES.get(languageName) ?? null;
}

const FRAMEWORK_KINDS: ReadonlySet<RuntimeKind> = new Set(FRAMEWORKS.values());

/** How much a label says of what runs an app: a framework (Django) over its language alone (Python), over nothing. */
function specificity(label: string): number {
  const kind = runtimeKind(label);
  if (kind === null) return 0;
  return FRAMEWORK_KINDS.has(kind) ? 2 : 1;
}

/**
 * What runs a service, one label wherever it shows (the Services page, its map, its page, the app switcher): of what
 * its roles say (its web role "Python 3.14 · Django 6.0", its worker "Python 3.14"), the one that says most, its
 * framework, the newest of those. Never the busiest role's, so its icon doesn't change with the traffic.
 */
export function serviceRuntime(runtimes: readonly (string | null | undefined)[]): string | null {
  const labels = runtimes.filter((label): label is string => Boolean(label));
  const ranked = [...labels].sort(
    (a, b) => specificity(b) - specificity(a) || b.localeCompare(a, undefined, { numeric: true }),
  );
  return ranked[0] ?? null;
}

type Attrs = Record<string, unknown>;

// JavaScript runtimes that aren't Node, by OpenTelemetry's process.runtime.name.
const RUNTIME_NAMES: Record<string, string> = { bun: "Bun", deno: "Deno" };

const LANGUAGE_NAMES: Record<string, string> = {
  nodejs: "Node",
  webjs: "Browser",
  python: "Python",
  go: "Go",
  dotnet: ".NET",
  cpp: "C++",
  php: "PHP",
};

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** A trace's language as people say it: OpenTelemetry's nodejs is Node, or Bun when Bun runs it; webjs the browser. */
function languageName(attrs: Attrs): string | undefined {
  const language = textOf(attrs["telemetry.sdk.language"]);
  if (!language) return undefined;
  return RUNTIME_NAMES[String(attrs["process.runtime.name"])] ?? named(language);
}

/** A language as people write it: OpenTelemetry's dotnet is .NET; the rest capitalized. */
function named(language: string): string {
  return LANGUAGE_NAMES[language] ?? `${language[0]?.toUpperCase()}${language.slice(1)}`;
}

/** The implementation when it isn't the language's own: (cpython), not (node) under Node or (bun) under Bun. */
function implementation(attrs: Attrs, language: string): string | undefined {
  const name = textOf(attrs["process.runtime.name"]);
  return name && !["node", "bun", "deno", language.toLowerCase()].includes(name.toLowerCase())
    ? `(${name})`
    : undefined;
}

/** The language's version: a Kotlin app names Kotlin's own; the JVM's is process.runtime.version. */
function languageVersion(attrs: Attrs): string | undefined {
  return textOf(attrs["tracepanel.language.version"]) ?? textOf(attrs["process.runtime.version"]);
}

/**
 * What ran a trace, as the SDKs label a page's runtime: "Node 26.11.1 · Express 5.3.0"; `detailed` names the
 * implementation too, as the panel does: "Python 3.14.0 (cpython) · Django 6.1".
 */
export function traceRuntime(attrs: Attrs, detailed = false): string | undefined {
  const language = languageName(attrs);
  if (!language) return undefined;
  const version = languageVersion(attrs);
  const runtime = [language, version, detailed ? implementation(attrs, language) : undefined].filter(Boolean).join(" ");
  const framework = textOf(attrs["tracepanel.framework"]);
  return framework ? `${runtime} · ${framework}` : runtime;
}

export function runtimeName(kind: RuntimeKind): string {
  return RUNTIMES[kind].name;
}
