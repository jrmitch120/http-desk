// #238: Settings is a fixed-size modal with a rail of six categories down its left
// side (a vertical tablist) and the selected category's page (its tabpanel) on the right.
import { expect, test, type Page } from "@playwright/test";
import { dialog, openApp } from "./helpers";

const CATEGORIES = ["General", "Requests", "TLS", "Portability", "History", "Trusted workspaces"];

const settings = (page: Page) => dialog(page, "Settings");
const rail = (page: Page) => settings(page).getByRole("tablist", { name: "Settings categories" });
const categoryTab = (page: Page, name: string) => rail(page).getByRole("tab", { name, exact: true });
const panel = (page: Page, name: string) => settings(page).getByRole("tabpanel", { name, exact: true });

test("the rail lists the six categories in order, each with an icon, General selected from the gear", async ({ page }) => {
  await openApp(page);
  await page.getByRole("banner").getByRole("button", { name: "Settings" }).click();
  await expect(rail(page)).toHaveAttribute("aria-orientation", "vertical");
  await expect(rail(page).getByRole("tab")).toHaveText(CATEGORIES);
  for (const name of CATEGORIES) await expect(categoryTab(page, name).locator("svg")).toBeVisible();
  await expect(rail(page).getByRole("tab", { selected: true })).toHaveText("General");
  await expect(panel(page, "General")).toBeVisible();
});

test("Settings opened with ⌘, shows General", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  await expect(rail(page).getByRole("tab", { selected: true })).toHaveText("General");
  await expect(panel(page, "General")).toBeVisible();
});

test("clicking a tab shows only that category's page, with its heading", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  await categoryTab(page, "TLS").click();
  await expect(categoryTab(page, "TLS")).toHaveAttribute("aria-selected", "true");
  await expect(categoryTab(page, "General")).toHaveAttribute("aria-selected", "false");
  await expect(settings(page).getByRole("tabpanel")).toHaveCount(1);
  await expect(panel(page, "TLS").getByRole("heading", { name: "TLS" })).toBeVisible();
  await expect(panel(page, "TLS").getByRole("switch", { name: "Verify server certificates" })).toBeVisible();
  // General's settings are not shown.
  await expect(settings(page).getByRole("radiogroup", { name: "Theme" })).toHaveCount(0);
});

test("every setting sits under its new category", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  const expected: Record<string, string[]> = {
    General: ["Theme", "Response position", "Show parameter descriptions", "Check for updates on startup", "Check now"],
    Requests: ["Idle timeout", "Connection timeout", "Follow redirects", "Maximum redirects", "Maximum body size"],
    TLS: ["Verify server certificates", "CA certificate", "Client certificate", "Client key"],
    Portability: ["VS Code", "Rider", "Show portability notes as warnings"],
    History: ["Record History", "Entries per request", "Keep for", "Total size", "Location", "Clear all history"],
  };
  for (const [category, labels] of Object.entries(expected)) {
    await categoryTab(page, category).click();
    await expect(panel(page, category).locator(".setting > .label > span:first-child")).toHaveText(labels);
  }
  await categoryTab(page, "General").click();
  await expect(panel(page, "General")).toContainText("Downloads come from the project's GitHub releases");
  await expect(panel(page, "General").getByRole("button", { name: "Check for updates" })).toBeVisible();
  await categoryTab(page, "Requests").click();
  await expect(panel(page, "Requests")).toContainText("Larger responses are truncated");
  await expect(panel(page, "Requests")).toContainText("directives override these defaults");
  await categoryTab(page, "Trusted workspaces").click();
  await expect(panel(page, "Trusted workspaces")).toContainText("No workspace is trusted yet.");
});

