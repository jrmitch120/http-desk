// The Response position button (#213): it sits at the right end of a request tab's
// response status bar, in every state of the pane, and nowhere else. It is an action,
// not a toggle: its name, icon and tooltip say where a click moves the response;
// clicking it or ⌥⌘R / Ctrl+Alt+R moves the response, and the choice is kept in settings.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { bodyEditor, openApp, openRequest, urlBar } from "./helpers";

const toggle = (scope: Page | Locator) => scope.getByRole("button", { name: /^Move response (below|to the right)$/ });
const split = (page: Page) => page.getByRole("separator", { name: "Resize request and response" });
/** The response pane's status bar: the one holding the Response/History switch. */
const statusBar = (page: Page) => page.locator(".statusbar").filter({ has: page.getByRole("radiogroup", { name: "Response pane" }) });

/** Whether the response shows below the request (the split stacked), or on the right. */
async function expectPosition(page: Page, position: "right" | "below") {
  await expect(split(page)).toHaveAttribute("aria-orientation", position === "below" ? "horizontal" : "vertical");
  // It offers the other position, and is never shown pressed (docs/controls.md).
  await expect(toggle(page)).toHaveAccessibleName(position === "below" ? "Move response to the right" : "Move response below");
  await expect(toggle(page)).not.toHaveAttribute("aria-pressed");
  await expect(toggle(page)).not.toHaveClass(/\bactive\b/);
}

/** The toggle is the last thing in the status bar, at its right edge. */
async function expectAtRightEnd(page: Page) {
  const bar = statusBar(page);
  await expect(toggle(bar)).toBeVisible();
  const barBox = (await bar.boundingBox())!;
  const box = (await toggle(page).boundingBox())!;
  expect(barBox.x + barBox.width - (box.x + box.width)).toBeLessThanOrEqual(16);
  const last = await bar.evaluate((el) => {
    const buttons = [...el.querySelectorAll("button")].filter((b) => b.getBoundingClientRect().width > 0);
    return buttons.at(-1)?.getAttribute("aria-label");
  });
  expect(last).toMatch(/^Move response /);
}

test("the topbar has no Response position button", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  const topbar = page.getByRole("banner");
  await expect(topbar.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(topbar.getByRole("button", { name: /response/i })).toHaveCount(0);
});

test("a never-sent request with no History shows the status bar, titled Response, with the toggle", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await expect(page.getByText("Click Send to get a response")).toBeVisible();
  await expect(statusBar(page).getByText("Response", { exact: true })).toBeVisible();
  await expectAtRightEnd(page);
});

test("the toggle stays at the status bar's right end while sending, with a response, and showing History", async ({ page }) => {
  await openApp(page, "?download=slow");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+Enter");
  await expect(statusBar(page).getByText(/Sending…/)).toBeVisible();
  await expectAtRightEnd(page);

  await expect(statusBar(page).getByText("200 OK")).toBeVisible({ timeout: 5000 });
  await expectAtRightEnd(page);

  await statusBar(page).getByRole("radio", { name: "History" }).click();
  await expect(page.getByRole("list", { name: "History entries" })).toBeVisible();
  await expectAtRightEnd(page);
});

test("the toggle stays at the status bar's right end after a cancel", async ({ page }) => {
  await openApp(page, "?download=slow");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+Enter");
  await statusBar(page).getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Request cancelled.")).toBeVisible();
  await expectAtRightEnd(page);
});

test("the toggle stays at the status bar's right end after a send error", async ({ page }) => {
  await openApp(page, "?sendError=dns");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByRole("alert").filter({ hasText: "Host not found" })).toBeVisible();
  await expectAtRightEnd(page);
});

