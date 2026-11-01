// biome-ignore-all lint/style/useNamingConvention: the trace format's field names.
// "Your code" is the app's own frames only, as a Node and a JVM app send them: a stack with none of them is the
// library code it was running, alone, never the worker's, the runtime's or OpenTelemetry's frames on the way there;
// the packages are named as their ecosystems name them (org.springframework, @opentelemetry/sdk-trace-base, not org).
import type { Page } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { expect, test } from "../fixtures.ts";

const NODE = "01M4PR0F0WN000000000000N01";
const JVM = "01M4PR0F0WN000000000000J01";

const frame = (fn: string, module: string | null, file: string, inApp: boolean) => ({
  function: fn,
  module,
  file,
  line: 1,
  in_app: inApp,
});

/** A BullMQ job's profile as tracepanel-js sends it: the job's own code under the worker's, and the runtime alone. */
function nodeTask(start: number): object {
  return {
    id: NODE,
    kind: "task",
    name: "rankProducts",
    start,
    duration: 10_000,
    status: "ok",
    attrs: { "service.name": "node-worker", "telemetry.sdk.language": "nodejs" },
    spans: [
      {
        id: "r",
        parent_id: null,
        kind: "task",
        name: "rankProducts",
        start,
        duration: 10_000,
        status: "ok",
        attrs: {},
      },
    ],
    logs: [],
    errors: [],
    links: [],
    issues: [],
    profile: {
      interval_us: 1000,
      samples: 10,
      frames: [
        frame("processTicksAndRejections", null, "node:internal/process/task_queues", false),
        frame("callback", null, "bullmq/dist/cjs/classes/worker.js", false),
        frame("rankProducts", null, "worker.ts", true),
        frame("editDistance", null, "lib/search.ts", true),
        frame("listOnTimeout", null, "node:internal/timers", false),
        frame("export", null, "@opentelemetry/sdk-trace-base/build/src/export/BatchSpanProcessorBase.js", false),
        frame("serialize", null, "@opentelemetry/otlp-transformer/build/src/index.js", false),
      ],
      stacks: [
        { frames: [0, 1, 2, 3], count: 6 },
        { frames: [4, 5, 6], count: 4 },
      ],
    },
  };
}

/** A Spring request's profile as tracepanel-java sends it: the controller under Tomcat's and Spring's frames. */
function jvmRequest(start: number): object {
  return {
    id: JVM,
    kind: "http",
    name: "GET /api/catalog/products",
    start,
    duration: 10_000,
    status: "ok",
    attrs: {
      "service.name": "spring-shop",
      "http.method": "GET",
      "http.route": "/api/catalog/products",
      "http.status_code": 200,
      "telemetry.sdk.language": "java",
    },
    spans: [
      {
        id: "r",
        parent_id: null,
        kind: "http",
        name: "GET /api/catalog/products",
        start,
        duration: 10_000,
        status: "ok",
        attrs: {},
      },
    ],
    logs: [],
    errors: [],
    links: [],
    issues: [],
    profile: {
      interval_us: 1000,
      samples: 10,
      frames: [
        frame("Thread.run", "java.lang.Thread", "java/lang/Thread.java", false),
        frame(
          "DispatcherServlet.doDispatch",
          "org.springframework.web.servlet.DispatcherServlet",
          "org/springframework/web/servlet/DispatcherServlet.java",
          false,
        ),
        frame(
          "CatalogController.listProducts",
          "shop.catalog.CatalogController",
          "src/main/java/shop/catalog/CatalogController.java",
          true,
        ),
        frame(
          "SimpleJpaRepository.findAll",
          "org.springframework.data.jpa.repository.support.SimpleJpaRepository",
          "org/springframework/data/jpa/repository/support/SimpleJpaRepository.java",
          false,
        ),
        frame("Unsafe.park", "jdk.internal.misc.Unsafe", "jdk/internal/misc/Unsafe.java", false),
        frame(
          "ScheduledThreadPoolExecutor$DelayedWorkQueue.take",
          "java.util.concurrent.ScheduledThreadPoolExecutor$DelayedWorkQueue",
          "java/util/concurrent/ScheduledThreadPoolExecutor.java",
          false,
        ),
      ],
      stacks: [
        { frames: [0, 1, 2, 3], count: 7 },
        { frames: [0, 5, 4], count: 3 },
      ],
    },
  };
}

async function seed(): Promise<void> {
  const start = Date.now() * 1000 - 4 * 3_600_000_000;
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([nodeTask(start), jvmRequest(start + 20_000)]),
  });
  expect(response.status).toBe(202);
  await expect.poll(async () => (await fetch(`${CONSOLE}api/traces/${JVM}`)).status).toBe(200);
}

/** The functions the flame graph draws, as its boxes name them. */
async function boxes(page: Page): Promise<string[]> {
  const labels = await page
    .getByRole("region", { name: "Flame graph" })
    .getByRole("button")
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") ?? ""));
  return labels.map((label) => label.split(" ")[0] ?? "").sort();
}

test.beforeEach(seed);

test("a Node task's code is its own frames: the runtime and OpenTelemetry alone are their innermost frame", async ({
  page,
}) => {
  await page.goto(`/#/t/${NODE}?tab=profile`);

  await expect(page.getByRole("tab", { name: "Your code", selected: true })).toBeVisible();
  await expect.poll(() => boxes(page)).toEqual(["editDistance", "rankProducts", "serialize"]);
  await expect(page.getByRole("region", { name: "Time by package" }).getByRole("button")).toHaveText([
    /^your code\s*6 ms/,
    /^@opentelemetry\/otlp-transformer\s*4 ms/,
  ]);

  await page.getByRole("tab", { name: "All frames" }).click();

  await expect.poll(() => boxes(page)).toContain("processTicksAndRejections");
});

test("a JVM request's code is its packages': Spring's and the JDK's frames are not yours", async ({ page }) => {
  await page.goto(`/#/t/${JVM}?tab=profile`);

  await expect
    .poll(() => boxes(page))
    .toEqual(["CatalogController.listProducts", "SimpleJpaRepository.findAll", "Unsafe.park"]);
  await expect(page.getByRole("region", { name: "Time by package" }).getByRole("button")).toHaveText([
    /^org\.springframework\s*7 ms/,
    /^jdk\s*3 ms/,
  ]);
});
