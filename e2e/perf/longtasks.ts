// Measures one step of a perf test: whether it blocked the page's main thread.
import { expect, type Page } from "@playwright/test";

/** A main-thread task longer than this blocks input and paint noticeably. */
export const LONG_TASK_MS = 50;

/**
 * Runs `step` and fails if the page's main thread ran any task over 50 ms
 * meanwhile, reporting the longest. Tasks are the browser's `longtask`
 * entries, which it records only for tasks over 50 ms, so any entry fails.
 * After the step it waits a few frames and a short quiet spell, so a task the
 * step set off but didn't wait for is still counted.
 */
export async function expectNoLongTasks(page: Page, step: () => Promise<void>): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __longTasks: number[]; __longTaskObserver?: PerformanceObserver };
    w.__longTaskObserver?.disconnect();
    w.__longTasks = [];
    w.__longTaskObserver = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__longTasks.push(e.duration);
    });
    w.__longTaskObserver.observe({ type: "longtask" });
  });
  await step();
  const durations = await page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    await frame();
    await frame();
    await new Promise((r) => setTimeout(r, 300));
    await frame();
    const w = window as unknown as { __longTasks: number[]; __longTaskObserver: PerformanceObserver };
    for (const e of w.__longTaskObserver.takeRecords()) w.__longTasks.push(e.duration);
    w.__longTaskObserver.disconnect();
    return w.__longTasks;
  });
  const longest = Math.round(Math.max(0, ...durations));
  expect(durations, `the main thread was blocked for ${longest} ms (${durations.length} task(s) over ${LONG_TASK_MS} ms)`).toEqual([]);
}
