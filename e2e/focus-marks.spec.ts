// HttpDesk draws keyboard focus itself (ADR-0002): a key press turns focus marks
// on and a mouse press turns them off, the same in every webview. macOS's system
// webview doesn't match :focus-visible when a script moves focus after a click,
// so these tests check what's drawn (the computed ring, and where it matters the
// pixels) after click → key. Runs in Chromium and WebKit.
import { expect, test, type Locator } from "@playwright/test";
import { hasRing, openApp, openRequest, tab, treeItem, treeMenu } from "./helpers";

async function expectRing(el: Locator, part?: string) {
  await expect(el).toBeFocused();
  await expect.poll(() => hasRing(el, part)).toBe(true);
}

async function expectNoRing(el: Locator, part?: string) {
  await expect(el).toBeFocused();
  await expect.poll(() => hasRing(el, part)).toBe(false);
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

const ACCENT = [255, 108, 55];
const FOCUS = [91, 157, 255];

/** The colours `row` paints, as seen on screen, halfway down: the two columns of its
 *  left edge and the column just inside them; and the middle of its top line. */
async function paintedEdge(row: Locator) {
  const png = (await row.screenshot({ scale: "css", animations: "disabled" })).toString("base64");
  return row.page().evaluate(async (src) => {
    const img = new Image();
    img.src = `data:image/png;base64,${src}`;
    await img.decode();
    const canvas = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height });
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const at = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)];
    const mid = Math.floor(img.height / 2);
    return { edge: [at(0, mid), at(1, mid)], inside: at(2, mid), top: at(Math.floor(img.width / 2), 0) };
  }, png);
}

/** Whether `rgb` is `want`, give or take a little (colour management, blending). */
function near(rgb: number[], want: number[]) {
  return rgb.every((c, i) => Math.abs(c - want[i]) <= 12);
}

/** Expects `row`'s whole 2px left edge painted in the accent, with the ring just inside it and along its top. */
async function expectEdgeBesideRing(row: Locator) {
  await expectRing(row);
  const painted = await paintedEdge(row);
  const seen = JSON.stringify(painted);
  expect(painted.edge.map((rgb) => near(rgb, ACCENT)), seen).toEqual([true, true]);
  expect(near(painted.inside, FOCUS), seen).toBe(true);
  expect(near(painted.top, FOCUS), seen).toBe(true);
}

/** What marks a row shows: its selection fill, its hover fill (laid over) and its focus ring. */
function marksOf(row: Locator) {
  return row.evaluate((el) => {
    const s = getComputedStyle(el);
    return { fill: s.backgroundColor, hover: s.backgroundImage, ring: s.outlineStyle };
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

  // The open request keeps its whole accent edge, the ring beside it.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expectEdgeBesideRing(open);
});

test("a list's current row keeps its whole accent edge beside the ring when it has focus", async ({ page }) => {
  await openApp(page);
  await treeItem(page, "samples").click();
  await treeMenu(page, "jetbrains.http", "View file as text");
  const row = (label: string) => page.getByRole("navigation", { name: "Outline" }).getByRole("listitem").filter({ hasText: label });
  const current = row("Post with JSON body");
  await current.click();
  await expect(current).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await expectEdgeBesideRing(current);
});
