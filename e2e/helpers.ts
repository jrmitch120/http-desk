// Shared helpers for browser tests. The app runs against the mocked backend in
// src/dev/mock.ts, which auto-opens the `/demo` workspace:
//   api/pets.http           List pets, Create pet, Get pet image
//   samples/jetbrains.http  JetBrains syntax samples
// Mock state lives in the page, so every test (fresh page) starts clean.
import { expect, type Locator, type Page } from "@playwright/test";
import type { BodyFetchView } from "../src/lib/api";

/**
 * Loads the app and waits for the mocked workspace tree to appear.
 *
 * The app runs as on macOS (`?platform=mac`) unless `query` names another
 * platform, whatever machine runs the test. So app shortcuts are pressed as
 * `Meta+…`, never `ControlOrMeta+…`, which follows the test machine. Editor
 * keys CodeMirror handles itself (select all, find) still follow the machine.
 */
export async function openApp(page: Page, query = ""): Promise<void> {
  if (!/[?&]platform=/.test(query)) query = `${query ? `${query}&` : "?"}platform=mac`;
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

/** The sidebar search box (⌘P / Ctrl+P focuses it). */
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

/** Presses Tab until `target` has keyboard focus (as a keyboard user would reach it), at most `presses` times. */
export async function tabTo(page: Page, target: Locator, presses = 40): Promise<void> {
  for (let i = 0; i < presses && !(await target.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(target).toBeFocused();
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
  /** The Prompt variable values each send got, in order. */
  sentPrompts: Record<string, string>[];
  /** Each send's `skipScripts` ("Send without scripts"). */
  sentSkipScripts: boolean[];
  /** The Cookie header the Session's jar gave each send, in order ("" for none). */
  sentCookies: string[];
  /** The options each run got, in order. */
  runOptions: { skipScripts?: boolean; delayMs?: number; stopOnFailure?: boolean }[];
  /** The settings it last saved. */
  settings: {
    theme: string;
    zoom: number;
    recentWorkspaces: string[];
    exec: Record<string, unknown>;
    showResolved: boolean;
    envView: "matrix" | "list";
    envMatrixWidths?: Record<string, { variable?: number | null; columns: Record<string, number> }>;
    environmentSettings: Record<string, Record<string, { production?: boolean; color?: string | null }>>;
    trustedWorkspaces: string[];
    runnerOptions: Record<string, { delayMs: number; stopOnFailure: boolean }>;
  };
  /** `.http` file models by path, as last saved. */
  files: Record<string, SavedFile>;
  /** What "Save body to file" wrote, by path. */
  savedBodies: Record<string, string>;
  /** The response ids `response_shape` was asked for, in order. */
  shapeRequests: string[];
  /** The two env files as last written. */
  envFiles: { shared: EnvFile; private: EnvFile };
  /** Each folder's own environments below the root, as last saved, by folder ("api"). */
  folderPairs: Record<string, { shared: unknown[]; environments: { name: string; variables: { name: string; value: string; secret: boolean }[] }[] }>;
  /** The bodies the viewer fetched with `response_body`, in order: response id and view. */
  bodyRequests: { id: string; view: BodyFetchView }[];
  /** How many times the resolved preview called `preview_request`. */
  previewRequests: number;
  /** Whether the app has been given its settings yet. */
  settingsServed: boolean;
  /** The window title the app last set (null before it sets one). */
  title: string | null;
  /** How many times the app asked the window to close (Close Window), each one a close request it answers itself. */
  windowCloseRequests: number;
  /** Whether the window has closed: a close request the app let through. */
  windowClosed: boolean;
  /** The webview zoom the app last set (`1` is 100%), null before it sets one. */
  webviewZoom: number | null;
  /** The `.http` files `save_http_file` wrote, in order. */
  savedPaths: string[];
  /** The native menu bar as the app last sent it, with the state changes since applied. */
  menu: { layout: { label: string; items: MenuEntry[] }[] };
  /** Each `set_menu_state` batch, in order. */
  menuStateChanges: MenuStateChange[][];
  /** The URLs the opener opened in the browser, in order (refused ones aren't listed). */
  openedUrls: string[];
  /** The OS clipboard the clipboard plugin reads and writes. */
  clipboard: string;
  /** The texts the clipboard plugin wrote, in order. */
  clipboardWrites: string[];
  /** The response ids `release_response` was called with, in order. */
  releasedResponses: string[];
  /** The response ids `copy_response_body` copied to the clipboard, in order. */
  bodyCopies: string[];
}

/** A native menu entry as the app sends it (src/lib/menuLayout.ts `NativeEntry`). */
export type MenuEntry =
  | { kind: "item"; id: string; label: string; accelerator: string | null; enabled: boolean; checked: boolean | null }
  | { kind: "separator" }
  | { kind: "predefined"; item: string; label: string | null }
  | { kind: "submenu"; label: string; enabled: boolean; items: MenuEntry[] };
export type MenuItem = Extract<MenuEntry, { kind: "item" }>;
export type MenuStateChange = { id: string; enabled?: boolean; checked?: boolean };

/** The labels of the native menu bar's menus, as the app last sent it. */
export async function menuBar(page: Page): Promise<string[]> {
  return (await mockState(page, "menu")).layout.map((m) => m.label);
}

/** The first native menu item with this id (a command id), as it shows now; undefined if there's none. */
export async function menuItem(page: Page, id: string): Promise<MenuItem | undefined> {
  const find = (items: MenuEntry[]): MenuItem | undefined => {
    for (const e of items) {
      if (e.kind === "item" && e.id === id) return e;
      const inner = e.kind === "submenu" ? find(e.items) : undefined;
      if (inner) return inner;
    }
  };
  return find((await mockState(page, "menu")).layout.flatMap((m) => m.items));
}

/** Each batch of item state changes the app sent to the native menu, in order. */
export function menuStateChanges(page: Page): Promise<MenuStateChange[][]> {
  return mockState(page, "menuStateChanges");
}

/** Clicks a native menu item: the menu event the shell sends, carrying the item's id. */
export function menuClick(page: Page, id: string): Promise<void> {
  return page.evaluate((i) => (window as unknown as { __mock: { menuClick: (id: string) => Promise<void> } }).__mock.menuClick(i), id);
}

/** One value of the mock's test-facing state, read from the page. */
export function mockState<K extends keyof MockState>(page: Page, key: K): Promise<MockState[K]> {
  return page.evaluate((k) => (window as unknown as { __mock: MockState }).__mock[k], key) as Promise<MockState[K]>;
}

/** The OS clipboard's text, as the clipboard plugin (src/lib/clipboard.ts) reads and writes it. */
export function clipboard(page: Page): Promise<string> {
  return mockState(page, "clipboard");
}

/** Puts `text` on the OS clipboard, for the clipboard plugin to read. */
export function setClipboard(page: Page, text: string): Promise<void> {
  return page.evaluate((t) => {
    (window as unknown as { __mock: { clipboard: string } }).__mock.clipboard = t;
  }, text);
}

/** Makes the clipboard plugin's writes fail (or succeed again), as when the OS clipboard is unavailable. */
export function setClipboardFails(page: Page, fails: boolean): Promise<void> {
  return page.evaluate((f) => {
    (window as unknown as { __mock: { clipboardFails: boolean } }).__mock.clipboardFails = f;
  }, fails);
}

/** Forgets the bodies the viewer has fetched so far (`bodyRequests`). */
export function resetBodyRequests(page: Page): Promise<void> {
  return page.evaluate(() => (window as unknown as { __mock: { resetBodyRequests: () => void } }).__mock.resetBodyRequests());
}

/** Makes the mock's next sends answer like `?response=<kind>` (null: the default JSON). */
export function setMockResponse(page: Page, kind: string | null): Promise<void> {
  return page.evaluate((k) => {
    (window as unknown as { __mock: { response: string | null } }).__mock.response = k;
  }, kind);
}

/** Lets settings held by `?settingsDelay=hold` through. */
export function releaseSettings(page: Page): Promise<void> {
  return page.evaluate(() => (window as unknown as { __mock: { releaseSettings: () => void } }).__mock.releaseSettings());
}

/** Lets Pretty text held by `?pretty=hold` through. */
export function releasePretty(page: Page): Promise<void> {
  return page.evaluate(() => (window as unknown as { __mock: { releasePretty: () => void } }).__mock.releasePretty());
}

/** Lets held bodies through (`?body=hold`). */
export function releaseBody(page: Page): Promise<void> {
  return page.evaluate(() => (window as unknown as { __mock: { releaseBody: () => void } }).__mock.releaseBody());
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

/** Switches the open Environments modal to its matrix (every environment side by side); it opens on the list. */
export async function showEnvironmentMatrix(page: Page): Promise<void> {
  const modal = dialog(page, "Environments");
  await modal.getByRole("radiogroup", { name: "View" }).getByRole("radio", { name: "Matrix" }).click();
  await expect(modal.getByRole("group", { name: "Environments matrix" })).toBeVisible();
}

/** Switches the open Environments modal back to its list (one environment at a time). */
export async function showEnvironmentList(page: Page): Promise<void> {
  const modal = dialog(page, "Environments");
  await modal.getByRole("radiogroup", { name: "View" }).getByRole("radio", { name: "List" }).click();
  await expect(modal.getByRole("group", { name: "Variables" })).toBeVisible();
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
