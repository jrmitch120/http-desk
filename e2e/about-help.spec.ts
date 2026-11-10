// About HttpDesk and the Help menu's links (#103). The mock answers `app_info`
// with version 0.9.8 on the forced platform, and records the URLs the opener
// was asked to open (`openedUrls`), refusing any its capability doesn't allow.
import { expect, test, type Page } from "@playwright/test";
import { menuClick, mockState, openApp } from "./helpers";

const DOCS = "https://github.com/jrmitch120/http-desk#readme";
const RELEASES = "https://github.com/jrmitch120/http-desk/releases";

/** Records clipboard writes instead of touching the real clipboard. */
async function recordClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void w.__copied.push(text), readText: async () => w.__copied.at(-1) ?? "" },
    });
  });
}

const copied = (page: Page) => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
const about = (page: Page) => page.getByRole("dialog", { name: "About HttpDesk" });

test.describe("About HttpDesk", () => {
  test("the about menu item opens it with the app's version, copyright and links", async ({ page }) => {
    await openApp(page);
    await menuClick(page, "about");

    const modal = about(page);
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("heading", { name: "HttpDesk", exact: true })).toBeVisible();
    await expect(modal.getByText("Version 0.9.8")).toBeVisible();
    await expect(modal.getByText(/© 2026 Jeff Mitchell/)).toBeVisible();
    await expect(modal.getByRole("button", { name: "Documentation" })).toBeVisible();
    await expect(modal.getByRole("button", { name: "Release Notes" })).toBeVisible();
  });

  test("Copy copies the version, OS and architecture and says so", async ({ page }) => {
    await recordClipboard(page);
    await openApp(page);
    await menuClick(page, "about");

    await about(page).getByRole("button", { name: "Copy" }).click();
    expect(await copied(page)).toEqual(["HttpDesk 0.9.8 (macos aarch64)"]);
    await expect(page.locator(".toast", { hasText: "Version copied" })).toBeVisible();
  });

  test("on Windows, Copy names Windows", async ({ page }) => {
    await recordClipboard(page);
    await openApp(page, "?platform=windows");
    await menuClick(page, "about");

    await about(page).getByRole("button", { name: "Copy" }).click();
    expect(await copied(page)).toEqual(["HttpDesk 0.9.8 (windows x86_64)"]);
  });

  test("its links open the documentation and release notes in the browser", async ({ page }) => {
    await openApp(page);
    await menuClick(page, "about");

    await about(page).getByRole("button", { name: "Documentation" }).click();
    await about(page).getByRole("button", { name: "Release Notes" }).click();
    await expect.poll(() => mockState(page, "openedUrls")).toEqual([DOCS, RELEASES]);
  });

  test("Escape closes it", async ({ page }) => {
    await openApp(page);
    await menuClick(page, "about");
    await expect(about(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(about(page)).toBeHidden();
  });
});

test.describe("the Help menu", () => {
  test("Documentation and Release Notes open the README and GitHub Releases", async ({ page }) => {
    await openApp(page);
    await menuClick(page, "documentation");
    await expect.poll(() => mockState(page, "openedUrls")).toEqual([DOCS]);

    await menuClick(page, "release-notes");
    await expect.poll(() => mockState(page, "openedUrls")).toEqual([DOCS, RELEASES]);
  });

  test("Report an Issue opens a new GitHub issue with the version, OS and architecture filled in", async ({ page }) => {
    await openApp(page, "?platform=linux");
    await menuClick(page, "report-issue");

    await expect.poll(() => mockState(page, "openedUrls").then((u) => u.length)).toBe(1);
    const url = new URL((await mockState(page, "openedUrls"))[0]);
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/jrmitch120/http-desk/issues/new");
    expect(url.searchParams.get("body")).toContain("HttpDesk 0.9.8 (linux x86_64)");
  });
});
