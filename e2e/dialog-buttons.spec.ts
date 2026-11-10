import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialog, mockState, openApp, openRequest, treeItem, urlBar } from "./helpers";

// Dialog buttons sit where each OS puts them: the primary rightmost on macOS
// and Linux (GTK), with a destructive alternative apart at the far left; the
// primary first on Windows. Enter and Escape mean the same everywhere.
const platforms = [
  { os: "mac", closeWindow: "Meta+Shift+W", order: ["Don't save", "Cancel", "Save all"], apart: true },
  { os: "windows", closeWindow: "Control+Shift+W", order: ["Save all", "Don't save", "Cancel"], apart: false },
  { os: "linux", closeWindow: "Control+Shift+W", order: ["Don't save", "Cancel", "Save all"], apart: true },
];

/** The dialog's answer buttons, left to right (not its title bar's Close). */
function footerButtons(d: Locator): Locator {
  return d.locator("footer").getByRole("button");
}

/** Edits the List pets request, then asks to close the window. */
async function askUnsaved(page: Page, closeWindow: string): Promise<Locator> {
  await page.keyboard.press(closeWindow);
  const confirm = dialog(page, "Unsaved changes");
  await expect(confirm).toBeVisible();
  return confirm;
}

for (const { os, closeWindow, order, apart } of platforms) {
  test(`on ${os}, the unsaved-changes dialog reads ${order.join(", ")}`, async ({ page }) => {
    await openApp(page, `?platform=${os}`);
    await openRequest(page, ["api", "pets.http"], "List pets");
    await urlBar(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type("&page=2");

    const confirm = await askUnsaved(page, closeWindow);

    await expect(footerButtons(confirm)).toHaveText(order);
    const [first, second, third] = await Promise.all(order.map((name) => confirm.getByRole("button", { name }).boundingBox()));
    const gap = (a: typeof first, b: typeof first) => b!.x - (a!.x + a!.width);
    // "Don't save" sits apart at the far left on macOS and Linux; on Windows all three sit together.
    if (apart) expect(gap(first, second)).toBeGreaterThan(gap(second, third) + 40);
    else expect(Math.abs(gap(first, second) - gap(second, third))).toBeLessThan(2);
  });

  test(`on ${os}, Escape cancels the unsaved-changes dialog and Enter saves all`, async ({ page }) => {
    await openApp(page, `?platform=${os}`);
    await openRequest(page, ["api", "pets.http"], "List pets");
    await urlBar(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type("&page=2");

    let confirm = await askUnsaved(page, closeWindow);
    await expect(confirm.getByRole("button", { name: "Save all" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    expect(await mockState(page, "windowClosed")).toBe(false);

    confirm = await askUnsaved(page, closeWindow);
    await page.keyboard.press("Enter");

    await expect.poll(() => mockState(page, "windowClosed")).toBe(true);
    expect(Object.keys(await mockState(page, "files"))).toContainEqual(expect.stringMatching(/pets\.http$/));
  });

  test(`on ${os}, an irreversible permanent delete still focuses Cancel, wherever it sits`, async ({ page }) => {
    await openApp(page, `?platform=${os}&trash=unavailable`);
    await treeItem(page, "api").click();
    const remove = os === "windows" ? "Delete" : "Move to Trash";
    const unavailable = os === "windows" ? "Couldn't Move to the Recycle Bin" : "Couldn't Move to the Trash";

    await treeItem(page, "pets.http").click({ button: "right" });
    await page.getByRole("menuitem", { name: remove, exact: true }).click();
    await page.keyboard.press("Enter");
    const permanently = dialog(page, unavailable);

    await expect(footerButtons(permanently)).toHaveText(os === "windows" ? ["Delete permanently", "Cancel"] : ["Cancel", "Delete permanently"]);
    await expect(permanently.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(treeItem(page, "pets.http")).toBeVisible();
  });
}
