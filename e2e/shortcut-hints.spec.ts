// Shortcut hints read the way the platform writes shortcuts (#99): "⌘S" on
// macOS, "Ctrl+S" on Windows and Linux. The OS is forced with `?platform=`.
import { expect, test } from "@playwright/test";
import { openApp, openRequest, urlBar } from "./helpers";

for (const { os, send, save, search, environments } of [
  { os: "mac", send: "⌘↩", save: "⌘S", search: "⌘P", environments: "⌘E" },
  { os: "windows", send: "Ctrl+Enter", save: "Ctrl+S", search: "Ctrl+P", environments: "Ctrl+E" },
]) {
  test(`on ${os}, the empty state lists each shortcut as one key cap`, async ({ page }) => {
    await openApp(page, `?platform=${os}`);
    const hints = page.locator(".empty-state .hints > span");
    await expect(hints).toHaveText([`${send} send`, `${save} save`, `${search} search`, `${environments} environments`]);
    await expect(hints.locator("kbd")).toHaveText([send, save, search, environments]);
  });

  test(`on ${os}, the Send and Save tooltips and the response placeholder show ${save}-style hints`, async ({ page }) => {
    await openApp(page, `?platform=${os}`);
    await openRequest(page, ["api", "pets.http"], "List pets");
    const tip = page.getByRole("tooltip");

    await expect(page.locator(".viewer .empty-state kbd")).toHaveText([send]);

    await page.getByRole("button", { name: "Send", exact: true }).hover();
    await expect(tip).toHaveText(`Send (${send})`);

    // Save is disabled until there's something to save.
    await urlBar(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type("?x=1");
    await page.getByRole("button", { name: "Save", exact: true }).hover();
    await expect(tip).toHaveText(`Save (${save})`);
  });
}

for (const { os, hints } of [
  {
    os: "mac",
    hints: {
      "New request": "New request (⌘T)",
      "Manage environments": "Manage environments (⌘E)",
      Settings: "Settings (⌘,)",
      "Show sidebar": "Show sidebar (⌘B)",
      "Active environment": "Active environment (⌥⌘E)",
      Search: "Search (⌘F)",
    },
  },
  {
    os: "windows",
    hints: {
      "New request": "New request (Ctrl+T)",
      "Manage environments": "Manage environments (Ctrl+E)",
      Settings: "Settings (Ctrl+,)",
      "Show sidebar": "Show sidebar (Ctrl+B)",
      "Active environment": "Active environment (Ctrl+Alt+E)",
      Search: "Search (Ctrl+F)",
    },
  },
]) {
  test(`on ${os}, every shortcut tooltip uses the ${os} format`, async ({ page }) => {
    await openApp(page, `?platform=${os}`);
    await openRequest(page, ["api", "pets.http"], "List pets");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("200 OK")).toBeVisible();
    const tip = page.getByRole("tooltip");

    for (const [name, hint] of Object.entries(hints)) {
      await page.getByLabel(name, { exact: true }).hover();
      await expect(tip).toHaveText(hint);
      await page.mouse.move(0, 0);
      await expect(tip).toBeHidden();
    }
  });
}
