import { expect, test, type Page } from "@playwright/test";
import { tab, openApp, treeItem } from "./helpers";

// A Preview tab whose request another editor removes closes quietly; it never
// becomes an Orphaned tab (GLOSSARY: Preview tab). A kept tab still does.

const PETS = "/demo/api/pets.http";
const tabs = (page: Page) => page.getByRole("tablist", { name: "Open requests" }).getByRole("tab");

/** Another editor removes the request named `name` from api/pets.http. */
async function removeOnDisk(page: Page, name: string) {
  await page.evaluate(
    ([path, gone]) => {
      type Mock = { files: Record<string, { requests: { name: string }[] }>; changeFile(path: string, file: unknown): Promise<void> };
      const mock = (window as unknown as { __mock: Mock }).__mock;
      const file = mock.files[path];
      return mock.changeFile(path, { ...file, requests: file.requests.filter((r) => r.name !== gone) });
    },
    [PETS, name],
  );
}

test("a Preview tab whose request another editor removes closes, with no toast and nothing to reopen", async ({ page }) => {
  await openApp(page);
  await treeItem(page, "api").click();
  await treeItem(page, "pets.http").click();
  await treeItem(page, "List pets").dblclick();
  await treeItem(page, "Create pet").click();
  await expect(tabs(page)).toHaveCount(2);

  await removeOnDisk(page, "Create pet");

  await expect(tabs(page)).toHaveCount(1);
  await expect(tab(page, "List pets")).not.toHaveClass(/\borphaned\b/);
  await expect(page.locator(".toast")).toHaveCount(0);

  // Reopen Closed Tab has nothing to bring back.
  await page.keyboard.press("ControlOrMeta+Shift+T");
  await expect(tabs(page)).toHaveCount(1);
});

test("a kept tab whose request another editor removes still becomes an Orphaned tab", async ({ page }) => {
  await openApp(page);
  await treeItem(page, "api").click();
  await treeItem(page, "pets.http").click();
  await treeItem(page, "Create pet").dblclick();

  await removeOnDisk(page, "Create pet");

  await expect(tab(page, "Create pet")).toHaveClass(/\borphaned\b/);
  await expect(tabs(page)).toHaveCount(1);
});
