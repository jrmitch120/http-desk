// Styled tooltips (use:tooltip) replace native title= tooltips (#43, ADR 0002).
import { expect, test } from "@playwright/test";
import { openApp } from "./helpers";

test("hovering an icon-only button shows its tooltip after a short delay, and leaving hides it", async ({ page }) => {
  await openApp(page);
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  const tip = page.getByRole("tooltip");

  await settings.hover();
  await expect(tip).toHaveText("Settings (⌘/Ctrl ,)");
  await expect(settings).toHaveAccessibleDescription("Settings (⌘/Ctrl ,)");

  await page.mouse.move(400, 400);
  await expect(tip).toBeHidden();
});

test("keyboard focus shows the tooltip and Escape hides it", async ({ page }) => {
  await openApp(page);
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  const tip = page.getByRole("tooltip");

  for (let i = 0; i < 40 && !(await settings.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(settings).toBeFocused();
  await expect(tip).toHaveText("Settings (⌘/Ctrl ,)");

  await page.keyboard.press("Escape");
  await expect(tip).toBeHidden();
  await expect(settings).toBeFocused();
});

test("a tooltip stays inside the window", async ({ page }) => {
  await openApp(page);
  // The rightmost top-bar button: a tooltip centred under it would overflow the right edge.
  await page.getByRole("button", { name: "Settings", exact: true }).hover();
  const box = (await page.getByRole("tooltip").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test("clicking a button hides its tooltip until the pointer leaves", async ({ page }) => {
  await openApp(page);
  const layout = page.getByRole("button", { name: "Show response below" });
  await layout.hover();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await layout.click();
  await expect(page.getByRole("tooltip")).toBeHidden();
  await page.waitForTimeout(600);
  await expect(page.getByRole("tooltip")).toBeHidden();
});
