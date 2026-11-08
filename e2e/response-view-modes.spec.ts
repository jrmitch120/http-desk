// Pretty is offered only where the core can format the body (JSON and XML).
// For HTML or plain text it would show the same text as Raw, so it isn't there.
import { expect, test, type Page } from "@playwright/test";
import { openApp, openRequest, setMockResponse } from "./helpers";

async function send(page: Page, response: string): Promise<void> {
  await openApp(page, `?response=${response}`);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+Enter");
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

/** Lines of the Raw editor in view, and how many have no highlighted tokens, one frame after picking Raw. */
async function pickRawAndCountUncoloured(page: Page): Promise<{ inView: number; uncoloured: number }> {
  return page.evaluate(async () => {
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
}

test("a response first shown in Preview builds Raw only when picked, coloured on the first frame", async ({ page }) => {
  await send(page, "longHtml");
  await views(page).getByRole("radio", { name: "Preview" }).click();
  // The next response in this tab opens in Preview, with no Raw editor behind it yet.
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator("iframe[title='HTML preview']")).toBeVisible();
  await expect(page.locator(".body .cm-editor")).toHaveCount(0);

  // Before CodeMirror's background parse could run, every line in view is coloured.
  const lines = await pickRawAndCountUncoloured(page);
  expect(lines.inView).toBeGreaterThan(10);
  expect(lines.uncoloured).toBe(0);
});

test("a tab set to Pretty shows an HTML response in Raw, and the next JSON response in Pretty again", async ({ page }) => {
  await send(page, "bigint");
  await expect(views(page).getByRole("radio", { name: "Pretty" })).toBeChecked();

  await setMockResponse(page, "html");
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".body .cm-content")).toContainText("<h1>Pets</h1>");
  await expect(views(page).getByRole("radio", { name: "Raw" })).toBeChecked();

  await setMockResponse(page, "bigint");
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".body .cm-content")).toContainText('"price": 10.50,');
  await expect(views(page).getByRole("radio", { name: "Pretty" })).toBeChecked();
});

test("a binary body without a preview still names its view: Hex", async ({ page }) => {
  await openApp(page, "?bigBinary=1");
  await openRequest(page, ["api", "pets.http"], "Get pet image");
  await page.keyboard.press("Meta+Enter");
  await expect(views(page).getByRole("radio")).toHaveText(["Hex"]);
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