test("History entry views have no toggle", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+Enter");
  await expect(statusBar(page).getByText("200 OK")).toBeVisible({ timeout: 5000 });

  // An entry opened in the tab's History view.
  await statusBar(page).getByRole("radio", { name: "History" }).click();
  await page.getByRole("list", { name: "History entries" }).getByRole("listitem").first().click();
  const inTab = page.getByRole("region", { name: "History entry" });
  await expect(inTab).toBeVisible();
  await expect(toggle(inTab)).toHaveCount(0);
  await page.getByRole("button", { name: "Back to History" }).click();

  // An entry opened from the sidebar's History.
  await page.getByRole("radiogroup", { name: "Sidebar" }).getByRole("radio", { name: "History" }).click();
  await page.getByRole("region", { name: "Workspace History" }).getByRole("listitem").first().click();
  const fromSidebar = page.getByRole("dialog", { name: "History entry" });
  await expect(fromSidebar).toBeVisible();
  await expect(toggle(fromSidebar)).toHaveCount(0);
});

test("clicking the toggle moves the response, and the choice survives a reload", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await expectPosition(page, "right");

  await toggle(page).click();
  await expectPosition(page, "below");

  await page.reload();
  await openRequest(page, ["api", "pets.http"], "List pets");
  await expectPosition(page, "below");

  await toggle(page).click();
  await expectPosition(page, "right");
});

test("the icon and tooltip show where a click moves the response, and the shortcut", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  const icon = () => toggle(page).locator("svg").innerHTML();
  const offersBelow = await icon();

  await toggle(page).hover();
  await expect(page.getByRole("tooltip")).toHaveText("Move response below (⌥⌘R)");

  await toggle(page).click();
  await expectPosition(page, "below");
  const offersRight = await icon();
  expect(offersRight).not.toBe(offersBelow);
  await page.mouse.move(0, 0);
  await toggle(page).hover();
  await expect(page.getByRole("tooltip")).toHaveText("Move response to the right (⌥⌘R)");

  await toggle(page).click();
  await expectPosition(page, "right");
  expect(await icon()).toBe(offersBelow);
});

test("the icon is the Settings choice a click picks", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  const offersBelow = await toggle(page).locator("svg").innerHTML();
  await page.getByRole("banner").getByRole("button", { name: "Settings" }).click();
  const below = page.getByRole("radiogroup", { name: "Response position" }).getByRole("radio", { name: "Response below" });
  expect(await below.locator("svg").innerHTML()).toBe(offersBelow);
});

test("screen readers hear what a click does, as the button's name", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await expect(toggle(page)).toHaveAccessibleName("Move response below");

  await page.keyboard.press("Meta+Alt+KeyR");
  await expect(toggle(page)).toHaveAccessibleName("Move response to the right");
});

for (const { os, keys, hint } of [
  { os: "mac", keys: "Meta+Alt+KeyR", hint: "⌥⌘R" },
  { os: "windows", keys: "Control+Alt+KeyR", hint: "Ctrl+Alt+R" },
  { os: "linux", keys: "Control+Alt+KeyR", hint: "Ctrl+Alt+R" },
]) {
  test(`on ${os}, ${hint} moves the response from anywhere, the URL bar and body editor included`, async ({ page }) => {
    await openApp(page, `?platform=${os}`);
    await openRequest(page, ["api", "pets.http"], "Create pet");
    await toggle(page).hover();
    await expect(page.getByRole("tooltip")).toContainText(`(${hint})`);

    await page.getByRole("tree", { name: "Explorer" }).focus();
    await page.keyboard.press(keys);
    await expectPosition(page, "below");

    await urlBar(page).click();
    const url = await urlBar(page).textContent();
    await page.keyboard.press(keys);
    await expectPosition(page, "right");
    await expect(urlBar(page)).toHaveText(url!);

    await page.getByRole("button", { name: "Body" }).click();
    const body = bodyEditor(page);
    const lines = await body.locator(".cm-line").allTextContents();
    await body.click();
    await page.keyboard.press(keys);
    await expectPosition(page, "below");
    await expect(body.locator(".cm-line")).toHaveText(lines);
  });
}
