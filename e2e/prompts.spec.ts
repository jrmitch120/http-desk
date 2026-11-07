import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialog, openApp, openRequest, selectedText, showEnvironmentList, treeItem, treeMenu } from "./helpers";

// Every name prompt keeps everything typed: "ABC" stays "ABC", not "C".
interface Case {
  name: string;
  /** Opens the prompt and returns its title. */
  open: (page: Page) => Promise<string>;
  /** Initially selected text, if the prompt starts with a value. */
  selected?: string;
  /** Where the typed value shows up once confirmed. */
  result: (page: Page) => Locator;
}

const environments = (page: Page) => dialog(page, "Environments");

const cases: Case[] = [
  {
    name: "rename request",
    open: async (page) => {
      await openRequest(page, ["api", "pets.http"], "List pets");
      await treeMenu(page, "List pets", "Rename…");
      return "Rename request";
    },
    selected: "List pets",
    result: (page) => treeItem(page, "ABC"),
  },
  {
    name: "new file",
    open: async (page) => {
      await treeMenu(page, "api", "New .http file");
      return "New .http file";
    },
    selected: "requests",
    result: (page) => treeItem(page, "ABC.http"),
  },
  {
    name: "rename file",
    open: async (page) => {
      await treeItem(page, "api").click();
      await treeMenu(page, "pets.http", "Rename…");
      return "Rename";
    },
    selected: "pets",
    result: (page) => treeItem(page, "ABC.http"),
  },
  {
    name: "new folder",
    open: async (page) => {
      await page.getByRole("button", { name: "New folder", exact: true }).click();
      return "New folder";
    },
    result: (page) => treeItem(page, "ABC"),
  },
  {
    name: "rename folder",
    open: async (page) => {
      await treeMenu(page, "api", "Rename…");
      return "Rename";
    },
    selected: "api",
    result: (page) => treeItem(page, "ABC"),
  },
  {
    name: "new environment",
    open: async (page) => {
      await page.keyboard.press("ControlOrMeta+e");
      await showEnvironmentList(page);
      await environments(page).getByRole("button", { name: "New environment" }).click();
      return "New environment";
    },
    result: (page) => environments(page).getByRole("button", { name: /^ABC\b/ }),
  },
  {
    name: "rename environment",
    open: async (page) => {
      await page.keyboard.press("ControlOrMeta+e");
      await showEnvironmentList(page);
      await environments(page).getByRole("button", { name: /^staging\b/ }).click();
      await environments(page).getByRole("button", { name: "Rename", exact: true }).click();
      return "Rename environment";
    },
    selected: "staging",
    result: (page) => environments(page).getByRole("button", { name: /^ABC\b/ }),
  },
];

for (const c of cases) {
  test(`typing "ABC" into the ${c.name} prompt keeps all of it`, async ({ page }) => {
    await openApp(page);
    const title = await c.open(page);
    const input = dialog(page, title).getByRole("textbox");
    await expect(input).toBeFocused();
    if (c.selected) expect(await selectedText(input)).toBe(c.selected);

    await page.keyboard.type("ABC");
    await page.keyboard.press("Enter");

    await expect(dialog(page, title)).toBeHidden();
    await expect(c.result(page)).toBeVisible();
  });
}
