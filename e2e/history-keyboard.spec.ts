// History from the keyboard (#193): both History lists, the sidebar's and a request's
// own in the response pane, are one Tab stop that Up/Down and Home/End move through.
// Enter opens an entry, Space ticks its Compare box, Delete asks first, Shift+F10 opens
// its menu, and moving to the last row lists more where there are more.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialog, openApp, openRequest, seedHistory } from "./helpers";

const sidebarHistory = (page: Page) => page.getByRole("region", { name: "Workspace History" });
const list = (page: Page) => sidebarHistory(page).getByRole("list", { name: "History entries" });
const entries = (page: Page) => list(page).getByRole("listitem");

/** Seeds `/pets/1` … `/pets/n`, a minute apart: `/pets/n` is the newest, listed first. */
function seedPets(page: Page, n: number) {
  const at = (i: number) => new Date(Date.UTC(2026, 10, 16, 8, i)).toISOString();
  return seedHistory(page, Array.from({ length: n }, (_, i) => ({ url: `https://api.test/pets/${i + 1}`, time: at(i + 1) })));
}

async function showSidebarHistory(page: Page) {
  await page.getByRole("radiogroup", { name: "Sidebar" }).getByRole("radio", { name: "History" }).click();
  await expect(sidebarHistory(page)).toBeVisible();
}

