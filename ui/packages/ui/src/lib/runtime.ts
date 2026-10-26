// What served a page: the framework when it is one we name, else the language.
// Plain data, no React: the console's panel and the page widget both draw from it.

/** The runtimes a label can name. */
export type RuntimeKind =
  | "django"
  | "fastapi"
  | "flask"
  | "python"
  | "go"
  | "express"
  | "nestjs"
  | "nextjs"
  | "nuxt"
  | "node"
  | "bun"
  | "browser"
  | "spring"
  | "springboot"
  | "ktor"
  | "quarkus"
  | "java"
  | "kotlin"
  | "aspnet"
  | "rails"
  | "laravel"
  | "symfony"
  | "phoenix"
  | "actix"
  | "rocket"
  | "vapor"
  | "fastify"
  | "koa"
  | "hono"
  | "gin"
  | "aiohttp"
  | "falcon"
  | "dotnet"
  | "ruby"
  | "php"
  | "rust"
  | "elixir"
  | "erlang"
  | "swift"
  | "cpp"
  | "deno";

const NAMES: Record<RuntimeKind, string> = {
  django: "Django",
  fastapi: "FastAPI",
  flask: "Flask",
  python: "Python",
  go: "Go",
  express: "Express",
  nestjs: "NestJS",
  nextjs: "Next.js",
  nuxt: "Nuxt",
  node: "Node.js",
  bun: "Bun",
  browser: "Browser",
  spring: "Spring",
  springboot: "Spring Boot",
  ktor: "Ktor",
  quarkus: "Quarkus",
  java: "Java",
  kotlin: "Kotlin",
  aspnet: "ASP.NET Core",
  rails: "Rails",
  laravel: "Laravel",
  symfony: "Symfony",
  phoenix: "Phoenix",
  actix: "Actix Web",
  rocket: "Rocket",
  vapor: "Vapor",
  fastify: "Fastify",
  koa: "Koa",
  hono: "Hono",
  gin: "Gin",
  aiohttp: "aiohttp",
  falcon: "Falcon",
  dotnet: ".NET",
  ruby: "Ruby",
  php: "PHP",
  rust: "Rust",
  elixir: "Elixir",
  erlang: "Erlang",
  swift: "Swift",
  cpp: "C++",
  deno: "Deno",
};

/** A runtime's mark: its path in a 24 px box, in its owner's colour or, for a mark of our own, in currentColor. */
export interface RuntimeMark {
  path: string;
  color?: string;
}

