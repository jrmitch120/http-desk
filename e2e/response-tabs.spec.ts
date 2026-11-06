// The response viewer's Body / Headers / Cookies / Timing / Request switch is the design-system
// SegmentedControl, and a tab can show a count of what's inside it.
import { expect, test, type Page } from "@playwright/test";
import { openApp, openRequest } from "./helpers";

function viewerTabs(page: Page) {
  return page.getByRole("radiogroup", { name: "Response tabs" });
}

async function sendListPets(page: Page) {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(viewerTabs(page)).toBeVisible();
}

test("clicking a viewer tab shows its panel", async ({ page }) => {
  await sendListPets(page);
  const tabs = viewerTabs(page);
  const tab = (name: string) => tabs.getByRole("radio", { name: new RegExp(`^${name}\\b`) });
  await expect(tab("Body")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".body .cm-content")).toContainText('"items"');

  await tab("Headers").click();
  await expect(tab("Headers")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("cell", { name: "x-powered-by" })).toBeVisible();
  await expect(page.locator(".body .cm-content")).toHaveCount(0);

  await tab("Request").click();
  await expect(tab("Request")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("A reconstruction of the final request")).toBeVisible();
  await expect(tabs.getByRole("radio", { checked: true })).toHaveCount(1);

  await tab("Body").click();
  await expect(page.locator(".body .cm-content")).toContainText('"items"');
});

test("the arrow keys move between viewer tabs, showing each panel", async ({ page }) => {
  await sendListPets(page);
  const tabs = viewerTabs(page);
  const tab = (name: string) => tabs.getByRole("radio", { name: new RegExp(`^${name}\\b`) });
  await tab("Body").focus();

  await page.keyboard.press("ArrowRight");
  await expect(tab("Headers")).toBeFocused();
  await expect(tab("Headers")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("cell", { name: "x-powered-by" })).toBeVisible();

  await page.keyboard.press("ArrowRight");
  await expect(tab("Cookies")).toBeFocused();
  await expect(page.getByText("This response set no cookies")).toBeVisible();

  await page.keyboard.press("ArrowRight");
  await expect(tab("Timing")).toBeFocused();
  await expect(page.getByRole("list", { name: "Timing phases" })).toBeVisible();

  await page.keyboard.press("ArrowRight");
  await expect(tab("Request")).toBeFocused();
  await expect(page.getByText("A reconstruction of the final request")).toBeVisible();

  await page.keyboard.press("ArrowRight");
  await expect(tab("Body")).toBeFocused();
  await expect(page.locator(".body .cm-content")).toContainText('"items"');

  await page.keyboard.press("ArrowLeft");
  await expect(tab("Request")).toHaveAttribute("aria-checked", "true");
  await expect(tabs.locator('[tabindex="0"]')).toHaveCount(1);
});

test("the Headers tab counts the response headers; tabs without a count show none", async ({ page }) => {
  await sendListPets(page);
  const tabs = viewerTabs(page);
  const radios = tabs.getByRole("radio");
  await expect(radios).toHaveCount(5);
  await expect(radios.nth(0)).toHaveAccessibleName("Body");
  await expect(radios.nth(1)).toHaveAccessibleName("Headers 4");
  await expect(radios.nth(2)).toHaveAccessibleName("Cookies");
  await expect(radios.nth(3)).toHaveAccessibleName("Timing");
  await expect(radios.nth(4)).toHaveAccessibleName("Request");
  await expect(tabs.getByRole("radio", { name: "Headers" }).locator(".count")).toHaveText("4");
  await expect(tabs.locator(".count")).toHaveCount(1);

  // The count follows the response.
  await openRequest(page, ["api", "pets.http"], "Get pet image");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(tabs.getByRole("radio", { name: "Headers" })).toHaveAccessibleName("Headers 2");
});

test("each editor tab remembers its viewer tab", async ({ page }) => {
  await sendListPets(page);
  const tab = (name: string) => viewerTabs(page).getByRole("radio", { name: new RegExp(`^${name}\\b`) });
  await tab("Request").click();

  await openRequest(page, ["api", "pets.http"], "Create pet");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(tab("Body")).toHaveAttribute("aria-checked", "true");

  await openRequest(page, ["api", "pets.http"], "List pets");
  await expect(tab("Request")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("A reconstruction of the final request")).toBeVisible();
});
