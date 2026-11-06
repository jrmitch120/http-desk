// Shared helpers for browser tests. The app runs against the mocked backend in
// src/dev/mock.ts, which auto-opens the `/demo` workspace:
//   api/pets.http           List pets, Create pet, Get pet image
//   samples/jetbrains.http  JetBrains syntax samples
// Mock state lives in the page, so every test (fresh page) starts clean.
import { expect, type Locator, type Page } from "@playwright/test";

/** Loads the app and waits for the mocked workspace tree to appear. */
export async function openApp(page: Page, query = ""): Promise<void> {
  await page.goto(`/${query}`);
  await expect(treeItem(page, "api")).toBeVisible();
}

/** A row in the sidebar tree (folder, file or request), by its visible label. */
export function treeItem(page: Page, label: string): Locator {
  return page.getByRole("treeitem").filter({ has: page.locator(".label", { hasText: new RegExp(`^${escape(label)}$`) }) });
}

/**
 * Expands each folder/file in `path` (relative to the workspace root), then
 * opens the request named `request` in a tab.
 * Example: `openRequest(page, ["api", "pets.http"], "List pets")`.
 */
export async function openRequest(page: Page, path: string[], request: string): Promise<void> {
  for (const segment of path) {
    const row = treeItem(page, segment);
    if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  }
  await treeItem(page, request).click();
  await expect(urlBar(page)).toBeVisible();
}

/** The URL bar of the active request tab (a CodeMirror editor). */
export function urlBar(page: Page): Locator {
  return page.locator(".url-input .cm-content");
}

/** The sidebar search box (⌘/Ctrl P focuses it). */
export function searchBox(page: Page): Locator {
  return page.getByPlaceholder("Search requests");
}

/** The rows of the sidebar search results, in order. */
export function searchResults(page: Page): Locator {
  return page.getByRole("listbox", { name: "Search results" }).getByRole("option");
}

/** The active tab in the tab bar. */
export function activeTab(page: Page): Locator {
  return page.locator(".tabbar .tab.active");
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