test("the bottom bar's items open Settings on their category, whichever was shown before", async ({ page }) => {
  await openApp(page);
  const bottomBar = page.getByRole("contentinfo", { name: "Bottom bar" });
  for (const [item, category] of [
    [/^Portability/, "Portability"],
    [/^History/, "History"],
    [/^Scripts/, "Trusted workspaces"],
  ] as const) {
    await page.keyboard.press("Meta+Comma");
    await categoryTab(page, "Requests").click();
    await settings(page).getByRole("button", { name: "Done" }).click();
    await bottomBar.getByRole("button", { name: item }).click();
    await expect(rail(page).getByRole("tab", { selected: true })).toHaveText(category);
    await expect(panel(page, category)).toBeVisible();
    await settings(page).getByRole("button", { name: "Done" }).click();
  }
});

test("the modal keeps its size across categories, and a long Trusted workspaces list scrolls inside the page", async ({ page }) => {
  // The smallest window HttpDesk allows.
  await page.setViewportSize({ width: 960, height: 600 });
  const many = Array.from({ length: 30 }, (_, i) => `/work/project-${i}`);
  await openApp(page, `?trusted=${many.join(",")}`);
  await page.keyboard.press("Meta+Comma");
  // Measured once it has finished popping in.
  await settings(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const first = (await settings(page).boundingBox())!;
  expect(first.y).toBeGreaterThanOrEqual(0);
  expect(first.y + first.height).toBeLessThanOrEqual(600);
  for (const name of CATEGORIES) {
    await categoryTab(page, name).click();
    expect(await settings(page).boundingBox()).toEqual(first);
  }
  const trust = panel(page, "Trusted workspaces");
  const rows = trust.getByTestId("trusted-workspace");
  await expect(rows).toHaveCount(30);
  const done = settings(page).getByRole("button", { name: "Done" });
  const [railBefore, doneBefore] = [await rail(page).boundingBox(), await done.boundingBox()];
  await expect(rows.last()).not.toBeInViewport();
  await rows.last().scrollIntoViewIfNeeded();
  await expect(rows.last()).toBeInViewport();
  expect(await trust.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await rail(page).boundingBox()).toEqual(railBefore);
  expect(await done.boundingBox()).toEqual(doneBefore);
  await expect(done).toBeInViewport();
});

// #239: Settings reopens on the category last selected during this run, General after
// a reload, and a deep link selects (and is then remembered as) its own category.
test.describe("Settings reopens on the last-visited category", () => {
  const gear = (page: Page) => page.getByRole("banner").getByRole("button", { name: "Settings" });
  const done = (page: Page) => settings(page).getByRole("button", { name: "Done" });
  const selected = (page: Page) => rail(page).getByRole("tab", { selected: true });

  test("selecting Requests, closing and reopening from the gear shows Requests", async ({ page }) => {
    await openApp(page);
    await gear(page).click();
    await categoryTab(page, "Requests").click();
    await done(page).click();
    await gear(page).click();
    await expect(selected(page)).toHaveText("Requests");
    await expect(panel(page, "Requests")).toBeVisible();
    // ⌘, opens there too.
    await done(page).click();
    await page.keyboard.press("Meta+Comma");
    await expect(selected(page)).toHaveText("Requests");
  });

  test("after a reload, Settings opens on General again", async ({ page }) => {
    await openApp(page);
    await gear(page).click();
    await categoryTab(page, "TLS").click();
    await done(page).click();
    await openApp(page);
    await gear(page).click();
    await expect(selected(page)).toHaveText("General");
    await expect(panel(page, "General")).toBeVisible();
  });

  test("a deep link selects its own category, which the gear then reopens on", async ({ page }) => {
    await openApp(page);
    await gear(page).click();
    await categoryTab(page, "Requests").click();
    await done(page).click();
    await page.getByRole("contentinfo", { name: "Bottom bar" }).getByRole("button", { name: /^History/ }).click();
    await expect(selected(page)).toHaveText("History");
    await done(page).click();
    await gear(page).click();
    await expect(selected(page)).toHaveText("History");
    await expect(panel(page, "History")).toBeVisible();
  });
});
