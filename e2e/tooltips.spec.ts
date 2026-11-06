// Styled tooltips (use:tooltip) replace native title= tooltips (#43, ADR 0002).
import { expect, test, type Locator } from "@playwright/test";
import { openApp, openRequest, treeItem, urlBar } from "./helpers";

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

test("the context menu, tooltips and CodeMirror tooltips share one surface in the popup layer", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  const surface = (l: Locator) =>
    l.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        inLayer: !!el.closest(".popup-layer"),
        background: s.backgroundColor,
        border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
        radius: s.borderTopLeftRadius,
        shadow: s.boxShadow,
      };
    });

  await page.getByRole("banner").getByRole("button", { name: "Settings", exact: true }).hover();
  const tooltip = await surface(page.getByRole("tooltip"));
  expect(tooltip.inLayer).toBe(true);

  await treeItem(page, "List pets").click({ button: "right" });
  expect(await surface(page.getByRole("menu"))).toEqual(tooltip);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();

  await urlBar(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type("?q={{");
  expect(await surface(page.locator(".cm-tooltip-autocomplete"))).toEqual(tooltip);
});

test("Escape closes an open context menu without closing anything under it", async ({ page }) => {
  await openApp(page);
  await treeItem(page, "api").click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(treeItem(page, "api")).toBeFocused();
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
