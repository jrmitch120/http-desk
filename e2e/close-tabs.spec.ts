import { expect, test } from "@playwright/test";
import { dialog, openApp, openRequest, tab, urlBar } from "./helpers";

test("Close all asks about each unsaved tab in turn, and Cancel keeps the rest open", async ({ page }) => {
  await openApp(page);
  for (const name of ["List pets", "Create pet", "Get pet image"]) {
    await openRequest(page, ["api", "pets.http"], name);
    await urlBar(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type("x");
  }

  await tab(page, "Create pet").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close all", exact: true }).click();

  await dialog(page, 'Save changes to "List pets"?').getByRole("button", { name: "Don't save" }).click();
  await dialog(page, 'Save changes to "Create pet"?').getByRole("button", { name: "Cancel" }).click();

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(tab(page, "List pets")).toHaveCount(0);
  await expect(tab(page, "Create pet")).toBeVisible();
  await expect(tab(page, "Get pet image")).toBeVisible();
});
