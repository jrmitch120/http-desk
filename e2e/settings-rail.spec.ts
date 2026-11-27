// #238: Settings is a fixed-size modal with a rail of six categories down its left
// side (a vertical tablist) and the selected category's page (its tabpanel) on the right.
import { expect, test, type Page } from "@playwright/test";
import { dialog, hasRing, openApp } from "./helpers";

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

// #240: the rail is a vertical tablist from the keyboard.
test("Down and Up move selection and focus between the rail's tabs, and the page follows", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  await categoryTab(page, "General").focus();
  await page.keyboard.press("ArrowDown");
  await expect(categoryTab(page, "Requests")).toBeFocused();
  await expect(categoryTab(page, "Requests")).toHaveAttribute("aria-selected", "true");
  await expect(panel(page, "Requests")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(categoryTab(page, "TLS")).toBeFocused();
  await expect(panel(page, "TLS")).toBeVisible();
  await page.keyboard.press("ArrowUp");
  await expect(categoryTab(page, "Requests")).toBeFocused();
  await expect(rail(page).getByRole("tab", { selected: true })).toHaveText("Requests");
  await expect(panel(page, "Requests")).toBeVisible();
  // Up stops at the first category.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(categoryTab(page, "General")).toBeFocused();
  await expect(panel(page, "General")).toBeVisible();
});

test("only the selected tab is in the Tab order, and Tab from it moves into the page", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  await categoryTab(page, "General").focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(categoryTab(page, "TLS")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(panel(page, "TLS").getByRole("switch", { name: "Verify server certificates" })).toBeFocused();
  // Back out of the page: the selected tab, then what comes before the rail (the modal's Close).
  await page.keyboard.press("Shift+Tab");
  await expect(categoryTab(page, "TLS")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(settings(page).getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(categoryTab(page, "TLS")).toBeFocused();
});

test("the focused tab draws the app's row focus ring", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  await categoryTab(page, "General").click();
  // A click draws no ring; the arrow keys do.
  expect(await hasRing(categoryTab(page, "General"))).toBe(false);
  await page.keyboard.press("ArrowDown");
  await expect(categoryTab(page, "Requests")).toBeFocused();
  expect(await hasRing(categoryTab(page, "Requests"))).toBe(true);
  // The same ring as the app's other selected rows (the inset row ring).
  const shadow = await categoryTab(page, "Requests").evaluate((el) => getComputedStyle(el).boxShadow);
  const token = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.boxShadow = "var(--focus-ring-row-inside)";
    document.body.append(probe);
    const s = getComputedStyle(probe).boxShadow;
    probe.remove();
    return s;
  });
  expect(shadow).toBe(token);
});

test("End and Home select the last and first categories", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  await categoryTab(page, "Requests").click();
  await page.keyboard.press("End");
  await expect(categoryTab(page, "Trusted workspaces")).toBeFocused();
  await expect(rail(page).getByRole("tab", { selected: true })).toHaveText("Trusted workspaces");
  await expect(panel(page, "Trusted workspaces")).toBeVisible();
  await page.keyboard.press("Home");
  await expect(categoryTab(page, "General")).toBeFocused();
  await expect(rail(page).getByRole("tab", { selected: true })).toHaveText("General");
  await expect(panel(page, "General")).toBeVisible();
});
