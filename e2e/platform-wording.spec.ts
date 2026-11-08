import { expect, test } from "@playwright/test";
import { dialog, openApp, treeItem } from "./helpers";

// Each OS's own words for its file manager and its trash. The OS is forced
// with `?platform=`, so every case runs on any test machine.
const platforms = [
  { os: "mac", reveal: "Reveal in Finder", remove: "Move to Trash", trash: "the Trash" },
  { os: "windows", reveal: "Show in File Explorer", remove: "Delete", trash: "the Recycle Bin" },
  { os: "linux", reveal: "Open Containing Folder", remove: "Move to Trash", trash: "the Trash" },
];

for (const { os, reveal, remove, trash } of platforms) {
  test(`on ${os}, a file's and a folder's context menus say "${reveal}" and "${remove}"`, async ({ page }) => {
    await openApp(page, `?platform=${os}`);
    await treeItem(page, "api").click();

    for (const row of ["api", "pets.http"]) {
      await treeItem(page, row).click({ button: "right" });
      const menu = page.getByRole("menu");
      await expect(menu.getByRole("menuitem", { name: reveal, exact: true })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: remove, exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
    }
  });

  test(`on ${os}, deleting asks to move it to ${trash}`, async ({ page }) => {
    await openApp(page, `?platform=${os}`);
    await treeItem(page, "api").click();

    await treeItem(page, "pets.http").click({ button: "right" });
    await page.getByRole("menuitem", { name: remove, exact: true }).click();
    const confirm = dialog(page, remove);
    await expect(confirm).toContainText(`Move "pets.http" to ${trash}?`);
    await confirm.getByRole("button", { name: remove, exact: true }).click();

    await expect(treeItem(page, "pets.http")).toHaveCount(0);
  });

  test(`on ${os}, when ${trash} is unavailable, the permanent delete reads the same as everywhere`, async ({ page }) => {
    await openApp(page, `?platform=${os}&trash=unavailable`);
    await treeItem(page, "api").click();

    await treeItem(page, "pets.http").click({ button: "right" });
    await page.getByRole("menuitem", { name: remove, exact: true }).click();
    await dialog(page, remove).getByRole("button", { name: remove, exact: true }).click();
    const permanently = dialog(page, `Couldn't Move to ${trash}`);
    await expect(permanently).toContainText(`Delete "pets.http" permanently? This can't be undone.`);
    await permanently.getByRole("button", { name: "Delete permanently" }).click();

    await expect(treeItem(page, "pets.http")).toHaveCount(0);
  });
}
