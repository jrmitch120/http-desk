// Layout restore (#152): a workspace reopens as the user left it: its tabs in
// order, the active tab, each tab's request section and response view, and the
// expanded folders. The mock keeps Layouts (and files written with `writeFile`)
// in sessionStorage, so a page reload stands in for a restart.
import { expect, test, type Page } from "@playwright/test";
import { activeTab, menuClick, mockState, openApp, openRequest, searchBox, tab, treeItem } from "./helpers";

async function send(page: Page): Promise<void> {
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".statusbar .metric").first()).toBeVisible();
}

const tabNames = (page: Page) => page.getByRole("tablist", { name: "Open requests" }).getByRole("tab").locator(".name");
const section = (page: Page, name: string) => page.locator(".subtab", { hasText: name });
const responseTab = (page: Page, name: string) => page.getByRole("radiogroup", { name: "Response tabs" }).getByRole("radio", { name: new RegExp(`^${name}\\b`) });
const mode = (page: Page, name: string) => page.getByRole("radiogroup", { name: "Response view" }).getByRole("radio", { name });
const wrapButton = (page: Page) => page.getByRole("button", { name: "Wrap lines" });
const filterBox = (page: Page) => page.getByRole("combobox", { name: "Filter with JSONPath" });
const PETS = "/demo/api/pets.http";

/** The names of the tabs in the Layout the mock last saved for `root`, in order (once one has been saved). */
async function savedTabs(page: Page, root = "/demo"): Promise<string[] | null> {
  const layout = (await mockState(page, "layouts"))[root] as { tabs: { name: string }[] } | undefined;
  return layout ? layout.tabs.map((t) => t.name) : null;
}

/** What the mock last saved for `root`, once one has been saved. */
async function savedLayout(page: Page, root = "/demo"): Promise<unknown> {
  return (await mockState(page, "layouts"))[root] ?? null;
}

/** Reloads the page (a restart) and waits for the workspace to open. */
async function restart(page: Page): Promise<void> {
  await page.reload();
  await expect(treeItem(page, "api")).toBeVisible();
}

test("a restart brings back the tabs in order, the active tab, each tab's section and response view, and the expanded folders", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await section(page, "Auth").click();
  await mode(page, "Raw").click();
  await wrapButton(page).click();
  await responseTab(page, "Headers").click();
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await section(page, "Headers").click();
  await openRequest(page, ["api", "pets.http"], "Get pet image");
  await treeItem(page, "samples").click();
  await tab(page, "Create pet").click();
  await expect
    .poll(() => savedLayout(page))
    .toMatchObject({ active: 1, tabs: [{ section: "auth", responseView: { tab: "headers", mode: "raw", wrap: true } }, { section: "headers" }, {}], expanded: expect.arrayContaining(["samples"]) });

  await restart(page);

  await expect(tabNames(page)).toHaveText(["List pets", "Create pet", "Get pet image"]);
  await expect(activeTab(page)).toContainText("Create pet");
  await expect(section(page, "Headers")).toHaveClass(/active/);
  await expect(treeItem(page, "api")).toHaveAttribute("aria-expanded", "true");
  await expect(treeItem(page, "pets.http")).toHaveAttribute("aria-expanded", "true");
  await expect(treeItem(page, "samples")).toHaveAttribute("aria-expanded", "true");
  await expect(treeItem(page, "jetbrains.http")).toHaveAttribute("aria-expanded", "false");

  await tab(page, "List pets").click();
  await expect(section(page, "Auth")).toHaveClass(/active/);
  // Responses aren't restored; the next one shows the way the tab left it.
  await send(page);
  await expect(responseTab(page, "Headers")).toHaveAttribute("aria-checked", "true");
  await responseTab(page, "Body").click();
  await expect(mode(page, "Raw")).toBeChecked();
  await expect(wrapButton(page)).toHaveClass(/active/);
});

test("switching to another workspace and back brings back each workspace's own Layout", async ({ page }) => {
  await openApp(page, "?roots=/work/shop&recent=/work/shop");
  await openRequest(page, ["api", "pets.http"], "List pets");

  // At once: a Layout still settling is saved before the workspace switches.
  await menuClick(page, "open-recent:/work/shop");
  await expect.poll(() => mockState(page, "settings").then((s) => s.recentWorkspaces[0])).toBe("/work/shop");
  await expect(tabNames(page)).toHaveCount(0);
  await expect(treeItem(page, "api")).toHaveAttribute("aria-expanded", "false");
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await openRequest(page, ["api", "pets.http"], "Get pet image");

  await menuClick(page, "open-recent:/demo");
  await expect(tabNames(page)).toHaveText(["List pets"]);
  await expect(activeTab(page)).toContainText("List pets");

  await menuClick(page, "open-recent:/work/shop");
  await expect(tabNames(page)).toHaveText(["Create pet", "Get pet image"]);
  await expect(activeTab(page)).toContainText("Get pet image");
  await expect(treeItem(page, "pets.http")).toHaveAttribute("aria-expanded", "true");
});

test("closing the window saves a Layout that was still settling", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");

  await page.keyboard.press("Meta+Shift+W");

  await expect.poll(() => mockState(page, "windowClosed")).toBe(true);
  expect(await savedTabs(page)).toEqual(["List pets"]);
});

test("a request moved within its file re-attaches, and a deleted one is dropped with a note", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await openRequest(page, ["api", "pets.http"], "Get pet image");
  await expect.poll(() => savedTabs(page)).toEqual(["List pets", "Create pet", "Get pet image"]);

  // Another editor moves List pets to the end and deletes Create pet while the app is closed.
  await page.evaluate((path) => {
    const mock = (window as unknown as { __mock: MockFiles }).__mock;
    const file = mock.files[path];
    const [list, , image] = file.requests;
    mock.writeFile(path, { ...file, requests: [image, list] });
  }, PETS);
  await restart(page);

  await expect(tabNames(page)).toHaveText(["List pets", "Get pet image"]);
  await expect(activeTab(page)).toContainText("Get pet image");
  await expect(page.locator(".toast")).toHaveText(["1 tab wasn't restored: its request no longer exists."]);
  await tab(page, "List pets").click();
  await expect(treeItem(page, "List pets")).toHaveClass(/\bactive\b/);
});

test("the sidebar search and the response filter start empty", async ({ page }) => {
  await openApp(page, "?response=store");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await filterBox(page).fill("$.items");
  await searchBox(page).fill("pets");
  await expect.poll(() => savedTabs(page)).toEqual(["List pets"]);

  await restart(page);

  await expect(searchBox(page)).toHaveValue("");
  await expect(activeTab(page)).toContainText("List pets");
  await send(page);
  await expect(filterBox(page)).toHaveValue("");
});

test("after Close all, a restart opens no tabs", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await expect.poll(() => savedTabs(page)).toEqual(["List pets", "Create pet"]);

  await tab(page, "List pets").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close all", exact: true }).click();
  await expect(tabNames(page)).toHaveCount(0);
  await expect.poll(() => savedTabs(page)).toEqual([]);

  await restart(page);

  await expect(treeItem(page, "pets.http")).toHaveAttribute("aria-expanded", "true");
  await expect(tabNames(page)).toHaveCount(0);
});

interface MockFiles {
  files: Record<string, { requests: unknown[] }>;
  writeFile: (path: string, file: unknown) => void;
}
