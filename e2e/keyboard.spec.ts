import { expect, test } from "@playwright/test";
import { activeTab, dialog, openApp, openRequest, tab, treeItem, urlBar } from "./helpers";

test("a confirm dialog focuses its primary button, keeps Tab inside and gives focus back on close", async ({ page }) => {
  await openApp(page);
  const row = treeItem(page, "api");
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
  const confirm = dialog(page, "Move to trash");

  await expect(confirm.getByRole("button", { name: "Move to trash" })).toBeFocused();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    await expect(confirm.locator(":focus")).toHaveCount(1);
  }
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Shift+Tab");
    await expect(confirm.locator(":focus")).toHaveCount(1);
  }
  await expect(confirm.getByRole("button", { name: "Move to trash" })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(row).toBeFocused();
});

test("Enter confirms a Delete dialog", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await treeItem(page, "Create pet").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(dialog(page, "Delete request").getByRole("button", { name: "Delete" })).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(dialog(page, "Delete request")).toHaveCount(0);
  await expect(treeItem(page, "Create pet")).toHaveCount(0);
});

test("the unsaved-changes dialog focuses Save", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await urlBar(page).click();
  await page.keyboard.type("x");
  await activeTab(page).getByTitle("Close").click();

  await expect(dialog(page, 'Save changes to "List pets"?').getByRole("button", { name: "Save", exact: true })).toBeFocused();
});

test("a context menu opens focused, moves with the arrow keys, and Escape gives focus back", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  const row = treeItem(page, "Create pet");
  await row.click({ button: "right" });
  const item = (name: string) => page.getByRole("menuitem", { name, exact: true });

  await expect(item("Open")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(item("Rename…")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(item("Delete")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(row).toBeFocused();
});

test("the explorer is a tree you can walk with the arrow keys and open requests from with Enter", async ({ page }) => {
  await openApp(page);
  const tree = page.getByRole("tree", { name: "Explorer" });
  await expect(tree.getByRole("treeitem")).not.toHaveCount(0);
  const api = treeItem(page, "api");
  const pets = treeItem(page, "pets.http");

  await page.getByPlaceholder("Search requests").focus();
  await page.keyboard.press("Tab");
  await expect(api).toBeFocused();

  await page.keyboard.press("ArrowRight");
  await expect(api).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowRight");
  await expect(pets).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(pets).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowDown");
  await expect(treeItem(page, "List pets")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(treeItem(page, "Create pet")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(activeTab(page)).toContainText("Create pet");

  await treeItem(page, "Create pet").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(pets).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(pets).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowUp");
  await expect(api).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(api).toHaveAttribute("aria-expanded", "false");
});

test("only one explorer row is in the Tab order", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.getByPlaceholder("Search requests").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("treeitem").and(page.locator(":focus"))).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("treeitem").and(page.locator(":focus"))).toHaveCount(0);
});

test("Shift+F10 opens the context menu of the focused row", async ({ page }) => {
  await openApp(page);
  await treeItem(page, "api").focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menuitem", { name: "New .http file" })).toBeFocused();
});

test("tabs are a tab list: arrow keys move between them and Enter or Space switches", async ({ page }) => {
  await openApp(page);
  for (const name of ["List pets", "Create pet", "Get pet image"]) await openRequest(page, ["api", "pets.http"], name);
  const tabs = page.getByRole("tablist", { name: "Open requests" });
  await expect(tabs.getByRole("tab")).toHaveCount(3);

  await tab(page, "Get pet image").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(tab(page, "Create pet")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(activeTab(page)).toContainText("Create pet");
  await expect(tab(page, "Create pet")).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Home");
  await expect(tab(page, "List pets")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(tab(page, "Get pet image")).toBeFocused();
  await page.keyboard.press(" ");
  await expect(activeTab(page)).toContainText("Get pet image");
});

test("only the active tab is in the Tab order", async ({ page }) => {
  await openApp(page);
  for (const name of ["List pets", "Create pet"]) await openRequest(page, ["api", "pets.http"], name);
  await expect(tab(page, "Create pet")).toHaveAttribute("tabindex", "0");
  await expect(tab(page, "List pets")).toHaveAttribute("tabindex", "-1");
});

test("icon-only buttons, including toast close buttons, have accessible labels", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.getByText("200 OK")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+E");
  await dialog(page, "Environments").getByPlaceholder("Add variable").fill("apiKey");
  await dialog(page, "Environments").getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Environments saved")).toBeVisible();
  await page.getByPlaceholder("Search requests").fill("pets");

  await page.getByRole("button", { name: "Dismiss" }).first().click();
  await expect(page.getByText("Environments saved")).toHaveCount(0);
  const unlabelled = await page.locator("button").evaluateAll((buttons) =>
    buttons
      .filter((b) => !b.textContent?.trim() && !b.getAttribute("aria-label") && !b.getAttribute("title"))
      .map((b) => b.outerHTML.slice(0, 80)),
  );
  expect(unlabelled).toEqual([]);
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.getByPlaceholder("Search requests")).toHaveValue("");
});

test("Enter on a context menu item runs it", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await treeItem(page, "Create pet").click({ button: "right" });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(dialog(page, "Rename request")).toBeVisible();
});
