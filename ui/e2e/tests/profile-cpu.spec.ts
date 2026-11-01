// biome-ignore-all lint/style/useNamingConvention: the trace format's field names.
// A Go request's profile, as tracepanel-go sends it: runtime/pprof samples the CPU only, so its 30 samples are 30 ms
// on the CPU of a 99 ms request, and the rest of its time, waiting on Postgres, is waiting, as a Python or a JVM
// profile has its waits. The header says it is CPU time.
import type { Page } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { expect, test } from "../fixtures.ts";

const GO = "01M4PR0F11E00000000000C0G1";

function goRequest(start: number): object {
  const frame = (fn: string, module: string, file: string, inApp: boolean) => ({
    function: fn,
    module,
    file,
    line: 1,
    in_app: inApp,
  });
  return {
    id: GO,
    kind: "http",
    name: "GET /api/catalog/products",
    start,
    duration: 99_000,
    status: "ok",
    attrs: {
      "service.name": "go-shop",
      "http.method": "GET",
      "http.route": "/api/catalog/products",
      "http.status_code": 200,
      "telemetry.sdk.language": "go",
    },
    spans: [
      {
        id: "r",
        parent_id: null,
        kind: "http",
        name: "GET /api/catalog/products",
        start,
        duration: 99_000,
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
      samples: 30,
      dropped: 0,
      frames: [
        frame("(*App).listProducts", "github.com/acme/shop", "catalog.go", true),
        frame("(*App).similar", "github.com/acme/shop", "similar.go", true),
        frame("editDistance", "github.com/acme/shop", "similar.go", true),
        frame("syscall.syscall", "syscall", "syscall/syscall_darwin.go", false),
        frame("runtime.mallocgc", "runtime", "runtime/malloc.go", false),
      ],
      stacks: [
        { frames: [0, 1, 2], count: 25 },
        { frames: [0, 3], count: 3 },
        { frames: [4], count: 2 },
      ],
    },
  };
}

async function seed(): Promise<void> {
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([goRequest(Date.now() * 1000 - 4 * 3_600_000_000)]),
  });
  expect(response.status).toBe(202);
  await expect.poll(async () => (await fetch(`${CONSOLE}api/traces/${GO}`)).status).toBe(200);
}

function shares(page: Page) {
  return page.getByRole("region", { name: "Time by package" }).getByRole("button");
}

test.beforeEach(seed);

test("a Go profile is its time on the CPU; the rest of the request's time waited", async ({ page }) => {
  await page.goto(`/#/t/${GO}?tab=profile`);

  await expect(page.getByText("on the CPU of the trace's 99 ms")).toBeVisible();
  await expect(page.getByText("30 samples, one every 1 ms of CPU time; waiting isn't sampled")).toBeVisible();
  await expect(shares(page)).toHaveText([
    /^your code\s*28 ms\s*28%/,
    /^framework & runtime\s*2 ms\s*2%/,
    /^waiting\s*69 ms\s*70%/,
  ]);
  await expect(
    page.getByRole("region", { name: "Flame graph" }).getByRole("button", { name: /^off the CPU/ }),
  ).toBeVisible();
});
