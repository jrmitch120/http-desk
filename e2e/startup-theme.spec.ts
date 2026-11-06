// The page is in the saved theme before settings arrive over IPC. In the app,
// theme.rs injects src-tauri/src/theme-boot.js as the window's initialization
// script; here the same file runs as a Playwright init script, and the mock
// holds settings back (`?settingsDelay=hold`) until the test lets them through,
// so it can look at the page in the window where it used to flash dark. The app
// replaces the file's `__THEME__` placeholder with the setting; the test defines
// it as a global.
import { expect, test, type Page } from "@playwright/test";

const BOOT = "src-tauri/src/theme-boot.js";
const BG = { dark: "rgb(28, 29, 32)", light: "rgb(243, 244, 246)" };

/** The theme on `<html>` at the page's first animation frame. */
const recordFirstFrame = () => {
  requestAnimationFrame(() => {
    (window as unknown as { __firstFrameTheme?: string }).__firstFrameTheme = document.documentElement.dataset.theme ?? "none";
  });
};

async function startApp(page: Page, theme: string, os: "light" | "dark", boot = true) {
  await page.emulateMedia({ colorScheme: os });
  await page.addInitScript(recordFirstFrame);
  if (boot) {
    await page.addInitScript((t) => ((window as unknown as { __THEME__: string }).__THEME__ = t), theme);
    await page.addInitScript({ path: BOOT });
  }
  await page.goto(`/?theme=${theme}&settingsDelay=hold`);
  await page.waitForFunction(() => "__mock" in window && "__firstFrameTheme" in window);
}

type Mock = { settingsServed: boolean; releaseSettings: () => void };
const releaseSettings = (page: Page) => page.evaluate(() => (window as unknown as { __mock: Mock }).__mock.releaseSettings());

/** What the page shows now, and whether settings have arrived yet. */
const snapshot = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __firstFrameTheme?: string; __mock: Mock };
    return {
      settingsServed: w.__mock.settingsServed,
      firstFrame: w.__firstFrameTheme,
      theme: document.documentElement.dataset.theme ?? "none",
      background: getComputedStyle(document.body).backgroundColor,
    };
  });

const cases: { theme: string; os: "light" | "dark"; expected: "light" | "dark" }[] = [
  { theme: "light", os: "dark", expected: "light" },
  { theme: "light", os: "light", expected: "light" },
  { theme: "dark", os: "light", expected: "dark" },
  { theme: "dark", os: "dark", expected: "dark" },
  { theme: "system", os: "light", expected: "light" },
  { theme: "system", os: "dark", expected: "dark" },
];

for (const { theme, os, expected } of cases) {
  test(`starts ${expected} with theme ${theme} on a ${os} OS, before settings arrive`, async ({ page }) => {
    await startApp(page, theme, os);
    expect(await snapshot(page)).toEqual({ settingsServed: false, firstFrame: expected, theme: expected, background: BG[expected] });
    // The store agrees once settings arrive.
    await releaseSettings(page);
    await expect.poll(async () => (await snapshot(page)).settingsServed).toBe(true);
    await expect(page.locator("html")).toHaveAttribute("data-theme", expected);
  });
}

test("leaves frames alone (Windows runs the script in subframes too)", async ({ page }) => {
  await page.route("**/frame.html", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body>frame</body></html>" }));
  await startApp(page, "light", "dark");
  await page.evaluate(
    () =>
      new Promise((loaded) => {
        const frame = document.createElement("iframe");
        frame.src = "/frame.html";
        frame.onload = loaded;
        document.body.append(frame);
      }),
  );
  const frame = page.frames().find((f) => f.url().endsWith("/frame.html"))!;
  expect(await frame.evaluate(() => document.documentElement.dataset.theme ?? "none")).toBe("none");
  expect((await snapshot(page)).theme).toBe("light");
});

test("without the start-up script a light theme would flash dark (the bug this guards)", async ({ page }) => {
  await startApp(page, "light", "dark", false);
  expect(await snapshot(page)).toEqual({ settingsServed: false, firstFrame: "none", theme: "none", background: BG.dark });
  // Once settings arrive the store applies the theme.
  await releaseSettings(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
