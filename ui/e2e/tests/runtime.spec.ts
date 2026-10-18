// What served a trace, read from the label the SDKs send: its mark and its name, as the widget and the console show it.
import { runtimeKind, runtimeName } from "../../packages/ui/src/lib/runtime.ts";
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
