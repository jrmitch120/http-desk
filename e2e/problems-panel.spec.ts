// #172: the Problems panel lists every `.http` file in the workspace with problems or
// lines that behave differently in VS Code or Rider, grouped by file, each entry with
// its line and message; clicking one opens the file's file view at that line. Its
// toggle counts the problems. `?problems=1` adds problems/broken.http (a request line
// with a space in its URL) and problems/upload.http (a body read from a file that
// isn't there) to the mock's workspace.
import { expect, test, type Page } from "@playwright/test";
import { activeTab, menuClick, openApp, openRequest, urlBar } from "./helpers";

const panel = (page: Page) => page.getByRole("region", { name: "Problems" });
const toggle = (page: Page) => page.getByRole("button", { name: /^Show Problems/ });
const group = (page: Page, file: string) => panel(page).getByRole("group", { name: file });
const fileView = (page: Page) => page.locator(".file-view .file-code");

test("a broken file and a missing < file both show in the panel; clicking one opens the file view at that line", async ({ page }) => {
  await openApp(page, "?problems=1");
  // The toggle counts them before the panel is open.
  await expect(toggle(page)).toContainText("2");
  await toggle(page).click();

  await expect(group(page, "problems/broken.http")).toContainText("Line 2");
  await expect(group(page, "problems/broken.http")).toContainText(/URL/);
  const missing = group(page, "problems/upload.http").getByRole("listitem").filter({ hasText: "Line 5" });
  await expect(missing).toContainText("./missing.json");

  await missing.click();
  await expect(activeTab(page)).toContainText("upload.http");
  await expect(fileView(page).locator(".cm-activeLine")).toHaveText("< ./missing.json");
});

test("an Undefined variable typed in a request is listed at its line, for the selected environment, before it's saved", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await urlBar(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type("/{{nowhere}}");
  await menuClick(page, "toggle-problems");
  const entry = group(page, "api/pets.http").getByRole("listitem").filter({ hasText: "{{nowhere}} is undefined" });
  await expect(entry).toContainText("Line 15");

  await entry.click();
  await expect(activeTab(page)).toContainText("pets.http");
  await expect(fileView(page).locator(".cm-activeLine")).toHaveText("POST {{baseUrl}}/pets/{{nowhere}}");
});

test("a file's portability summary says how many lines behave differently, and the panel follows an edit", async ({ page }) => {
  await openApp(page, "?problems=1&portability=vscode");
  await menuClick(page, "toggle-problems");
  // samples/jetbrains.http has Rider-only handlers and directives.
  await expect(group(page, "samples/jetbrains.http")).toContainText(/\d+ lines? behaves? differently in VS Code/);

  // Fixing the broken line in its file view removes its entry, unsaved.
  await group(page, "problems/broken.http").getByRole("listitem").filter({ hasText: "Line 2" }).click();
  await expect(fileView(page).locator(".cm-activeLine")).toContainText("search for pets");
  // The caret is at the problem, the line not selected: typing there wouldn't replace it.
  await page.keyboard.press("Shift+End");
  await page.keyboard.type("GET {{baseUrl}}/search");
  await expect(group(page, "problems/broken.http")).toHaveCount(0);
  await expect(toggle(page)).toContainText("1");
});

// #192: every file's entries are one list: one Tab stop, the arrow keys move across
// files, and Enter opens the file view at the line as a click does.
const entry = (page: Page, file: string, line: number) => group(page, file).getByRole("listitem").filter({ hasText: `Line ${line}` });
const hidePanel = (page: Page) => page.getByRole("button", { name: /^Hide panel/ });

test("the entries are one Tab stop that Up/Down/Home/End move through across files, stopping at the ends", async ({ page }) => {
  await openApp(page, "?problems=1");
  await toggle(page).click();
  const broken = entry(page, "problems/broken.http", 2);
  const upload = entry(page, "problems/upload.http", 5);

  await hidePanel(page).focus();
  await page.keyboard.press("Tab");
  await expect(broken).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(broken).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(upload).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(upload).toBeFocused();
  await page.keyboard.press("Home");
  await expect(broken).toBeFocused();
  await page.keyboard.press("End");
  await expect(upload).toBeFocused();

  // One stop: Tab leaves the list, and coming back lands on the entry last focused.
  await page.keyboard.press("Tab");
  await expect(panel(page).locator(":focus")).toHaveCount(0);
  await hidePanel(page).focus();
  await page.keyboard.press("Tab");
  await expect(upload).toBeFocused();
});

test("Enter on an entry opens the file view at its line", async ({ page }) => {
  await openApp(page, "?problems=1");
  await toggle(page).click();
  await hidePanel(page).focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("ArrowDown");

  await page.keyboard.press("Enter");
  await expect(activeTab(page)).toContainText("upload.http");
  await expect(fileView(page).locator(".cm-activeLine")).toHaveText("< ./missing.json");
});
