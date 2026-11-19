import { expect, test, type Page } from "@playwright/test";
import { openApp, openRequest } from "./helpers";

// The request name beside the file name in the breadcrumb takes all the room
// the buttons leave, and a name too long for it ends in "…" instead of being
// cut mid-letter, with the whole name in a tooltip.

const clipped = (el: HTMLInputElement) => el.scrollWidth > el.clientWidth;

async function nameField(page: Page, value: string) {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  const name = page.locator(".crumbs .name-input");
  await name.fill(value);
  await name.blur();
  return name;
}

test("the request name takes all the room up to the breadcrumb's buttons", async ({ page }) => {
  const name = await nameField(page, "Health check");
  const field = (await name.boundingBox())!;
  const firstButton = (await page.locator(".crumbs .btn").first().boundingBox())!;
  // Only the row's gap lies between them: no empty space is left over.
  expect(firstButton.x - (field.x + field.width)).toBeLessThanOrEqual(8);
});

test.describe("in a wide window", () => {
  test.use({ viewport: { width: 1600, height: 800 } });

  test("a name that fits is shown whole, with no tooltip", async ({ page }) => {
    const name = await nameField(page, "Health check");
    expect(await name.evaluate(clipped)).toBe(false);
    await name.hover();
    await page.waitForTimeout(800);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  });
});

test("a name too long for the breadcrumb ends in an ellipsis and shows whole on hover", async ({ page }) => {
  const long = "A very long request name that cannot possibly fit beside the breadcrumb buttons";
  const name = await nameField(page, long);
  expect(await name.evaluate(clipped)).toBe(true);
  await expect(name).toHaveCSS("text-overflow", "ellipsis");

  await name.hover();
  await expect(page.getByRole("tooltip")).toHaveText(long);

  // The buttons keep their place at the end of the row.
  const row = (await page.locator(".crumbs").boundingBox())!;
  const save = (await page.locator(".crumbs").getByRole("button", { name: "Save" }).boundingBox())!;
  expect(row.x + row.width - (save.x + save.width)).toBeLessThan(20);
});
