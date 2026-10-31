// What served a trace, read from the label the SDKs send: its mark and its name, as the widget and the console show it.
import {
  RUNTIME_KINDS,
  runtimeKind,
  runtimeMark,
  runtimeName,
  serviceRuntime,
} from "../../packages/ui/src/lib/runtime.ts";
import { expect, test } from "../fixtures.ts";

test("a framework of two words is named whole; Spring alone stays Spring", () => {
  const labels = [
    "Java 21 · Spring Boot 4.1",
    "Java 21 · Spring 7.0",
    "Kotlin 2.3 · Ktor 3.4",
    "Python 3.12 · Django 6.0",
    "Node 26 · Next.js 16.4",
    "Go 1.27 · net/http",
  ];

  const names = labels.map((label) => {
    const kind = runtimeKind(label);
    return kind && runtimeName(kind);
  });

  expect(names).toEqual(["Spring Boot", "Spring", "Ktor", "Django", "Next.js", "Go"]);
});

test("a service's runtime is the one that names its framework, whatever order its roles come in", () => {
  const web = "Python 3.12 · Django 6.0";
  const worker = "Python 3.12";

  expect(serviceRuntime([worker, web])).toBe(web);
  expect(serviceRuntime([web, worker, null])).toBe(web);
  // Mid-upgrade, the newer one.
  expect(serviceRuntime(["Python 3.12 · Django 6.0", "Python 3.13 · Django 6.1"])).toBe("Python 3.13 · Django 6.1");
  expect(serviceRuntime([worker, null])).toBe(worker);
  expect(serviceRuntime([null, undefined])).toBeNull();
});

test("a label's mark is its framework's, else its language's, else none: the caller's plain app icon", () => {
  const labels = [
    "Python 3.14 · Django 6.0",
    "Python 3.14 · FastAPI 0.120",
    "Python 3.14 · Flask 3.1",
    "Python 3.14 · Starlette 0.48",
    "Python 3.14 · Falcon 4.1",
    "Python 3.14",
    "Python 3.14 · SomethingNew 1.0",
    "Node 26 · Express 5.3.0",
    "Node 26 · Fastify 5.6",
    "Node 26 · Koa 3.0",
    "Node 26 · Hono 4.9",
    "Node 26 · NestJS 11.1",
    "Node 26 · Next.js 16.4",
    "Node 26 · Nuxt 4.2",
    "Node 26",
    "Bun 1.3",
    "Deno 2.5",
    "Browser",
    "Java 21 · Spring Boot 4.1",
    "Java 21",
    "Kotlin 2.3 · Ktor 3.4",
    "Kotlin 2.3",
    "Go 1.27 · gin",
    "Go 1.27 · echo",
    "Go 1.27 · grpc",
    "Go 1.27 · net/http",
    "Rust 1.91",
    "Cobol 85",
  ];

  const marks = labels.map((label) => {
    const kind = runtimeKind(label);
    if (kind === null) return null;
    const mark = runtimeMark(kind);
    return [runtimeName(kind), mark.type === "monogram" ? mark.letters : mark.type];
  });

  expect(marks).toEqual([
    ["Django", "Dj"],
    ["FastAPI", "FA"],
    ["Flask", "Fl"],
    ["Starlette", "St"],
    ["Falcon", "Fc"],
    ["Python", "Py"],
    ["Python", "Py"],
    ["Express", "Ex"],
    ["Fastify", "Fy"],
    ["Koa", "Ko"],
    ["Hono", "Ho"],
    ["NestJS", "Ns"],
    ["Next.js", "Nx"],
    ["Nuxt", "Nu"],
    ["Node.js", "Nd"],
    ["Bun", "Bn"],
    ["Deno", "Dn"],
    ["Browser", "browser"],
    ["Spring Boot", "SB"],
    ["Java", "J"],
    ["Ktor", "Kt"],
    ["Kotlin", "logo"],
    ["Gin", "Gi"],
    ["Echo", "Ec"],
    ["gRPC", "gR"],
    ["Go", "Go"],
    ["Rust", "Rs"],
    null,
  ]);
});

test("only Kotlin's logo shows, in its own colours; every other runtime has a monogram of its own", () => {
  const logos = RUNTIME_KINDS.filter((kind) => runtimeMark(kind).type === "logo");
  const letters = RUNTIME_KINDS.flatMap((kind) => {
    const mark = runtimeMark(kind);
    return mark.type === "monogram" ? [mark.letters] : [];
  });

  expect(logos).toEqual(["kotlin"]);
  expect(runtimeMark("kotlin")).toEqual({
    type: "logo",
    logo: {
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
  });

  expect(new Set(letters).size).toBe(letters.length);
  expect(letters.every((one) => one.length >= 1 && one.length <= 2)).toBe(true);
});
