// Theme: System (follows the OS), Light or Dark, picked from the top-bar menu
// or Settings. The browser's emulated colour scheme stands in for the OS
// appearance; playwright.config.ts starts every test with a dark OS.
import { expect, test, type Page } from "@playwright/test";
import { dialog, openApp } from "./helpers";

const applied = (page: Page) => page.locator("html");
const themeButton = (page: Page) => page.getByRole("button", { name: "Theme", exact: true });
const themeMenu = (page: Page) => page.getByRole("menu", { name: "Theme" });
const choice = (page: Page, name: string) => themeMenu(page).getByRole("menuitemradio", { name });
const saved = (page: Page) => page.evaluate(() => (window as unknown as { __mock: { settings: { theme: string } } }).__mock.settings.theme);

test("new installs follow the OS appearance", async ({ page }) => {
  await openApp(page);
  await expect(applied(page)).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(applied(page)).toHaveAttribute("data-theme", "light");
});

test("the top-bar menu picks System, Light or Dark and applies it at once", async ({ page }) => {
  await openApp(page, "?theme=dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(themeButton(page)).toHaveAttribute("aria-haspopup", "menu");

  await themeButton(page).click();
  await expect(themeButton(page)).toHaveAttribute("aria-expanded", "true");
  await expect(themeMenu(page).getByRole("menuitemradio")).toHaveText(["System", "Light", "Dark"]);
  await expect(choice(page, "Dark")).toHaveAttribute("aria-checked", "true");
  await expect(choice(page, "System")).toHaveAttribute("aria-checked", "false");

  await choice(page, "Light").click();
  await expect(themeMenu(page)).toBeHidden();
  await expect(themeButton(page)).toHaveAttribute("aria-expanded", "false");
  await expect(applied(page)).toHaveAttribute("data-theme", "light");
  expect(await saved(page)).toBe("light");

  await themeButton(page).click();
  await expect(choice(page, "Light")).toHaveAttribute("aria-checked", "true");
  await choice(page, "Dark").click();
  await expect(applied(page)).toHaveAttribute("data-theme", "dark");

  await themeButton(page).click();
  await choice(page, "System").click();
  await expect(applied(page)).toHaveAttribute("data-theme", "light");
  expect(await saved(page)).toBe("system");
});

test("clicking the theme button again closes its menu", async ({ page }) => {
  await openApp(page);
  await themeButton(page).click();
  await expect(themeMenu(page)).toBeVisible();
  await themeButton(page).click();
  await expect(themeMenu(page)).toBeHidden();
});

test("the theme menu works from the keyboard", async ({ page }) => {
  await openApp(page, "?theme=dark");
  await themeButton(page).focus();
  await page.keyboard.press("Enter");
  // Opens on the current choice.
  await expect(choice(page, "Dark")).toBeFocused();

  await page.keyboard.press("ArrowDown"); // wraps to the first item
  await expect(choice(page, "System")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(choice(page, "Light")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(choice(page, "System")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(themeMenu(page)).toBeHidden();
  await expect(applied(page)).toHaveAttribute("data-theme", "light");
  await expect(themeButton(page)).toBeFocused();

  // Escape closes it without changing anything and gives focus back.
  await page.keyboard.press("Enter");
  await expect(choice(page, "Light")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(themeMenu(page)).toBeHidden();
  await expect(themeButton(page)).toBeFocused();
  await expect(applied(page)).toHaveAttribute("data-theme", "light");
});

test("the theme button shows the theme in effect, and marks System as automatic", async ({ page }) => {
  await openApp(page, "?theme=light");
  const button = themeButton(page);
  await expect(button.locator(".auto")).toHaveCount(0);
  await button.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Theme: Light");

  await button.click();
  await choice(page, "System").click();
  await expect(button.locator(".auto")).toBeVisible();
  await page.mouse.move(0, 0);
  await button.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Theme: System (Dark)");
});

test("Settings' Theme switch has System and applies at once", async ({ page }) => {
  await openApp(page, "?theme=dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.keyboard.press("ControlOrMeta+Comma");
  const theme = dialog(page, "Settings").getByRole("radiogroup", { name: "Theme" });
  await expect(theme.getByRole("radio")).toHaveText(["System", "Light", "Dark"]);

  await theme.getByRole("radio", { name: "Light" }).click();
  await expect(applied(page)).toHaveAttribute("data-theme", "light");
  await theme.getByRole("radio", { name: "Dark" }).click();
  await expect(applied(page)).toHaveAttribute("data-theme", "dark");
  await theme.getByRole("radio", { name: "System" }).click();
  await expect(applied(page)).toHaveAttribute("data-theme", "light");
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
  await page.keyboard.press("ControlOrMeta+Comma"); // a round trip, so a late change would have landed
  await expect(applied(page)).toHaveAttribute("data-theme", "dark");
});
