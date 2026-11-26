// The explorer's unsaved dots: a file's dot shares a slot with its New request (+)
// button, so it sits at the row's right edge in line with its requests' dots, and
// hovering the file row swaps the dot for the +, centred where the dot was.
import { expect, test, type Locator } from "@playwright/test";
import { openApp, openRequest, treeItem, urlBar } from "./helpers";

const rightEdge = async (el: Locator) => {
  const box = (await el.boundingBox())!;
  return Math.round(box.x + box.width);
};
const centerX = async (el: Locator) => {
  const box = (await el.boundingBox())!;
  return box.x + box.width / 2;
};

test("a file's unsaved dot lines up with its requests' dots, and hovering swaps it for the +", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await urlBar(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type("?x=1");

  const file = treeItem(page, "pets.http");
  const fileDot = file.locator(".dot");
  const reqDot = treeItem(page, "List pets").locator(".dot");
  await expect(fileDot).toBeVisible();
  await expect(reqDot).toBeVisible();
  expect(await rightEdge(fileDot)).toBe(await rightEdge(reqDot));
  const dotCenter = await centerX(fileDot);

  const add = file.getByRole("button", { name: "New request in this file" });
  await expect(add).toBeHidden();
  await file.hover();
  await expect(add).toBeVisible();
  await expect(fileDot).toBeHidden();
  // The + takes the dot's place: centred on it, not beside it, its icon a whole
  // pixel in from the button's edges (half a pixel in, it's drawn a pixel off).
  expect(await centerX(add)).toBe(dotCenter);
  const inset = await add.evaluate((b) => {
    const r = b.getBoundingClientRect(), s = b.querySelector("svg")!.getBoundingClientRect();
    return [s.x - r.x, s.y - r.y];
  });
  expect(inset.every(Number.isInteger), `icon inset ${inset}`).toBe(true);
});
