// #214: the topbar holds only workspace-level controls, in groups set apart by
// spacing: [workspace] ……… [environment, Manage environments] · [update progress,
// while downloading] · [Settings]. The sidebar collapses from its own header (#218,
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

test("the environment and view-and-app groups are set apart by more space than the controls within a group", async ({ page }) => {
  await openApp(page);
  const box = async (l: Locator) => (await l.boundingBox())!;
  const env = await box(page.locator(".topbar .env"));
  const manage = await box(topbar(page).getByRole("button", { name: "Manage environments" }));
  const picker = await box(topbar(page).getByRole("combobox", { name: "Active environment" }));
  const settings = await box(topbar(page).getByRole("button", { name: "Settings" }));

  const within = manage.x - (picker.x + picker.width);
  expect(settings.x - (env.x + env.width), "environment · view and app").toBeGreaterThan(within);
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
