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

/** The active request's tab in the tab strip. It contains a `.dot` while unsaved. */
export function activeTab(page: Page): Locator {
  return page.getByRole("tablist", { name: "Open requests" }).getByRole("tab", { selected: true });
}

/** The active request's body editor (a CodeMirror editor; open the Body section first). */
export function bodyEditor(page: Page): Locator {
  return page.locator(".panel .cm-content");
}

/** The requests the mocked `send_request` has received so far, in order. */
export function sentRequests(page: Page): Promise<{ method: string; url: string }[]> {
  return mockState(page, "sent");
}

/** A `.http` file model as the mock last saved it (it has no serializer). */
export type SavedFile = { requests: { name: string; body: { text: string } }[] };
type EnvFile = Record<string, Record<string, unknown>>;

/** What the mocked backend exposes to tests as `window.__mock` (see src/dev/mock.ts). */
export interface MockState {
  sent: { method: string; url: string }[];
  /** The settings it last saved. */
  settings: { theme: string; exec: Record<string, unknown> };
  /** `.http` file models by path, as last saved. */
  files: Record<string, SavedFile>;
  /** What "Save body to file" wrote, by path. */
  savedBodies: Record<string, string>;
  /** The response ids `response_shape` was asked for, in order. */
  shapeRequests: string[];
  /** The two env files as last written. */
  envFiles: { shared: EnvFile; private: EnvFile };
  /** How many times the viewer called `pretty_response`. */
  prettyRequests: number;
  /** Whether the app has been given its settings yet. */
  settingsServed: boolean;
}

/** One value of the mock's test-facing state, read from the page. */
export function mockState<K extends keyof MockState>(page: Page, key: K): Promise<MockState[K]> {
  return page.evaluate((k) => (window as unknown as { __mock: MockState }).__mock[k], key) as Promise<MockState[K]>;
}

/** Starts the mock's `pretty_response` count from zero. */
export function resetPrettyRequests(page: Page): Promise<void> {
  return page.evaluate(() => {
    (window as unknown as { __mock: MockState }).__mock.prettyRequests = 0;
  });
}

/** Lets settings held by `?settingsDelay=hold` through. */
export function releaseSettings(page: Page): Promise<void> {
  return page.evaluate(() => (window as unknown as { __mock: { releaseSettings: () => void } }).__mock.releaseSettings());
}

/** An open request tab in the tab bar, by request name. */
export function tab(page: Page, name: string): Locator {
  return page
    .getByRole("tablist", { name: "Open requests" })
    .getByRole("tab")
    .filter({ has: page.locator(".name", { hasText: new RegExp(`^${escape(name)}$`) }) });
}

/** A confirm/prompt dialog (or any modal) by its title. */
export function dialog(page: Page, title: string): Locator {
  return page.getByRole("dialog", { name: title, exact: true });
}

/** Right-clicks a sidebar row and picks an item from its context menu. */
export async function treeMenu(page: Page, label: string, item: string): Promise<void> {
  await treeItem(page, label).click({ button: "right" });
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

/** The text currently selected in an input. */
export function selectedText(input: Locator): Promise<string> {
  return input.evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0));
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
