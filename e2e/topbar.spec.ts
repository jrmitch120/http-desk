// #214: the topbar holds only workspace-level controls, in three groups set apart by
// spacing: [workspace] ……… [environment, Manage environments] · [update progress,
// Problems] · [sidebar, Settings]. Import OpenAPI and the theme button aren't there;
// both stay reachable elsewhere (Theme: theme.spec.ts). Problems is a status indicator, always shown: muted
// at zero, its count in the warning colour with problems, and it opens and closes
// the Problems panel.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialog, importOpenApiButton, menuClick, openApp, openRequest, urlBar } from "./helpers";

const topbar = (page: Page) => page.getByRole("banner");
const problemsToggle = (page: Page) => topbar(page).getByRole("button", { name: /^Show Problems/ });
const problemsPanel = (page: Page) => page.getByRole("region", { name: "Problems" });
const importer = (page: Page) => dialog(page, "Import OpenAPI specification");

/** A theme token (`--warning`) as a computed colour, comparable with an element's computed colour. */
function token(page: Page, name: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, name);
}

const colour = (el: Locator) => el.evaluate((e) => getComputedStyle(e).color);

/** Each control in the topbar, in order, by its accessible name. */
function controls(page: Page): Promise<string[]> {
  return topbar(page)
    .locator("button, [role=combobox]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? e.textContent!.trim()));
}

test("the topbar holds, in order, the workspace switcher, the environment picker, Manage environments, Problems, the sidebar toggle and Settings: nothing else", async ({ page }) => {
  await openApp(page);
  expect(await controls(page)).toEqual(["demo", "Active environment", "Manage environments", "Show Problems", "Show sidebar", "Settings"]);
  await expect(topbar(page).getByRole("button", { name: /Import OpenAPI/ })).toHaveCount(0);
  await expect(topbar(page).getByRole("button", { name: /Theme/ })).toHaveCount(0);
});

test("every control keeps its tooltip with its shortcut hint", async ({ page }) => {
  await openApp(page);
  const tips: [Locator, string][] = [
    [topbar(page).getByRole("combobox", { name: "Active environment" }), "Active environment (⌥⌘E)"],
    [topbar(page).getByRole("button", { name: "Manage environments" }), "Manage environments"],
    [problemsToggle(page), "Problems: none in the workspace's .http files"],
    [topbar(page).getByRole("button", { name: "Show sidebar" }), "Show sidebar (⌘B)"],
    [topbar(page).getByRole("button", { name: "Settings" }), "Settings (⌘,)"],
  ];
  for (const [control, tip] of tips) {
    await page.mouse.move(0, 400);
    await control.hover();
    await expect(page.getByRole("tooltip")).toContainText(tip);
  }
});

test("the environment, status and view-and-app groups are set apart by more space than the controls within a group", async ({ page }) => {
  await openApp(page);
  const box = async (l: Locator) => (await l.boundingBox())!;
  const env = await box(page.locator(".topbar .env"));
  const problems = await box(problemsToggle(page));
  const sidebar = await box(topbar(page).getByRole("button", { name: "Show sidebar" }));
  const settings = await box(topbar(page).getByRole("button", { name: "Settings" }));

  const within = settings.x - (sidebar.x + sidebar.width);
  expect(problems.x - (env.x + env.width), "environment · status").toBeGreaterThan(within);
  expect(sidebar.x - (problems.x + problems.width), "status · view and app").toBeGreaterThan(within);
});

test.describe("Problems", () => {
  test("with no problems it's shown, muted, with no count", async ({ page }) => {
    await openApp(page);
    await expect(problemsToggle(page)).toBeVisible();
    await expect(problemsToggle(page)).toHaveAccessibleName("Show Problems");
    await expect(problemsToggle(page)).toHaveText("");
    await expect.poll(() => colour(problemsToggle(page))).toBe(await token(page, "--muted"));
  });

  test("with problems it shows the count in the warning colour, open or closed", async ({ page }) => {
    await openApp(page, "?problems=1");
    const count = problemsToggle(page).getByText("2", { exact: true });
    await expect(count).toBeVisible();
    const warning = await token(page, "--warning");
    await expect.poll(() => colour(count)).toBe(warning);

    await problemsToggle(page).click();
    await page.mouse.move(0, 400);
    await expect(problemsPanel(page)).toBeVisible();
    await expect.poll(() => colour(count)).toBe(warning);
  });

  test("clicking it opens and closes the panel, and aria-pressed follows", async ({ page }) => {
    await openApp(page);
    await expect(problemsToggle(page)).toHaveAttribute("aria-pressed", "false");

    await problemsToggle(page).click();
    await expect(problemsPanel(page)).toBeVisible();
    await expect(problemsToggle(page)).toHaveAttribute("aria-pressed", "true");

    await problemsToggle(page).click();
    await expect(problemsPanel(page)).toHaveCount(0);
    await expect(problemsToggle(page)).toHaveAttribute("aria-pressed", "false");
  });

  test("clicking it closes the open panel even with focus elsewhere", async ({ page }) => {
    await openApp(page);
    await openRequest(page, ["api", "pets.http"], "List pets");
    await problemsToggle(page).click();
    await expect(problemsPanel(page)).toBeVisible();
    await urlBar(page).click();

    await problemsToggle(page).click();
    await expect(problemsPanel(page)).toHaveCount(0);
    await expect(problemsToggle(page)).toHaveAttribute("aria-pressed", "false");
  });
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
