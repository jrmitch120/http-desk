// Pretty is offered only where the core can format the body (JSON and XML).
// For HTML or plain text it would show the same text as Raw, so it isn't there.
import { expect, test, type Page } from "@playwright/test";
import { openApp, openRequest } from "./helpers";

async function send(page: Page, response: string): Promise<void> {
  await openApp(page, `?response=${response}`);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.locator(".statusbar .metric").first()).toBeVisible();
}

const views = (page: Page) => page.getByRole("radiogroup", { name: "Response view" });

test("a JSON response offers Pretty and Raw, and opens in Pretty", async ({ page }) => {
  await send(page, "bigint");
  await expect(views(page).getByRole("radio")).toHaveText(["Pretty", "Raw"]);
  await expect(views(page).getByRole("radio", { name: "Pretty" })).toBeChecked();
});

test("an HTML response offers Raw and Preview, not Pretty, and opens in Raw", async ({ page }) => {
  await send(page, "html");
  await expect(views(page).getByRole("radio")).toHaveText(["Raw", "Preview"]);
  await expect(views(page).getByRole("radio", { name: "Raw" })).toBeChecked();
  await expect(page.locator(".body .cm-content")).toContainText("<h1>Pets</h1>");
});

test("a plain-text response has no view switch, only its text", async ({ page }) => {
  await send(page, "text");
  await expect(views(page)).toHaveCount(0);
  await expect(page.locator(".body .cm-content")).toContainText("pets: 2");
});
