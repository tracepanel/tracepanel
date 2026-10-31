// What served a trace, read from the label the SDKs send: its mark and its name, as the widget and the console show it.
import { runtimeKind, runtimeName, serviceRuntime } from "../../packages/ui/src/lib/runtime.ts";
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
