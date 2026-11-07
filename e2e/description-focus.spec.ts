// A grid row's description line, reached with the keyboard: Tab lands in it
// ready to type (as a click does), and its focus ring is whole.
import { expect, test, type Page } from "@playwright/test";
import { openApp, openRequest } from "./helpers";

const ring = { style: "solid", width: "2px", color: "rgb(91, 157, 255)" };

/**
 * The focused element's ring and whether all of it shows: its outline box (the
 * border box grown by width + offset) must sit inside the grid's padding box,
 * which clips (`overflow: hidden`).
 */
function focusedRing(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const s = getComputedStyle(el);
    const grow = parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset);
    const r = el.getBoundingClientRect();
    const kv = el.closest(".kv")!;
    const k = kv.getBoundingClientRect();
    const b = getComputedStyle(kv);
    const clip = {
      left: k.left + parseFloat(b.borderLeftWidth),
      right: k.right - parseFloat(b.borderRightWidth),
      top: k.top + parseFloat(b.borderTopWidth),
      bottom: k.bottom - parseFloat(b.borderBottomWidth),
    };
    return {
      outline: { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor },
      clipped: {
        left: r.left - grow < clip.left - 0.01,
        right: r.right + grow > clip.right + 0.01,
        top: r.top - grow < clip.top - 0.01,
        bottom: r.bottom + grow > clip.bottom + 0.01,
      },
    };
  });
}

const sections = [
  { tab: "Params", name: "Add key", key: "google" },
  { tab: "Headers", name: "Add header", key: "X-Google" },
];

for (const { tab, name, key } of sections) {
  test(`${tab}: Tab from a new row's value edits its description, with a whole ring`, async ({ page }) => {
    await openApp(page);
    await openRequest(page, ["api", "pets.http"], "List pets");
    await page.locator(".subtab", { hasText: tab }).click();

    await page.getByPlaceholder(name).fill(key);
    await page.keyboard.press("Tab");
    await page.keyboard.type("{{googleTest}}");
    // The new row: the last one with a delete button (the ghost row has none).
    const row = page.locator(".kv-row").filter({ has: page.getByRole("button", { name: "Delete" }) }).last();
    await expect(row.locator(".c-name")).toHaveValue(key);

    // Value, then the row's delete button, then the description.
    await page.keyboard.press("Tab");
    await expect(row.getByRole("button", { name: "Delete" })).toBeFocused();
    await page.keyboard.press("Tab");
    const desc = row.locator("textarea.desc-edit");
    await expect(desc).toBeFocused();

    const shown = await focusedRing(page);
    expect(shown.outline).toEqual(ring);
    expect(shown.clipped).toEqual({ left: false, right: false, top: false, bottom: false });

    await page.keyboard.type("Search term");
    await expect(desc).toHaveValue("Search term");

    // Shift+Tab goes back, keeping the description; Tab returns to edit it.
    await page.keyboard.press("Shift+Tab");
    await expect(row.getByRole("button", { name: "Delete" })).toBeFocused();
    await expect(row.locator(".desc")).toHaveText("Search term");
    await page.keyboard.press("Shift+Tab");
    await expect(row.locator(".c-value .cm-content")).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(desc).toBeFocused();
    await expect(desc).toHaveValue("Search term");
  });
}

test("Tab into an existing description edits it with the caret at the end", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  const row = page.locator(".kv-row").first();
  await row.getByRole("button", { name: "Delete" }).focus();
  await page.keyboard.press("Tab");
  const desc = row.locator("textarea.desc-edit");
  await expect(desc).toBeFocused();
  expect((await focusedRing(page)).clipped).toEqual({ left: false, right: false, top: false, bottom: false });
  await page.keyboard.type(" Max 100.");
  await expect(desc).toHaveValue("How many pets to return. Default: 20. Max 100.");
});
