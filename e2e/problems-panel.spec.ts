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
  const missing = group(page, "problems/upload.http").getByRole("button", { name: /Line 5/ });
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
  const entry = group(page, "api/pets.http").getByRole("button", { name: /\{\{nowhere\}\} is undefined/ });
  await expect(entry).toContainText("Line 15");

  await entry.click();
  await expect(activeTab(page)).toContainText("pets.http");
  await expect(fileView(page).locator(".cm-activeLine")).toHaveText("POST {{baseUrl}}/pets/{{nowhere}}");
});

test("a file's portability summary says how many lines behave differently, and the panel follows an edit", async ({ page }) => {
  await openApp(page, "?problems=1");
  await menuClick(page, "toggle-problems");
  // samples/jetbrains.http has Rider-only handlers and directives.
  await expect(group(page, "samples/jetbrains.http")).toContainText(/\d+ lines? behaves? differently in VS Code/);

  // Fixing the broken line in its file view removes its entry, unsaved.
  await group(page, "problems/broken.http").getByRole("button", { name: /Line 2/ }).click();
  await expect(fileView(page).locator(".cm-activeLine")).toContainText("search for pets");
  await page.keyboard.type("GET {{baseUrl}}/search");
  await expect(group(page, "problems/broken.http")).toHaveCount(0);
  await expect(toggle(page)).toContainText("1");
});
