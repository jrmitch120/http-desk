// Each tab keeps its own request section and response view (response tab, mode and
// wrap) across tab switches (#149); they live with the tab, for the Layout to save.
import { expect, test, type Page } from "@playwright/test";
import { openApp, openRequest, tab } from "./helpers";

async function send(page: Page): Promise<void> {
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".statusbar .metric").first()).toBeVisible();
}

const section = (page: Page, name: string) => page.locator(".subtab", { hasText: name });
const responseTab = (page: Page, name: string) => page.getByRole("radiogroup", { name: "Response tabs" }).getByRole("radio", { name: new RegExp(`^${name}\\b`) });
const mode = (page: Page, name: string) => page.getByRole("radiogroup", { name: "Response view" }).getByRole("radio", { name });
const wrapButton = (page: Page) => page.getByRole("button", { name: "Wrap lines" });

test("switching tabs keeps each tab's request section and response tab, mode and wrap", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await section(page, "Auth").click();
  await mode(page, "Raw").click();
  await wrapButton(page).click();
  await responseTab(page, "Headers").click();

  await openRequest(page, ["api", "pets.http"], "Create pet");
  await send(page);
  await section(page, "Headers").click();
  await expect(responseTab(page, "Body")).toHaveAttribute("aria-checked", "true");
  await expect(mode(page, "Pretty")).toBeChecked();
  await expect(wrapButton(page)).not.toHaveClass(/active/);

  await tab(page, "List pets").click();
  await expect(section(page, "Auth")).toHaveClass(/active/);
  await expect(responseTab(page, "Headers")).toHaveAttribute("aria-checked", "true");
  await responseTab(page, "Body").click();
  await expect(mode(page, "Raw")).toBeChecked();
  await expect(wrapButton(page)).toHaveClass(/active/);

  await tab(page, "Create pet").click();
  await expect(section(page, "Headers")).toHaveClass(/active/);
  await expect(responseTab(page, "Body")).toHaveAttribute("aria-checked", "true");
  await expect(mode(page, "Pretty")).toBeChecked();
});