// Only the marks whose owners let a tool show them, unaltered, to say it supports their runtime: Go's and Rails' brand
// pages say so, Node.js's (OpenJS) allows referential use. Paths and colours from Simple Icons 16.34.0 (CC0-1.0) and
// never recoloured. Every other runtime is named in text beside a plain app icon: Spring, Java, .NET, Swift and others
// reserve their logos, and a recoloured one is a modified logo.
const RUNTIME_MARKS: Partial<Record<RuntimeKind, RuntimeMark>> = {
  go: {
    color: "#00ADD8",
    path: "M1.811 10.231c-.047 0-.058-.023-.035-.059l.246-.315c.023-.035.081-.058.128-.058h4.172c.046 0 .058.035.035.07l-.199.303c-.023.036-.082.07-.117.07zM.047 11.306c-.047 0-.059-.023-.035-.058l.245-.316c.023-.035.082-.058.129-.058h5.328c.047 0 .07.035.058.07l-.093.28c-.012.047-.058.07-.105.07zm2.828 1.075c-.047 0-.059-.035-.035-.07l.163-.292c.023-.035.07-.07.117-.07h2.337c.047 0 .07.035.07.082l-.023.28c0 .047-.047.082-.082.082zm12.129-2.36c-.736.187-1.239.327-1.963.514-.176.046-.187.058-.34-.117-.174-.199-.303-.327-.548-.444-.737-.362-1.45-.257-2.115.175-.795.514-1.204 1.274-1.192 2.22.011.935.654 1.706 1.577 1.835.795.105 1.46-.175 1.987-.77.105-.13.198-.27.315-.434H10.47c-.245 0-.304-.152-.222-.35.152-.362.432-.97.596-1.274a.315.315 0 01.292-.187h4.253c-.023.316-.023.631-.07.947a4.983 4.983 0 01-.958 2.29c-.841 1.11-1.94 1.8-3.33 1.986-1.145.152-2.209-.07-3.143-.77-.865-.655-1.356-1.52-1.484-2.595-.152-1.274.222-2.419.993-3.424.83-1.086 1.928-1.776 3.272-2.02 1.098-.2 2.15-.07 3.096.571.62.41 1.063.97 1.356 1.648.07.105.023.164-.117.2m3.868 6.461c-1.064-.024-2.034-.328-2.852-1.029a3.665 3.665 0 01-1.262-2.255c-.21-1.32.152-2.489.947-3.529.853-1.122 1.881-1.706 3.272-1.95 1.192-.21 2.314-.095 3.33.595.923.63 1.496 1.484 1.648 2.605.198 1.578-.257 2.863-1.344 3.962-.771.783-1.718 1.273-2.805 1.495-.315.06-.63.07-.934.106zm2.78-4.72c-.011-.153-.011-.27-.034-.387-.21-1.157-1.274-1.81-2.384-1.554-1.087.245-1.788.935-2.045 2.033-.21.912.234 1.835 1.075 2.21.643.28 1.285.244 1.905-.07.923-.48 1.425-1.228 1.484-2.233z",
  },
  rails: {
    color: "#D30001",
    path: "M.741 19.365h8.36s-1.598-7.291 3.693-10.243l.134-.066c1.286-.637 4.907-2.431 10.702 1.854.19-.159.37-.286.37-.286s-5.503-5.492-11.63-4.878c-3.079.275-6.867 3.079-9.09 6.783C1.058 16.233.741 19.365.741 19.365Zm8.804-.783a10.682 10.682 0 0 1-.127-1.333l1.143.412c.063.498.159.963.254 1.376l-1.27-.455Zm-7.799-4.317L.529 13.82c-.201.455-.423.984-.529 1.27l1.217.444c.137-.359.36-.878.529-1.269Zm7.831.296.857.677c.042-.413.116-.825.222-1.238l-.762-.603c-.137.391-.233.783-.317 1.164Zm2.042-2.646-.508-.762c.191-.243.413-.486.656-.709l.476.72a5.958 5.958 0 0 0-.624.751ZM4.19 8.878l.752.656c-.254.265-.498.551-.72.836l-.815-.698c.244-.265.508-.529.783-.794Zm9.799 1.027-.243-.73c.265-.117.571-.233.931-.339l.233.698a6.82 6.82 0 0 0-.921.371Zm3.122-.656.042-.667c.339.021.688.064 1.048.138l-.042.656a5.859 5.859 0 0 0-1.048-.127ZM8.942 6.392l-.476-.731c-.265.138-.54.286-.826.455l.487.741c.275-.169.54-.328.815-.465Zm9.217-.053.042-.709c-.095-.053-.36-.18-1.026-.371l-.043.699c.349.116.688.243 1.027.381ZM13.238 5.28h.106l-.212-.645c-.328 0-.666.021-1.016.063l.201.625a8.87 8.87 0 0 1 .921-.043Z",
  },
  node: {
    color: "#5FA04E",
    path: "M11.998,24c-0.321,0-0.641-0.084-0.922-0.247l-2.936-1.737c-0.438-0.245-0.224-0.332-0.08-0.383 c0.585-0.203,0.703-0.25,1.328-0.604c0.065-0.037,0.151-0.023,0.218,0.017l2.256,1.339c0.082,0.045,0.197,0.045,0.272,0l8.795-5.076 c0.082-0.047,0.134-0.141,0.134-0.238V6.921c0-0.099-0.053-0.192-0.137-0.242l-8.791-5.072c-0.081-0.047-0.189-0.047-0.271,0 L3.075,6.68C2.99,6.729,2.936,6.825,2.936,6.921v10.15c0,0.097,0.054,0.189,0.139,0.235l2.409,1.392 c1.307,0.654,2.108-0.116,2.108-0.89V7.787c0-0.142,0.114-0.253,0.256-0.253h1.115c0.139,0,0.255,0.112,0.255,0.253v10.021 c0,1.745-0.95,2.745-2.604,2.745c-0.508,0-0.909,0-2.026-0.551L2.28,18.675c-0.57-0.329-0.922-0.945-0.922-1.604V6.921 c0-0.659,0.353-1.275,0.922-1.603l8.795-5.082c0.557-0.315,1.296-0.315,1.848,0l8.794,5.082c0.57,0.329,0.924,0.944,0.924,1.603 v10.15c0,0.659-0.354,1.273-0.924,1.604l-8.794,5.078C12.643,23.916,12.324,24,11.998,24z M19.099,13.993 c0-1.9-1.284-2.406-3.987-2.763c-2.731-0.361-3.009-0.548-3.009-1.187c0-0.528,0.235-1.233,2.258-1.233 c1.807,0,2.473,0.389,2.747,1.607c0.024,0.115,0.129,0.199,0.247,0.199h1.141c0.071,0,0.138-0.031,0.186-0.081 c0.048-0.054,0.074-0.123,0.067-0.196c-0.177-2.098-1.571-3.076-4.388-3.076c-2.508,0-4.004,1.058-4.004,2.833 c0,1.925,1.488,2.457,3.895,2.695c2.88,0.282,3.103,0.703,3.103,1.269c0,0.983-0.789,1.402-2.642,1.402 c-2.327,0-2.839-0.584-3.011-1.742c-0.02-0.124-0.126-0.215-0.253-0.215h-1.137c-0.141,0-0.254,0.112-0.254,0.253 c0,1.482,0.806,3.248,4.655,3.248C17.501,17.007,19.099,15.91,19.099,13.993z",
  },
  // A page in the browser (tracepanel-js's recording): our own window with its tab bar, no browser's brand.
  browser: {
    path: "M3 3h18a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 6v10h18V9H3zm2-4a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm3 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm3 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2z",
  },
};

