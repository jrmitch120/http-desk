// Large responses keep the window responsive (#58). Each step of the scenario
// is its own test: it gets there unmeasured, then measures one step and fails
// if the main thread ran any task over 50 ms meanwhile. The mock's bodies (a
// 50 MB minified JSON body with 19-digit ids, whose Pretty is about 88 MB over
// millions of lines, and a 25 MB image) are built before measuring starts.
// Steps that can't pass yet are `test.fixme`, each naming the ticket that
// switches it on. Run with `pnpm test:perf`.
import { expect, test, type Page } from "@playwright/test";
import { mockState, openApp, openRequest, tab } from "../helpers";
import { expectNoLongTasks } from "./longtasks";

/** The 50 MB body's first item, as Raw shows it. */
const RAW_START = '{"items":[{"id":1000000000987654321,';
/** A term only the 50 MB body's last item has (src/dev/mock.ts `PERF_LAST`). */
const NEAR_THE_END = "needle-near-the-end";

/** Opens the app with the perf bodies built, then `request` in a tab. */
async function prepare(page: Page, request = "List pets"): Promise<void> {
  await openApp(page);
  await page.evaluate(() => (window as unknown as { __mock: { preparePerf(): void } }).__mock.preparePerf());
  await openRequest(page, ["api", "pets.http"], request);
}

const editor = (page: Page) => page.locator(".body .cm-content");
const views = (page: Page) => page.getByRole("radiogroup", { name: "Response view" });

/** Sends the active request and waits until the 50 MB body shows in Pretty. */
async function sendAndShowPretty(page: Page): Promise<void> {
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".statusbar")).toContainText("200 OK");
  await expect(editor(page)).toContainText('"items": [');
}

/** Scrolls the body editor from where it is to the end along `axis`, a frame or two per stop. */
async function scrollToEnd(page: Page, axis: "top" | "left", stops = 10): Promise<void> {
  for (let i = 1; i <= stops; i++) {
    await page.evaluate(
      async ([axis, f]) => {
        const s = document.querySelector<HTMLElement>(".body .cm-scroller")!;
        if (axis === "top") s.scrollTop = f * (s.scrollHeight - s.clientHeight);
        else s.scrollLeft = f * (s.scrollWidth - s.clientWidth);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      },
      [axis, i / stops] as const,
    );
  }
}

/** A deliberate busy loop: shows the check fails a step that blocks the main thread. Kept off, as it always fails. */
test.fixme("the long-task check fails a step that blocks the main thread for over 50 ms", async ({ page }) => {
  await openApp(page);
  await expectNoLongTasks(page, async () => {
    // A task of the page's own: script Playwright evaluates directly isn't reported.
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          setTimeout(() => {
            const end = performance.now() + 200;
            while (performance.now() < end);
            done();
          }),
        ),
    );
  });
});

// Fails until #113 (large documents are built in pieces and kept per tab).
test.fixme("1. sending and receiving the 50 MB body", async ({ page }) => {
  await prepare(page);
  await expectNoLongTasks(page, () => sendAndShowPretty(page));
});

// Fails until #113 (large documents are built in pieces and kept per tab).
test.fixme("2. opening Raw (a single 50 MB line), then scrolling and wrapping it", async ({ page }) => {
  await prepare(page);
  await sendAndShowPretty(page);
  await expectNoLongTasks(page, async () => {
    await views(page).getByRole("radio", { name: "Raw" }).click();
    await expect(editor(page)).toContainText(RAW_START);
    await scrollToEnd(page, "left");
    await page.getByRole("button", { name: "Wrap lines" }).click();
    await expect(page.locator(".body .cm-lineWrapping")).toHaveCount(1);
    await scrollToEnd(page, "top");
    await expect(editor(page)).toContainText(NEAR_THE_END);
  });
});

// Fails until #113 (large documents are built in pieces and kept per tab).
test.fixme("3. opening Pretty and scrolling it top to bottom", async ({ page }) => {
  await prepare(page);
  await sendAndShowPretty(page);
  await views(page).getByRole("radio", { name: "Raw" }).click();
  await expect(editor(page)).toContainText(RAW_START);
  await expectNoLongTasks(page, async () => {
    await views(page).getByRole("radio", { name: "Pretty" }).click();
    await expect(editor(page)).toContainText('"items": [');
    await scrollToEnd(page, "top");
    await expect(editor(page)).toContainText(NEAR_THE_END);
  });
});

// Fails until #114 (Find runs in pieces).
test.fixme("4. finding a term that doesn't match", async ({ page }) => {
  await prepare(page);
  await sendAndShowPretty(page);
  await expectNoLongTasks(page, async () => {
    await page.getByRole("button", { name: "Search" }).click();
    const field = page.getByRole("search", { name: "Find in editor" }).getByRole("textbox", { name: "Find" });
    await field.fill("no-such-pet");
    await field.press("Enter");
    await expect(page.getByText("Searching…")).toHaveCount(0);
    await expect(page.locator(".cm-searchMatch")).toHaveCount(0);
  });
});

// Fails until #114 (Find runs in pieces).
test.fixme("5. finding a term that matches only near the end", async ({ page }) => {
  await prepare(page);
  await sendAndShowPretty(page);
  await expectNoLongTasks(page, async () => {
    await page.getByRole("button", { name: "Search" }).click();
    const field = page.getByRole("search", { name: "Find in editor" }).getByRole("textbox", { name: "Find" });
    await field.fill(NEAR_THE_END);
    await field.press("Enter");
    await expect(page.locator(".cm-searchMatch-selected")).toHaveText(NEAR_THE_END);
  });
});

// Fails until #115 (Fold all runs in pieces, with a measured size limit).
test.fixme("6. Fold all is turned off at this size", async ({ page }) => {
  await prepare(page);
  await sendAndShowPretty(page);
  const foldAll = page.getByRole("button", { name: "Fold all", exact: true });
  await expectNoLongTasks(page, async () => {
    // Neither the button nor its key (Ctrl-Alt-[) folds a body this large.
    await editor(page).click();
    await page.keyboard.press("Control+Alt+BracketLeft");
    await foldAll.click({ force: true });
  });
  await expect(foldAll).toBeDisabled();
  await expect(page.locator(".body .cm-foldPlaceholder")).toHaveCount(0);
});

// Fails until #113 (large documents are built in pieces and kept per tab).
test.fixme("7. switching tabs away and back", async ({ page }) => {
  await prepare(page, "Create pet");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await sendAndShowPretty(page);
  await expectNoLongTasks(page, async () => {
    await tab(page, "Create pet").click();
    await expect(page.getByText("to get a response")).toBeVisible();
    await tab(page, "List pets").click();
    await expect(editor(page)).toContainText('"items": [');
  });
});

test("8. copying the body", async ({ page }) => {
  await prepare(page);
  await sendAndShowPretty(page);
  await expectNoLongTasks(page, async () => {
    await page.getByRole("button", { name: "Copy body" }).click();
    await expect(page.getByText("Response body copied")).toBeVisible();
  });
  expect(await mockState(page, "bodyCopies")).toHaveLength(1);
});

// Fails until #112 (Preview uses blob: URLs).
test.fixme("9. sending the 25 MB image and opening Preview", async ({ page }) => {
  await prepare(page, "Get pet image");
  await expectNoLongTasks(page, async () => {
    await page.keyboard.press("Meta+Enter");
    const img = page.getByRole("img", { name: "Response preview" });
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(2048);
  });
});
