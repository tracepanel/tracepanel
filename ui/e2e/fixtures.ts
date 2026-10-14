// Every test fails on what a person wouldn't see but would suffer from: an error in the page's console, an
// exception the page didn't catch, a call to the API that failed.
import { test as base, expect } from "@playwright/test";

export const test = base.extend<{ problems: string[] }>({
  problems: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on("console", (message) => {
        // The browser's own line for any answer of 4xx or 5xx: a 400 for a bad search is the console working, and
        // a failed call is caught below, by its answer.
        if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
          problems.push(`console: ${message.text()}`);
        }
      });
      page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));
      page.on("response", (response) => {
        // The console's and the agent's answers: a test app's own API (/app/, app.ts) fails on purpose.
        const own = new URL(response.url()).pathname.startsWith("/app/");
        if (response.status() >= 500 && !own) problems.push(`${response.status()} ${response.url()}`);
      });
      await use(problems);
      expect(problems, "the page's console, uncaught errors and failed calls").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