/** The runtime's mark where its owner allows one, else none: the caller shows the plain app icon. */
export function runtimeMark(kind: RuntimeKind): RuntimeMark | undefined {
  return RUNTIME_MARKS[kind];
}

// lucide's app-window (ISC), the icon of an app with no mark: the console's AppWindowIcon, drawn in the page widget too.
export const APP_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/></svg>';

// Names as the SDKs write them in the label.
const FRAMEWORKS = new Map<string, RuntimeKind>([
  ["Django", "django"],
  ["FastAPI", "fastapi"],
  ["Flask", "flask"],
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

/**
 * Reads the label the SDKs send, "Python 3.12 · Django 6.0", "Node 26 · Next.js 16.4" or "Go 1.27 · net/http".
 * A plain ASGI or WSGI app or Starlette is no framework named here: it is Python; Bun.serve is Bun.
 */
export function runtimeKind(label: string): RuntimeKind | null {
  const [language = "", framework = ""] = label.split(" · ");
  const words = framework.split(" ");
  // A name of two words first: "Spring Boot 4.1" is Spring Boot, a plain Spring MVC app (from OpenTelemetry) Spring.
  const frameworkKind = FRAMEWORKS.get(words.slice(0, 2).join(" ")) ?? FRAMEWORKS.get(words[0] ?? "");
  const [languageName = ""] = language.split(" ");
  return frameworkKind ?? LANGUAGES.get(languageName) ?? null;
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
  return NAMES[kind];
}