test("the sidebar's History is one Tab stop that Up/Down/Home/End move through, stopping at its ends", async ({ page }) => {
  await seedPets(page, 4);
  await openApp(page);
  await showSidebarHistory(page);
  const clear = sidebarHistory(page).getByRole("button", { name: "Clear workspace history" });

  // Into the list from the stop before it: the first entry, not its Compare box.
  await clear.focus();
  await page.keyboard.press("Tab");
  await expect(entries(page).nth(0)).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await expect(entries(page).nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(entries(page).nth(3)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(entries(page).nth(3)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(entries(page).nth(2)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(entries(page).nth(0)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(entries(page).nth(0)).toBeFocused();

  // Out in one Tab either way, and back to the row last focused.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+Tab");
  await expect(clear).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(entries(page).nth(1)).toBeFocused();
  // The Compare boxes aren't stops: the next Tab leaves the list.
  await page.keyboard.press("Tab");
  await expect(list(page).locator(":focus")).toHaveCount(0);
});

test("closing an entry opened with a click goes back to its row, and Down rings the entry it reaches", async ({ page }) => {
  await seedPets(page, 3);
  await openApp(page);
  await showSidebarHistory(page);
  const ring = (row: Locator) => row.evaluate((node) => getComputedStyle(node).outlineStyle);

  await entries(page).nth(0).click();
  await expect(dialog(page, "History entry")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(entries(page).nth(0)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(entries(page).nth(1)).toBeFocused();
  await expect.poll(() => ring(entries(page).nth(1))).not.toBe("none");
});

test("Enter on a History entry opens it, as a click does", async ({ page }) => {
  await seedPets(page, 3);
  await openApp(page);
  await showSidebarHistory(page);
  await entries(page).nth(0).focus();
  await page.keyboard.press("ArrowDown");

  await page.keyboard.press("Enter");

  await expect(dialog(page, "History entry")).toContainText("https://api.test/pets/2");
  await expect(entries(page).nth(1)).toHaveAttribute("aria-current", "true");
});

test("Space ticks and unticks the focused entry's Compare box", async ({ page }) => {
  await seedPets(page, 3);
  await openApp(page);
  await showSidebarHistory(page);
  const compareSelected = sidebarHistory(page).getByRole("button", { name: "Compare selected" });
  await entries(page).nth(0).focus();

  await page.keyboard.press("Space");
  await expect(entries(page).nth(0).getByRole("checkbox")).toBeChecked();
  await expect(entries(page).nth(0)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  await expect(entries(page).nth(1).getByRole("checkbox")).toBeChecked();
  await expect(compareSelected).toBeEnabled();

  await page.keyboard.press("Space");
  await expect(entries(page).nth(1).getByRole("checkbox")).not.toBeChecked();
  await expect(sidebarHistory(page).getByText("1 selected")).toBeVisible();
  // Ticking isn't opening.
  await expect(dialog(page, "History entry")).toHaveCount(0);
});

test("a click on a Compare box ticks it without opening the entry", async ({ page }) => {
  await seedPets(page, 2);
  await openApp(page);
  await showSidebarHistory(page);

  await entries(page).nth(1).getByRole("checkbox").click();

  await expect(entries(page).nth(1).getByRole("checkbox")).toBeChecked();
  await expect(dialog(page, "History entry")).toHaveCount(0);
});

test("Shift+F10 opens the focused entry's menu, and Delete asks before deleting it", async ({ page }) => {
  await seedPets(page, 3);
  await openApp(page);
  await showSidebarHistory(page);
  await entries(page).nth(0).focus();
  await page.keyboard.press("ArrowDown");

  await page.keyboard.press("Shift+F10");
  const rowMenu = page.getByRole("menu");
  await expect(rowMenu.getByRole("menuitem")).toHaveText(["Open", "Compare", "Delete…"]);
  // The focused row's menu: Open opens that entry.
  await rowMenu.getByRole("menuitem", { name: "Open" }).click();
  const opened = dialog(page, "History entry");
  await expect(opened).toContainText("https://api.test/pets/2");
  await page.keyboard.press("Escape");
  await expect(opened).toBeHidden();

  await entries(page).nth(1).focus();
  await page.keyboard.press("Delete");
  const ask = dialog(page, "Delete this History entry?");
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(entries(page)).toHaveCount(3);
  await entries(page).nth(1).focus();
  await page.keyboard.press("Backspace");
  await ask.getByRole("button", { name: "Delete" }).click();
  await expect(entries(page)).toHaveCount(2);
  await expect(list(page)).not.toContainText("https://api.test/pets/2");
});

test("End, or Down on the last row, lists more entries where there are more", async ({ page }) => {
  await seedPets(page, 120);
  await openApp(page);
  await showSidebarHistory(page);
  await expect(entries(page)).toHaveCount(50);
  await entries(page).nth(0).focus();

  await page.keyboard.press("End");
  await expect(entries(page).nth(49)).toBeFocused();
  await expect(entries(page)).toHaveCount(100);
  await page.keyboard.press("ArrowDown");
  await expect(entries(page).nth(50)).toBeFocused();
  await expect(entries(page).nth(50)).toContainText("https://api.test/pets/70");

  // Down by Down from just above the end reaches it too.
  await entries(page).nth(98).focus();
  await page.keyboard.press("ArrowDown");
  await expect(entries(page)).toHaveCount(120);
  await page.keyboard.press("ArrowDown");
  await expect(entries(page).nth(100)).toBeFocused();
  await page.keyboard.press("End");
  await expect(entries(page).nth(119)).toBeFocused();
  await expect(entries(page).nth(119)).toContainText("https://api.test/pets/1");
  await expect(sidebarHistory(page).getByRole("button", { name: "Show more" })).toHaveCount(0);
});

test("a request's History in the response pane takes the same keys", async ({ page }) => {
  // 60 sends of List pets: /pets?page=60 is the newest.
  const at = (i: number) => new Date(Date.UTC(2026, 10, 16, 8, i)).toISOString();
  await seedHistory(page, Array.from({ length: 60 }, (_, i) => ({ file: "api/pets.http", writtenUrl: "{{baseUrl}}/pets", url: `http://localhost:3000/pets?page=${i + 1}`, time: at(i + 1) })));
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.getByRole("radiogroup", { name: "Response pane" }).getByRole("radio", { name: "History" }).click();
  const paneEntries = page.locator(".viewer").getByRole("list", { name: "History entries" }).getByRole("listitem");
  await expect(paneEntries).toHaveCount(50);

  // One Tab stop, after the filter.
  await page.locator(".viewer").getByRole("textbox", { name: "Filter History" }).focus();
  await page.keyboard.press("Tab");
  await expect(paneEntries.nth(0)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(paneEntries.nth(1)).toBeFocused();

  // Space ticks Compare, and Shift+F10 opens the row's menu.
  await page.keyboard.press("Space");
  await expect(paneEntries.nth(1).getByRole("checkbox")).toBeChecked();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Open", /Compare with the next newer entry/, "Delete…"]);
  await page.keyboard.press("Escape");

  // End lists the rest.
  await paneEntries.nth(1).focus();
  await page.keyboard.press("End");
  await expect(paneEntries).toHaveCount(60);
  await page.keyboard.press("End");
  await expect(paneEntries.nth(59)).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");

  // Enter opens the entry, read-only in the pane.
  const sent = await paneEntries.nth(1).locator(".metric").first().textContent();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "History entry" })).toBeVisible();
  await expect(page.locator(".viewer .statusbar").first()).toContainText(`Sent ${sent} · read-only`);
});
