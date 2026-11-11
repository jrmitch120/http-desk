// Dragging the scroll bar far into a body too tall for CodeMirror to draw at
// its real height (#58, src/lib/codemirror/scrollJumps.ts): the editor lands
// where the bar was dropped and settles at once, rather than redrawing round
// and round (CodeMirror warns its measure loop "restarted more than 5 times"
// or "Viewport failed to stabilize"). Uses a 25 MB body (`preparePerf`),
// whose Pretty runs to about 2.4 million lines.
import { expect, test, type Page } from "@playwright/test";
import { openApp, openRequest } from "./helpers";

const body = (page: Page) => page.locator(".body .cm-content");

/** Drops the scroll bar at `f` of the way down, and waits a couple of frames. */
const scrollTo = (page: Page, f: number) =>
  page.evaluate(async (f) => {
    const s = document.querySelector<HTMLElement>(".body .cm-scroller")!;
    s.scrollTop = f * (s.scrollHeight - s.clientHeight);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, f);

/** The number of the line at the top of the body, from the line-number gutter. */
const topLine = (page: Page) =>
  page.evaluate(() => {
    const top = document.querySelector(".body .cm-scroller")!.getBoundingClientRect().top + 2;
    const numbers = [...document.querySelectorAll(".body .cm-lineNumbers .cm-gutterElement")];
    const at = numbers.find((n) => {
      const r = n.getBoundingClientRect();
      return r.height > 0 && r.top <= top && r.bottom > top;
    });
    return Number(at?.textContent);
  });

test("dropping the scroll bar far down a very tall body lands there in one go", async ({ page }) => {
  const unsettled: string[] = [];
  page.on("console", (m) => {
    if (/failed to stabilize|restarted more than/.test(m.text())) unsettled.push(m.text());
  });
  await openApp(page);
  await page.evaluate(() => (window as unknown as { __mock: { preparePerf(jsonBytes: number): void } }).__mock.preparePerf(25_000_000));
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+Enter");
  await expect(body(page)).toContainText('"items": [');

  const landed: [number, number][] = [];
  for (const f of [0.2, 0.5, 0.8]) {
    await scrollTo(page, f);
    landed.push([f, await topLine(page)]);
  }
  await scrollTo(page, 1);
  await expect(body(page)).toContainText("needle-near-the-end");
  const lines = await page.evaluate(() => {
    // The gutter's numbers in view (not its hidden sizing one, "999999").
    const { top, bottom } = document.querySelector(".body .cm-scroller")!.getBoundingClientRect();
    const numbers = [...document.querySelectorAll<HTMLElement>(".body .cm-lineNumbers .cm-gutterElement")].filter((n) => {
      const r = n.getBoundingClientRect();
      return n.style.visibility !== "hidden" && r.height > 0 && r.bottom > top && r.top < bottom;
    });
    return Math.max(...numbers.map((n) => Number(n.textContent) || 0));
  });
  expect(lines).toBeGreaterThan(2_000_000);
  // Each within a few thousand lines of the same fraction of the body's lines.
  for (const [f, line] of landed) expect(Math.abs(line / lines - f), `the top line at ${f}: ${line} of ${lines}`).toBeLessThan(0.01);
  expect(unsettled).toEqual([]);
});
