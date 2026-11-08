// Fast environment switching (#78): ⌘⌥E / Ctrl+Alt+E opens the top-bar
// environment picker from anywhere, and the window title names the active
// environment. Since #98 it leads with the active request. The mocked
// workspace `/demo` starts on `local`.
import { expect, test } from "@playwright/test";
import { dialog, mockState, openApp, openRequest, releaseSettings, tab, treeMenu, urlBar } from "./helpers";

test("⌘⌥E opens the environment picker from an editor; typing filters it and Enter switches", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await urlBar(page).click();
  const url = await urlBar(page).textContent();
  const env = page.getByRole("combobox", { name: "Active environment" });
  const list = page.getByRole("listbox", { name: "Active environment" });

  await page.keyboard.press("ControlOrMeta+Alt+E");
  await expect(list).toBeVisible();
  await expect(env).toBeFocused();
  await page.keyboard.type("stag");
  await expect(list.getByRole("option")).toHaveText(["staging"]);
  await page.keyboard.press("Enter");

  await expect(list).toHaveCount(0);
  await expect(env).toHaveText("staging");
  await expect(urlBar(page)).toHaveText(url!); // the editor took none of the keys
  await expect(page.getByRole("dialog", { name: "Environments" })).toHaveCount(0); // not ⌘E's editor
});

test("the window title names the workspace and the active environment", async ({ page }) => {
  await openApp(page);
  await expect.poll(() => mockState(page, "title")).toBe("demo — local");

  const env = page.getByRole("combobox", { name: "Active environment" });
  await env.click();
  await page.getByRole("listbox", { name: "Active environment" }).getByRole("option", { name: "staging" }).click();
  await expect.poll(() => mockState(page, "title")).toBe("demo — staging");

  await env.click();
  await page.getByRole("listbox", { name: "Active environment" }).getByRole("option", { name: "No environment" }).click();
  await expect.poll(() => mockState(page, "title")).toBe("demo");
});

test("the window title names the active request first, and follows it from tab to tab", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await expect.poll(() => mockState(page, "title")).toBe("List pets — demo — local");

  await openRequest(page, ["api", "pets.http"], "Create pet");
  await expect.poll(() => mockState(page, "title")).toBe("Create pet — demo — local");

  await tab(page, "List pets").click();
  await expect.poll(() => mockState(page, "title")).toBe("List pets — demo — local");

  await tab(page, "List pets").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close all", exact: true }).click();
  await expect.poll(() => mockState(page, "title")).toBe("demo — local");
});

test("renaming the active request renames it in the window title", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await treeMenu(page, "List pets", "Rename…");
  await dialog(page, "Rename request").getByRole("textbox").fill("All pets");
  await page.keyboard.press("Enter");
  await expect.poll(() => mockState(page, "title")).toBe("All pets — demo — local");
});

test("switching environment with a request open keeps the request first", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.getByRole("combobox", { name: "Active environment" }).click();
  await page.getByRole("listbox", { name: "Active environment" }).getByRole("option", { name: "staging" }).click();
  await expect.poll(() => mockState(page, "title")).toBe("List pets — demo — staging");
});

test("the window title is just HttpDesk until a workspace is open", async ({ page }) => {
  await page.goto("/?settingsDelay=hold");
  await page.waitForFunction(() => "__mock" in window);
  await expect.poll(() => mockState(page, "title")).toBe("HttpDesk");
  await releaseSettings(page);
  await expect.poll(() => mockState(page, "title")).toBe("demo — local");
});
