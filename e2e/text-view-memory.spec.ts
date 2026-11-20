// A text view comes back as it was left: its tab's view is taken down while another
// tab shows, and the cursor, the text's place on screen and the undo history are there
// again afterwards. A request typed out of the file view and back keeps its tab, and
// the problems underlined in a text view are reached from the keyboard (F8).
import { expect, test, type Page } from "@playwright/test";
import { activeTab, openApp, openRequest, tab } from "./helpers";

const fileView = (page: Page) => page.locator(".file-view .file-code");
const line = (page: Page, text: string) => fileView(page).locator(".cm-line", { hasText: text });
const viewAsText = (page: Page) => page.getByRole("button", { name: "View file as text" });
const mod = "ControlOrMeta";

test("the file view's cursor and undo history outlast a visit to another tab", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await viewAsText(page).click();
  await line(page, "Content-Type: application/json").click();
  await page.keyboard.press("End");
  await page.keyboard.type("; charset=utf-8");
  await expect(fileView(page).locator(".cm-activeLine")).toHaveText("Content-Type: application/json; charset=utf-8");

  await tab(page, "Create pet").click();
  await expect(page.locator(".file-view")).toHaveCount(0);
  await tab(page, "pets.http").click();

  // Where it was: the same line holds the cursor, and typing goes on from there.
  await expect(fileView(page).locator(".cm-activeLine")).toHaveText("Content-Type: application/json; charset=utf-8");
  await fileView(page).locator(".cm-content").focus();
  await page.keyboard.type("!");
  await expect(fileView(page).locator(".cm-activeLine")).toHaveText("Content-Type: application/json; charset=utf-8!");

  // And Undo still takes back what was typed before the visit.
  await page.keyboard.press(`${mod}+z`);
  await page.keyboard.press(`${mod}+z`);
  await expect(line(page, "Content-Type: application/json")).toHaveText("Content-Type: application/json");
  await expect(tab(page, "pets.http").locator(".dot")).toBeHidden();
});

test("⌘Enter in the file view sends from the request's tab, and coming back the cursor is where it was", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await viewAsText(page).click();
  await line(page, "Content-Type: application/json").click();
  // Send is the app's key, which follows the app's OS (macOS in the mock), not the machine's as CodeMirror's do.
  await page.keyboard.press("Meta+Enter");
  await expect(activeTab(page)).toContainText("Create pet");

  await tab(page, "pets.http").click();
  await expect(fileView(page).locator(".cm-activeLine")).toHaveText("Content-Type: application/json");
});

test("a request cut out of the file view's text and undone keeps its tab, and the file reads unedited", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await viewAsText(page).click();
  await line(page, "### Create pet").click();
  await page.keyboard.press("Home");
  // The separator line and the request line go: the block is no request any more.
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Backspace");
  await expect(tab(page, "Create pet")).toHaveCount(0);

  await page.keyboard.press(`${mod}+z`);
  await expect(tab(page, "Create pet")).toHaveCount(1);
  await expect(tab(page, "pets.http").locator(".dot")).toBeHidden();
  // The user is still typing in the file view.
  await expect(activeTab(page)).toContainText("pets.http");
});

test("F8 goes to the next problem in the text and says what it is", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await viewAsText(page).click();
  await line(page, "POST {{baseUrl}}/pets").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" and more");
  await expect(fileView(page).locator(".cm-underline-error")).not.toHaveCount(0);
  // The note says where, and its button goes there.
  await expect(page.locator(".file-view .note")).toContainText(/Line \d+/);

  await line(page, "@petId = 1").click();
  await page.keyboard.press("F8");
  await expect(fileView(page).locator(".cm-activeLine")).toContainText("and more");
  await expect(page.locator(".cm-underline-tip")).toContainText("Error:");
});
