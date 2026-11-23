// HttpDesk draws keyboard focus itself (ADR-0002): a key press turns focus marks
// on and a mouse press turns them off, the same in every webview. macOS's system
// webview doesn't match :focus-visible when a script moves focus after a click,
// so these tests check what's drawn (the computed outline) after click → key.
// Runs in Chromium and WebKit.
import { expect, test, type Locator } from "@playwright/test";
import { openApp, openRequest, tab, treeItem } from "./helpers";

/** The focused element's outline (or its descendant `part`'s), as drawn. */
function outlineOf(el: Locator, part?: string) {
  return el.evaluate((node, part) => {
    const s = getComputedStyle(part ? node.querySelector(part)! : node);
    return { style: s.outlineStyle, width: s.outlineWidth };
  }, part);
}

async function expectRing(el: Locator, part?: string) {
  await expect(el).toBeFocused();
  await expect.poll(() => outlineOf(el, part)).not.toEqual(expect.objectContaining({ style: "none" }));
}

async function expectNoRing(el: Locator, part?: string) {
  await expect(el).toBeFocused();
  await expect.poll(() => outlineOf(el, part)).toEqual(expect.objectContaining({ style: "none" }));
}

test("after clicking an Explorer row, Down shows the ring on the row it reaches", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await treeItem(page, "List pets").click();
  await page.keyboard.press("ArrowDown");
  await expectRing(treeItem(page, "Create pet"));
});

test("a clicked row shows no ring, and a key press brings it back", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  const row = treeItem(page, "Create pet");
  await row.click();
  await expectNoRing(row);
  // Shift alone neither moves nor acts, so the ring stays off.
  await page.keyboard.press("Shift");
  await expectNoRing(row);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await expectRing(row);
});

test("a shortcut or a typed letter on a clicked row shows no ring; a focus command does", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  const row = treeItem(page, "Create pet");
  await row.click();
  // Neither moves nor acts on the row: the ring stays off.
  await page.keyboard.press("Meta+C");
  await expectNoRing(row);
  await page.keyboard.press("x");
  await expectNoRing(row);
  // Focus Explorer is a keyboard command that moves focus: where it lands is ringed.
  await page.keyboard.press("Meta+Shift+E");
  await expectRing(row);
});

test("a context menu opened with a right-click shows the ring on the item the arrows reach", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await treeItem(page, "Create pet").click({ button: "right" });
  const item = (name: string) => page.getByRole("menuitem", { name, exact: true });
  await expectNoRing(item("Open"));
  await page.keyboard.press("ArrowDown");
  await expectRing(item("Rename…"));
});

test("tabs show the ring when arrowed after a click", async ({ page }) => {
  await openApp(page);
  for (const name of ["List pets", "Create pet"]) await openRequest(page, ["api", "pets.http"], name);
  await tab(page, "Create pet").click();
  await expectNoRing(tab(page, "Create pet"));
  await page.keyboard.press("ArrowLeft");
  await expectRing(tab(page, "List pets"));
});

test("a dropdown shows the ring when arrowed after a click", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  const method = page.getByRole("combobox", { name: "Method" });
  await method.click();
  await expectNoRing(method);
  await page.keyboard.press("ArrowDown");
  await expectRing(method);
});

/** What marks a row shows: its selection fill, its hover fill (laid over), its focus ring and its left edge. */
function marksOf(row: Locator) {
  return row.evaluate((el) => {
    const s = getComputedStyle(el);
    return { fill: s.backgroundColor, hover: s.backgroundImage, ring: s.outlineStyle, edge: s.borderLeftColor };
  });
}

test("focus ring, selection fill and hover fill differ, and one row can show all three", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  const open = treeItem(page, "List pets");
  const row = treeItem(page, "Create pet");
  const next = treeItem(page, "Get pet image");
  await open.click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press(" ");
  await expect(row).toHaveAttribute("aria-selected", "true");
  const box = (await row.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  // Selected, focused and hovered at once.
  const all = await marksOf(row);
  const none = "rgba(0, 0, 0, 0)";
  expect(all.fill).not.toBe(none);
  expect(all.hover).not.toBe("none");
  expect(all.ring).toBe("solid");

  // Each mark alone: focus is only the ring, selection only the fill, hover only its fainter fill.
  await page.keyboard.press("ArrowDown");
  await expectRing(next);
  expect(await marksOf(next)).toEqual(expect.objectContaining({ fill: none, hover: "none", ring: "solid" }));
  expect(await marksOf(row)).toEqual(expect.objectContaining({ fill: all.fill, hover: all.hover, ring: "none" }));
  await page.mouse.move(box.x + box.width / 2, box.y - box.height * 3);
  expect(await marksOf(row)).toEqual(expect.objectContaining({ fill: all.fill, hover: "none", ring: "none" }));
  await next.hover();
  expect(await marksOf(next)).toEqual(expect.objectContaining({ fill: none, hover: all.hover, ring: "solid" }));

  // The open request keeps its accent edge while it has the ring.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expectRing(open);
  expect((await marksOf(open)).edge).toBe("rgb(255, 108, 55)");
});
