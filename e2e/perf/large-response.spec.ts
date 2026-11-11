// Large responses keep the window responsive (#58). Each step of the scenario
// is its own test: it gets there unmeasured, then measures one step and fails
// if the main thread ran any task over 50 ms meanwhile. The mock's bodies (a
// 50 MB minified JSON body with 19-digit ids, whose Pretty is about 88 MB over
// millions of lines, and a 25 MB image) are built before measuring starts.
// Run with `pnpm test:perf`.
//
// CI's runners are slower than a developer's machine, so a step can pass
// locally and fail there. PERF_CPU_THROTTLE=<rate> slows the page's CPU by
// that factor (Chromium's CPU throttling, as in DevTools) to see what CI sees:
// a rate of 2 makes an M1 Pro about as fast as CI's ubuntu-22.04 runner
// (calibrated on #58 with the Fold all step, 66–71 ms there and 69–72 ms here).
import { expect, test, type Page } from "@playwright/test";
import { mockState, openApp, openRequest, tab } from "../helpers";
import { expectNoLongTasks } from "./longtasks";
import { FOLD_ALL_LIMIT } from "../../src/lib/codemirror/foldAll";

test.beforeEach(async ({ page }, info) => {
  const rate = Number(info.project.metadata.cpuThrottle ?? 1); // PERF_CPU_THROTTLE (playwright.config.ts)
  if (rate > 1) await (await page.context().newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate });
});

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

/**
 * Scrolls the body editor from the top to the bottom as a reader dragging the
 * scroll bar and turning the mouse wheel would: it jumps to each of `stops`
 * evenly spaced places and turns the wheel there a few times, a frame or two
 * per move, then jumps to the end.
 */
