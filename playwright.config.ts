import { defineConfig, devices } from "@playwright/test";

// Browser tests: the real UI under the Vite dev server, outside Tauri, so it
// runs against the mocked backend in src/dev/mock.ts. Run with `pnpm test:e2e`.
// Uses its own port (not 1420) so it never reuses a `pnpm dev` you already have
// running, possibly from another checkout. Override with E2E_PORT.
const port = Number(process.env.E2E_PORT ?? 1430);

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
  },
  // A dark OS appearance, so the System theme (the default) renders the dark
  // design that most tests were written against. Tests change it with
  // `page.emulateMedia({ colorScheme })`.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], colorScheme: "dark" } }],
  webServer: {
    command: `pnpm exec vite --port ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
