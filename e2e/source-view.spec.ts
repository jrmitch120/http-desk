// The .http button shows a request's source in place of its sections. Like the
// Resolved toggle, it's an app setting: it stays on across tabs, sends and restarts.
import { expect, test, type Page } from "@playwright/test";
import { mockState, openApp, openRequest, tab } from "./helpers";

const toggle = (page: Page) => page.getByRole("button", { name: ".http", exact: true });
const source = (page: Page) => page.locator(".source-code");

test("the .http source stays shown across tabs, sends and a reload, and is remembered", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");

  await toggle(page).click();
  await expect(source(page)).toContainText("### List pets");
  expect((await mockState(page, "settings")).showSource).toBe(true);

  // Another request, then back to the first tab.
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(source(page)).toContainText("### Create pet");
  await tab(page, "List pets").click();
  await expect(source(page)).toContainText("### List pets");

  // A send keeps it.
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".statusbar .metric").first()).toBeVisible();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");

  await page.reload();
  await openRequest(page, ["api", "pets.http"], "List pets");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(source(page)).toContainText("### List pets");

  await toggle(page).click();
  await expect(source(page)).toHaveCount(0);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  expect((await mockState(page, "settings")).showSource).toBe(false);
});
