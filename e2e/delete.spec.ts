import { expect, test } from "@playwright/test";
import { dialog, openApp, treeItem, treeMenu } from "./helpers";

test("Move to Trash removes the file after one confirmation", async ({ page }) => {
  await openApp(page);
  await treeItem(page, "api").click();

  await treeMenu(page, "pets.http", "Move to Trash");
  await dialog(page, "Move to Trash").getByRole("button", { name: "Move to Trash" }).click();

  await expect(treeItem(page, "pets.http")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("when the trash is unavailable, Cancel keeps the file and only an explicit yes deletes it", async ({ page }) => {
  await openApp(page, "?trash=unavailable");
  await treeItem(page, "api").click();

  await treeMenu(page, "pets.http", "Move to Trash");
  await dialog(page, "Move to Trash").getByRole("button", { name: "Move to Trash" }).click();
  await dialog(page, "Couldn't Move to the Trash").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(treeItem(page, "pets.http")).toBeVisible();

  await treeMenu(page, "pets.http", "Move to Trash");
  await dialog(page, "Move to Trash").getByRole("button", { name: "Move to Trash" }).click();
  await dialog(page, "Couldn't Move to the Trash").getByRole("button", { name: "Delete permanently" }).click();
  await expect(treeItem(page, "pets.http")).toHaveCount(0);
});
