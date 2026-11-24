// Theme: System (follows the OS), Light or Dark, picked from View → Theme or
// Settings (#214: the topbar has no theme button). The browser's emulated colour
// scheme stands in for the OS appearance; playwright.config.ts starts every test
// with a dark OS.
import { expect, test, type Page } from "@playwright/test";
import { dialog, menuClick, menuItem, mockState, openApp } from "./helpers";

const applied = (page: Page) => page.locator("html");
const saved = async (page: Page) => (await mockState(page, "settings")).theme;
const checked = async (page: Page, id: string) => (await menuItem(page, id))?.checked;

test("new installs follow the OS appearance", async ({ page }) => {
  await openApp(page);
  await expect(applied(page)).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(applied(page)).toHaveAttribute("data-theme", "light");
});

test("View → Theme picks System, Light or Dark, applies it at once and checks the choice", async ({ page }) => {
  await openApp(page, "?theme=dark");
  await page.emulateMedia({ colorScheme: "light" });
  expect(await checked(page, "theme-dark")).toBe(true);

  await menuClick(page, "theme-light");
  await expect(applied(page)).toHaveAttribute("data-theme", "light");
  await expect.poll(() => saved(page)).toBe("light");
  await expect.poll(() => checked(page, "theme-light")).toBe(true);

  await menuClick(page, "theme-dark");
  await expect(applied(page)).toHaveAttribute("data-theme", "dark");

  // System shows as checked when chosen, though the OS appearance decides the theme.
  await menuClick(page, "theme-system");
  await expect(applied(page)).toHaveAttribute("data-theme", "light");
  await expect.poll(() => saved(page)).toBe("system");
  await expect.poll(() => checked(page, "theme-system")).toBe(true);
  expect(await checked(page, "theme-light")).toBe(false);
  expect(await checked(page, "theme-dark")).toBe(false);
});

test("Settings' Theme switch has System and applies at once", async ({ page }) => {
  await openApp(page, "?theme=dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.keyboard.press("Meta+Comma");
  const theme = dialog(page, "Settings").getByRole("radiogroup", { name: "Theme" });
  await expect(theme.getByRole("radio")).toHaveText(["System", "Light", "Dark"]);

  await theme.getByRole("radio", { name: "Light" }).click();
  await expect(applied(page)).toHaveAttribute("data-theme", "light");
  await theme.getByRole("radio", { name: "Dark" }).click();
  await expect(applied(page)).toHaveAttribute("data-theme", "dark");
  await theme.getByRole("radio", { name: "System" }).click();
  await expect(applied(page)).toHaveAttribute("data-theme", "light");
  await expect(theme.getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "true");
  expect(await saved(page)).toBe("system");
});

test("with System chosen, the OS appearance flips the theme without a reload", async ({ page }) => {
  await openApp(page, "?theme=system");
  await page.evaluate(() => ((window as unknown as { marker: boolean }).marker = true));
  await page.emulateMedia({ colorScheme: "light" });
  await expect(applied(page)).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(applied(page)).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => (window as unknown as { marker?: boolean }).marker)).toBe(true);
});

test("a fixed theme ignores the OS appearance", async ({ page }) => {
  await openApp(page, "?theme=dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.keyboard.press("Meta+Comma"); // a round trip, so a late change would have landed
  await expect(applied(page)).toHaveAttribute("data-theme", "dark");
});
