// Pretty is offered only where the core can format the body (JSON and XML).
// For HTML or plain text it would show the same text as Raw, so it isn't there.
import { expect, test, type Page } from "@playwright/test";
import { openApp, openRequest } from "./helpers";

async function send(page: Page, response: string): Promise<void> {
  await openApp(page, `?response=${response}`);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.locator(".statusbar .metric").first()).toBeVisible();
}

const views = (page: Page) => page.getByRole("radiogroup", { name: "Response view" });

test("a JSON response offers Pretty and Raw, and opens in Pretty", async ({ page }) => {
  await send(page, "bigint");
  await expect(views(page).getByRole("radio")).toHaveText(["Pretty", "Raw"]);
  await expect(views(page).getByRole("radio", { name: "Pretty" })).toBeChecked();
});

test("an HTML response offers Raw and Preview, not Pretty, and opens in Raw", async ({ page }) => {
  await send(page, "html");
  await expect(views(page).getByRole("radio")).toHaveText(["Raw", "Preview"]);
  await expect(views(page).getByRole("radio", { name: "Raw" })).toBeChecked();
  await expect(page.locator(".body .cm-content")).toContainText("<h1>Pets</h1>");
});

test("going back from Preview to Raw colours every line in view on the first frame", async ({ page }) => {
  await send(page, "longHtml");
  await views(page).getByRole("radio", { name: "Preview" }).click();
  await expect(page.locator("iframe[title='HTML preview']")).toBeVisible();

  // Count the lines in view that have no highlighted tokens, one frame after
  // Raw is picked (before CodeMirror's background parse could have run).
  const uncoloured = await page.evaluate(async () => {
    const raw = [...document.querySelectorAll<HTMLElement>('[role="radiogroup"][aria-label="Response view"] [role="radio"]')].find(
      (r) => r.textContent?.trim() === "Raw",
    );
    raw!.click();
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const scroller = document.querySelector(".body .cm-scroller")!.getBoundingClientRect();
    const lines = [...document.querySelectorAll<HTMLElement>(".body .cm-line")].filter((l) => {
      const box = l.getBoundingClientRect();
      return box.bottom > scroller.top && box.top < scroller.bottom && l.textContent!.includes("<div");
    });
    return { inView: lines.length, uncoloured: lines.filter((l) => !l.querySelector("span[class]")).length };
  });
  expect(uncoloured.inView).toBeGreaterThan(10);
  expect(uncoloured.uncoloured).toBe(0);
});

test("Raw and Preview stay mounted, so switching back keeps Raw's scroll position and Preview's page", async ({ page }) => {
  await send(page, "longHtml");
  const scroller = page.locator(".body .cm-scroller");
  await scroller.evaluate((el) => (el.scrollTop = 1500));

  await views(page).getByRole("radio", { name: "Preview" }).click();
  const frame = page.locator("iframe[title='HTML preview']");
  await expect(frame).toBeVisible();
  await expect(scroller).toBeHidden();
  const frameHandle = await frame.elementHandle();

  await views(page).getByRole("radio", { name: "Raw" }).click();
  await expect(scroller).toBeVisible();
  await expect(frame).toBeHidden();
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(1500);

  await views(page).getByRole("radio", { name: "Preview" }).click();
  // The same frame, not a reloaded one.
  expect(await frame.evaluate((el, old) => el === old, frameHandle)).toBe(true);
});

test("a plain-text response has no view switch, only its text", async ({ page }) => {
  await send(page, "text");
  await expect(views(page)).toHaveCount(0);
  await expect(page.locator(".body .cm-content")).toContainText("pets: 2");
});
