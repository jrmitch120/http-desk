// #214: the topbar holds only workspace-level controls: [workspace] ………
// [environment, Manage environments] [update progress, while downloading] [Settings],
// each the toolbar's standard 6px from the next. The sidebar collapses from its own header (#218,
// sidebar-rail.spec.ts), so no sidebar toggle. Import OpenAPI and the theme button aren't
// there; both stay reachable elsewhere (Theme: theme.spec.ts). Problems isn't there
// either: it's in the bottom bar (#217, bottom-bar.spec.ts).
import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialog, importOpenApiButton, menuClick, openApp } from "./helpers";

const topbar = (page: Page) => page.getByRole("banner");
const importer = (page: Page) => dialog(page, "Import OpenAPI specification");

/** Each control in the topbar, in order, by its accessible name. */
function controls(page: Page): Promise<string[]> {
  return topbar(page)
    .locator("button, [role=combobox]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? e.textContent!.trim()));
}

test("the topbar holds, in order, the workspace switcher, the environment picker, Manage environments and Settings: nothing else", async ({ page }) => {
  await openApp(page, "?problems=1");
  expect(await controls(page)).toEqual(["demo", "Active environment", "Manage environments", "Settings"]);
  await expect(topbar(page).getByRole("button", { name: /sidebar/i })).toHaveCount(0);
  await expect(topbar(page).getByRole("button", { name: /Problems/ })).toHaveCount(0);
  await expect(topbar(page).getByRole("button", { name: /Import OpenAPI/ })).toHaveCount(0);
  await expect(topbar(page).getByRole("button", { name: /Theme/ })).toHaveCount(0);
});

test("every control keeps its tooltip with its shortcut hint", async ({ page }) => {
  await openApp(page);
  const tips: [Locator, string][] = [
    [topbar(page).getByRole("combobox", { name: "Active environment" }), "Active environment (⌥⌘E)"],
    [topbar(page).getByRole("button", { name: "Manage environments" }), "Manage environments"],
    [topbar(page).getByRole("button", { name: "Settings" }), "Settings (⌘,)"],
  ];
  for (const [control, tip] of tips) {
    await page.mouse.move(0, 400);
    await control.hover();
    await expect(page.getByRole("tooltip")).toContainText(tip);
  }
});

test("Settings sits the toolbar's standard 6px from the environment, as the tab bar's controls do", async ({ page }) => {
  await openApp(page);
  const box = async (l: Locator) => (await l.boundingBox())!;
  const env = await box(page.locator(".topbar .env"));
  const settings = await box(topbar(page).getByRole("button", { name: "Settings" }));
  expect(Math.round(settings.x - (env.x + env.width))).toBe(6);
});

test.describe("Import OpenAPI, outside the topbar", () => {
  test("opens from the Explorer toolbar", async ({ page }) => {
    await openApp(page);
    await importOpenApiButton(page).click();
    await expect(importer(page)).toBeVisible();
  });

  test("opens from the empty Explorer", async ({ page }) => {
    await page.goto("/?platform=mac&empty=1");
    await expect(page.locator("aside")).toContainText("No .http files yet.");
    await page.locator("aside").getByRole("button", { name: "import OpenAPI", exact: true }).click();
    await expect(importer(page)).toBeVisible();
  });

  test("opens from the command", async ({ page }) => {
    await openApp(page);
    await menuClick(page, "import-openapi");
    await expect(importer(page)).toBeVisible();
  });
});
