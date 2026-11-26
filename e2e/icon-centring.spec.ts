// Every icon button's icon sits a whole pixel in from each edge (docs/controls.md,
// `.icon-btn`): half a pixel in (an odd icon in an even button), it's drawn a pixel
// off-centre and the hover background is wider on one side. Swept across the main
// screens, so a new button with an odd icon is caught wherever it lands.
import { expect, test, type Page } from "@playwright/test";
import { dialog, openApp, openRequest, treeMenu } from "./helpers";

type Off = { label: string; insets: number[] };

/** The visible icon buttons whose icon isn't centred on whole pixels. */
async function offCentre(page: Page): Promise<Off[]> {
  // Measured at rest: a modal opening is scaled, and so off whole pixels, until it settles.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
  return page.locator(".icon-btn").evaluateAll((buttons) =>
    buttons.flatMap((b) => {
      const svg = b.querySelector("svg");
      if (!svg || !(b as HTMLElement).offsetParent) return [];
      const r = b.getBoundingClientRect();
      const s = svg.getBoundingClientRect();
      const [left, top, bottom] = [s.x - r.x, s.y - r.y, r.bottom - s.bottom];
      // Only the vertical for a button with a count beside its icon (`.counted`).
      const centred = Number.isInteger(top) && top === bottom && (b.classList.contains("counted") || (Number.isInteger(left) && left === r.right - s.right));
      return centred ? [] : [{ label: b.getAttribute("aria-label") ?? "", insets: [left, r.right - s.right, top, bottom] }];
    }),
  );
}

test("every icon button on the main screens has its icon centred on whole pixels", async ({ page }) => {
  const found: Record<string, Off[]> = {};
  const sweep = async (where: string) => {
    const off = await offCentre(page);
    if (off.length) found[where] = off;
  };

  await openApp(page, "?response=cookies");
  await sweep("start");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copy body" })).toBeVisible();
  await page.getByRole("button", { name: "Copy body" }).click();
  await expect(page.getByRole("button", { name: "Dismiss" }).first()).toBeVisible();
  await sweep("request, response and toast");
  await page.getByRole("button", { name: "Search" }).first().click();
  await sweep("find bar");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+j");
  await expect(page.getByRole("region", { name: "Session" })).toBeVisible();
  await sweep("Session panel");

  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await sweep("Settings");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Manage environments" }).first().click();
  await sweep("Environments list");
  await dialog(page, "Environments").getByRole("radiogroup", { name: "View" }).getByRole("radio", { name: "Matrix" }).click();
  await sweep("Environments matrix");
  await page.keyboard.press("Escape");
  await page.locator("aside").getByRole("button", { name: "Import OpenAPI" }).click();
  await sweep("Import OpenAPI");
  await page.keyboard.press("Escape");

  await treeMenu(page, "pets.http", "View file as text");
  await sweep("file view");
  await page.locator("aside").getByRole("radio", { name: "History" }).click();
  await sweep("History");
  await page.keyboard.press("Meta+b");
  await sweep("sidebar rail");

  expect(found).toEqual({});
});
