// The sidebar and the request/response split share one SplitPane: drag, arrow
// keys, Home/End, double-click to reset, and sizes saved in (mocked) settings.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openApp, openRequest } from "./helpers";

const sidebarSplit = (page: Page) => page.getByRole("separator", { name: "Resize sidebar" });
const requestSplit = (page: Page) => page.getByRole("separator", { name: "Resize request and response" });

async function width(el: Locator): Promise<number> {
  return Math.round((await el.boundingBox())!.width);
}

test("the sidebar resizes with the arrow keys, stays within its limits and resets on double-click", async ({ page }) => {
  await openApp(page);
  const split = sidebarSplit(page);
  const aside = page.locator("aside");
  await expect(split).toHaveAttribute("aria-valuenow", "280");
  await expect(split).toHaveAttribute("aria-orientation", "vertical");
  expect(await width(aside)).toBe(280);

  await split.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(split).toHaveAttribute("aria-valuenow", "312");
  expect(await width(aside)).toBe(312);
  await page.keyboard.press("ArrowLeft");
  await expect(split).toHaveAttribute("aria-valuenow", "296");

  await page.keyboard.press("End");
  await expect(split).toHaveAttribute("aria-valuenow", "560");
  await page.keyboard.press("ArrowRight");
  await expect(split).toHaveAttribute("aria-valuenow", "560");
  await page.keyboard.press("Home");
  await expect(split).toHaveAttribute("aria-valuenow", "200");
  expect(await width(aside)).toBe(200);

  await split.dblclick();
  await expect(split).toHaveAttribute("aria-valuenow", "280");
  expect(await width(aside)).toBe(280);
});

test("the sidebar follows a drag of its separator", async ({ page }) => {
  await openApp(page);
  const split = sidebarSplit(page);
  const box = (await split.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, y, { steps: 4 });
  await page.mouse.up();
  await expect(split).toHaveAttribute("aria-valuenow", "340");
  expect(await width(page.locator("aside"))).toBe(340);
});

test("the request/response split resizes with the arrow keys and resets on double-click", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  const split = requestSplit(page);
  await expect(split).toHaveAttribute("aria-valuenow", "50");
  await expect(split).toHaveAttribute("aria-orientation", "vertical");

  await split.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(split).toHaveAttribute("aria-valuenow", "40");
  // The separator names the pane it sizes; the whole split is their parent.
  const pane = page.locator(`[id="${await split.getAttribute("aria-controls")}"]`);
  const whole = await width(split.locator(".."));
  expect(Math.abs((await width(pane)) - whole * 0.4)).toBeLessThanOrEqual(2);

  await page.keyboard.press("Home");
  await expect(split).toHaveAttribute("aria-valuenow", "20");
  await page.keyboard.press("End");
  await expect(split).toHaveAttribute("aria-valuenow", "80");

  await split.dblclick();
  await expect(split).toHaveAttribute("aria-valuenow", "50");
});

test("the stacked layout has its own split ratio, moved with the up and down arrows", async ({ page }) => {
  await openApp(page, "?layout=vertical");
  await openRequest(page, ["api", "pets.http"], "List pets");
  const split = requestSplit(page);
  await expect(split).toHaveAttribute("aria-orientation", "horizontal");

  await split.focus();
  await page.keyboard.press("ArrowDown");
  await expect(split).toHaveAttribute("aria-valuenow", "55");
  await page.keyboard.press("ArrowLeft"); // the other axis does nothing
  await expect(split).toHaveAttribute("aria-valuenow", "55");

  await page.getByRole("button", { name: "Show response on the right" }).click();
  await expect(split).toHaveAttribute("aria-valuenow", "50");
  await expect(split).toHaveAttribute("aria-orientation", "vertical");
});

test("resized splits keep their size across a reload", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await sidebarSplit(page).focus();
  await page.keyboard.press("ArrowRight");
  await requestSplit(page).focus();
  await page.keyboard.press("ArrowRight");
  await expect(requestSplit(page)).toHaveAttribute("aria-valuenow", "55");

  await page.reload();
  await openRequest(page, ["api", "pets.http"], "List pets");
  await expect(sidebarSplit(page)).toHaveAttribute("aria-valuenow", "296");
  await expect(requestSplit(page)).toHaveAttribute("aria-valuenow", "55");
  expect(await width(page.locator("aside"))).toBe(296);
});