async function scrollThrough(page: Page, stops: number): Promise<void> {
  const box = (await page.locator(".body .cm-scroller").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const jump = (f: number) =>
    page.evaluate((f) => {
      const s = document.querySelector<HTMLElement>(".body .cm-scroller")!;
      s.scrollTop = f * (s.scrollHeight - s.clientHeight);
    }, f);
  for (let i = 0; i < stops; i++) {
    await jump(i / stops);
    await frames();
    for (let turn = 0; turn < 3; turn++) {
      await page.mouse.wheel(0, 300);
      await frames();
    }
  }
  await jump(1);
  await frames();
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

test("1. sending and receiving the 50 MB body", async ({ page }) => {
  await prepare(page);
  await expectNoLongTasks(page, () => sendAndShowPretty(page));
});

test("2. opening Raw (a single 50 MB line), then scrolling and wrapping it", async ({ page }) => {
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

test("3. opening Pretty and scrolling it top to bottom", async ({ page }) => {
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

// Step 3 as a reader would scroll all 4.8 million lines: 200 stops, each about
// 24,000 lines on from the last, with three turns of the mouse wheel at each.
// Off, as it still fails at CI's speed. Each stop used to take CodeMirror up to
// five passes of measuring and redrawing (36 tasks over 50 ms on an M1 Pro);
// src/lib/codemirror/scrollJumps.ts settles each in one, and the step passes
// unthrottled. At 2x CPU throttling (as on CI) one task of 52–63 ms remains:
// the slice of CodeMirror's background parse that finishes a stretch of
// several MB it has worked through, toward a viewport far down, and builds
// that stretch's tree in one go (Lezer's Tree.build). Fold all avoids the same
// cost by parsing in stages (foldAll.ts); the background parse doesn't yet.
test.fixme("3b. scrolling Pretty top to bottom, a stop at a time, with the mouse wheel", async ({ page }) => {
  await prepare(page);
  await sendAndShowPretty(page);
  await expectNoLongTasks(page, async () => {
    await scrollThrough(page, 200);
    await expect(editor(page)).toContainText(NEAR_THE_END);
  });
});

test("4. finding a term that doesn't match", async ({ page }) => {
  await prepare(page);
  await sendAndShowPretty(page);
  await expectNoLongTasks(page, async () => {
    await page.getByRole("button", { name: "Search" }).click();
    const field = page.getByRole("search", { name: "Find in editor" }).getByRole("textbox", { name: "Find" });
    await field.fill("no-such-pet");
    await field.press("Enter");
    // Through the whole body and round again, a piece at a time.
    await expect(page.getByText("Searching…")).toBeVisible();
    await expect(page.getByText("Searching…")).toHaveCount(0);
    await expect(page.locator(".cm-searchMatch")).toHaveCount(0);
  });
});

// The Find runs in pieces (#114). Selecting the match scrolls to the end, and
// CodeMirror's background parse then works toward it in slices, which stay
// under 50 ms because src/lib/codemirror/parseSlices.ts hides isInputPending
// and caps every idle deadline.
test("5. finding a term that matches only near the end", async ({ page }) => {
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

// Step 5 as on WebKit, our webview on macOS and Linux, which has no
// requestIdleCallback: without one, CodeMirror's parse worker falls back to
// setTimeout and 100 ms slices, so parseSlices.ts supplies one. The fallback's
// first slice comes 500 ms after the match is selected, and the parse doesn't
// reach a match this far down (it stops after 3 s of work), so this measures a
// fixed 2 s after selecting: long enough for several slices either way.
test("5b. finding a term that matches only near the end, without requestIdleCallback", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as { requestIdleCallback?: unknown; cancelIdleCallback?: unknown };
    delete w.requestIdleCallback;
    delete w.cancelIdleCallback;
  });
  await prepare(page);
  expect(await page.evaluate(() => typeof window.requestIdleCallback)).toBe("function"); // parseSlices.ts's own
  await sendAndShowPretty(page);
  await expectNoLongTasks(page, async () => {
    await page.getByRole("button", { name: "Search" }).click();
    const field = page.getByRole("search", { name: "Find in editor" }).getByRole("textbox", { name: "Find" });
    await field.fill(NEAR_THE_END);
    await field.press("Enter");
    await expect(page.locator(".cm-searchMatch-selected")).toHaveText(NEAR_THE_END);
    await page.waitForTimeout(2_000);
  });
});

// Find previous from the top wraps round and works back from the end (#114).
test("5c. finding the previous match, near the end", async ({ page }) => {
  await prepare(page);
  await sendAndShowPretty(page);
  await expectNoLongTasks(page, async () => {
    await page.getByRole("button", { name: "Search" }).click();
    const field = page.getByRole("search", { name: "Find in editor" }).getByRole("textbox", { name: "Find" });
    await field.fill(NEAR_THE_END);
    await field.press("Shift+Enter");
    await expect(page.locator(".cm-searchMatch-selected")).toHaveText(NEAR_THE_END);
  });
});

// Selecting the next occurrence (Mod-d) and every occurrence (Mod-Shift-l) of
// the selection (the first pet's name, which occurs once): each goes through
// the whole body, and round, from the top.
test("5d. selecting the next occurrence and every occurrence", async ({ page }) => {
  await prepare(page);
  await sendAndShowPretty(page);
  await page.getByRole("button", { name: "Search" }).click();
  const bar = page.getByRole("search", { name: "Find in editor" });
  const field = bar.getByRole("textbox", { name: "Find" });
  await field.fill('"pet-0"');
  await field.press("Enter");
  await expect(page.locator(".cm-searchMatch-selected")).toHaveText('"pet-0"');
  await editor(page).focus();
  await expectNoLongTasks(page, async () => {
    for (const key of ["ControlOrMeta+d", "ControlOrMeta+Shift+l"]) {
      await page.keyboard.press(key);
      await expect(bar.getByText("Searching…")).toBeVisible();
      await expect(bar.getByText("Searching…")).toHaveCount(0);
    }
  });
});

test("6. Fold all is turned off at this size", async ({ page }) => {
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

// At the limit (just under it), Fold all parses in slices and stages, then
// hands the tree to the view and folds, each step under 50 ms (#115). The
// limit is set by this step (src/lib/codemirror/foldAll.ts FOLD_ALL_LIMIT).
test("6b. Fold all on a body at its size limit", async ({ page }) => {
  await openApp(page);
  // Pretty text is about 1.76 times the minified body: this keeps it just under the limit.
  const jsonBytes = Math.floor(FOLD_ALL_LIMIT / 1.77);
  await page.evaluate((n) => (window as unknown as { __mock: { preparePerf(jsonBytes: number): void } }).__mock.preparePerf(n), jsonBytes);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await sendAndShowPretty(page);
  const foldAll = page.getByRole("button", { name: "Fold all", exact: true });
  await expect(foldAll).toBeEnabled();
  await expectNoLongTasks(page, async () => {
    await foldAll.click();
    await expect(page.locator(".body .cm-foldPlaceholder")).toHaveCount(1);
    await expect(page.getByText("Folding…")).toHaveCount(0);
  });
});

test("7. switching tabs away and back", async ({ page }) => {
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

// Copy path reads the body up to the caret, which here is nearly all 88 MB of
// Pretty text, a slice at a time and without joining it into a string.
test("8b. Copy path near the end of the 50 MB body", async ({ page }) => {
  await prepare(page);
  await sendAndShowPretty(page);
  await page.getByRole("button", { name: "Search" }).click();
  const field = page.getByRole("search", { name: "Find in editor" }).getByRole("textbox", { name: "Find" });
  await field.fill(NEAR_THE_END);
  await field.press("Enter");
  const match = page.locator(".cm-searchMatch-selected");
  await expect(match).toHaveText(NEAR_THE_END);
  await expectNoLongTasks(page, async () => {
    await match.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Copy path" }).click();
    await expect(page.getByText(/^Copied \$\.items\[\d+\]\.name$/)).toBeVisible();
  });
  expect(await mockState(page, "clipboardWrites")).toEqual([expect.stringMatching(/^\$\.items\[\d{6}\]\.name$/)]);
});

test("9. sending the 25 MB image and opening Preview", async ({ page }) => {
  await prepare(page, "Get pet image");
  await expectNoLongTasks(page, async () => {
    await page.keyboard.press("Meta+Enter");
    const img = page.getByRole("img", { name: "Response preview" });
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(2048);
  });
});
