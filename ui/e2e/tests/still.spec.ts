// Nothing in the widget moves while nothing is on its way: the pill at rest, its card's shimmer only while the card
// shows and loads, the closed panel's hourglass (a trace on its way) stopped until it opens again. Motion stays for
// what is in flight, and reduced motion (Playwright's default here) stops that too.
import type { Page } from "@playwright/test";
import { openApp, pill, records, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

test.use({ reducedMotion: "no-preference" });

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A trace id from this moment that the agent doesn't have: a trace on its way. */
function arrivingId(): string {
  let time = Date.now();
  let head = "";
  for (let i = 0; i < 10; i++) {
    head = CROCKFORD[time % 32] + head;
    time = Math.floor(time / 32);
  }
  return `${head}${"W".repeat(16)}`;
}

/** The animations running on the page, its widget's shadow root and the panel's frame: what each animates. */
async function running(page: Page): Promise<string[]> {
  const found: string[] = [];
  for (const frame of page.frames()) {
    found.push(
      ...(await frame.evaluate(() => {
        const names: string[] = [];
        const walk = (root: Document | ShadowRoot) => {
          for (const animation of root.getAnimations()) {
            if (animation.playState !== "running") continue;
            const css = animation as CSSAnimation & CSSTransition;
            names.push(css.animationName ?? css.transitionProperty);
          }
          for (const element of root.querySelectorAll("*")) if (element.shadowRoot) walk(element.shadowRoot);
        };
        walk(document);
        return names;
      })),
    );
  }
  return found;
}

test("the pill and its card are still once a request is shown, and after the card was seen", async ({ page }) => {
  const id = await traceId("GET /");
  await openApp(page, { home: { status: 200, trace: id, queries: 3, totalMs: 28 } });
  await page.getByRole("button", { name: "Load home" }).click();

  await expect.poll(() => running(page)).toEqual([]);

  await pill(page).hover();
  await page.mouse.move(10, 10);

  await expect.poll(() => running(page)).toEqual([]);
  // Still, Playwright clicks it as it is.
  await pill(page).click({ timeout: 2000 });
});

test("a card loading a request shimmers while it shows, and stops when it hides", async ({ page }) => {
  const id = await traceId("GET /");
  // The agent slow to answer: the card loads for as long as the test holds its answer.
  let answer: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  await page.route(`**/api/traces/${id}*`, async (route) => {
    await held;
    await route.continue().catch(() => undefined);
  });
  await openApp(page, { home: { status: 200, trace: id, queries: 0, totalMs: 5 } });
  await page.getByRole("button", { name: "Load home" }).click();
  await pill(page).hover();

  await expect.poll(() => running(page)).toContain("card-shimmer");

  await page.mouse.move(10, 10);

  await expect.poll(() => running(page)).toEqual([]);
  answer();
});

test("the closed panel's hourglass stops, and turns again when the panel opens", async ({ page }) => {
  await openApp(page, { soon: { status: 200, trace: arrivingId(), queries: 0, totalMs: 5 } });
  await page.getByRole("button", { name: "Load soon" }).click();
  await pill(page).click();

  // Its record waits for its trace, its row's mark of that turning.
  await expect(records(page).first()).toBeVisible();
  await expect.poll(async () => (await running(page)).length).toBeGreaterThan(0);

  await pill(page).click();

  await expect.poll(() => running(page)).toEqual([]);

  await pill(page).click();

  await expect.poll(async () => (await running(page)).length).toBeGreaterThan(0);
});
