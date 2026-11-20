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
  projects: [
    { name: "chromium", testIgnore: ["perf/**", "webkit/**"], use: { ...devices["Desktop Chrome"], colorScheme: "dark" } },
    // What only WebKit (the app's webview on macOS and Linux) gets wrong, in WebKit
    // (`pnpm test:webkit`). Chromium runs everything else.
    { name: "webkit", testMatch: "webkit/**/*.spec.ts", use: { ...devices["Desktop Safari"], colorScheme: "dark" } },
    // Large responses keep the window responsive (`pnpm test:perf`). One step
    // at a time, so steps don't skew each other's timings (one worker: not
    // fully parallel still runs each file in a worker of its own), and with longer
    // waits than usual, as each one handles 50 MB bodies. PERF_CPU_THROTTLE
    // slows the page's CPU (see e2e/perf/large-response.spec.ts).
    {
      name: "perf",
      metadata: { cpuThrottle: Number(process.env.PERF_CPU_THROTTLE ?? 1) },
      testMatch: "perf/**/*.spec.ts",
      fullyParallel: false,
      workers: 1,
      timeout: 180_000,
      expect: { timeout: 60_000 },
      use: { ...devices["Desktop Chrome"], colorScheme: "dark" },
    },
  ],
  // Builds the mock's WASM core first (the dev server would build it on the first
  // page load, but a cold build can outlast a test's timeout).
  webServer: {
    command: `pnpm build:wasm && pnpm exec vite --port ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
