// Measures one step of a perf test: whether it blocked the page's main thread.
import { expect, type Page } from "@playwright/test";

/** A main-thread task longer than this blocks input and paint noticeably. */
export const LONG_TASK_MS = 50;

/** A task allowed past {@link LONG_TASK_MS}: the one a named performance measure falls in. */
export type Allowance = { measure: string; maxMs: number };

/**
 * Runs `step` and fails if the page's main thread ran any task over 50 ms
 * meanwhile, reporting the longest. Tasks are the browser's `longtask`
 * entries, which it records only for tasks over 50 ms, so any entry fails,
 * except one that `allow` covers: a task the app marked with that measure,
 * up to its `maxMs`. After the step it waits a few frames and a short quiet
 * spell, so a task the step set off but didn't wait for is still counted.
 */
export async function expectNoLongTasks(page: Page, step: () => Promise<void>, allow?: Allowance): Promise<void> {
  await page.evaluate((measure) => {
    const w = window as unknown as { __longTasks: [number, number][]; __longTaskObserver?: PerformanceObserver };
    w.__longTaskObserver?.disconnect();
    w.__longTasks = [];
    if (measure) performance.clearMeasures(measure);
    w.__longTaskObserver = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__longTasks.push([e.startTime, e.duration]);
    });
    w.__longTaskObserver.observe({ type: "longtask" });
  }, allow?.measure);
  await step();
  const { tasks, marked } = await page.evaluate(async (measure) => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    await frame();
    await frame();
    await new Promise((r) => setTimeout(r, 300));
    await frame();
    const w = window as unknown as { __longTasks: [number, number][]; __longTaskObserver: PerformanceObserver };
    for (const e of w.__longTaskObserver.takeRecords()) w.__longTasks.push([e.startTime, e.duration]);
    w.__longTaskObserver.disconnect();
    const marked = measure ? performance.getEntriesByName(measure, "measure").map((e) => [e.startTime, e.duration]) : [];
    return { tasks: w.__longTasks, marked };
  }, allow?.measure);
  // A long task holds the measure when the measure starts and ends within it.
  const holdsMeasure = ([start, duration]: [number, number]) =>
    marked.some(([mStart, mDuration]) => mStart >= start && mStart + mDuration <= start + duration + 1);
  const allowed = tasks.filter((t) => allow && holdsMeasure(t) && t[1] <= allow.maxMs);
  if (allow) expect(marked.length, `the app never marked "${allow.measure}"`).toBeGreaterThan(0);
  const durations = tasks.filter((t) => !allowed.includes(t)).map(([, duration]) => duration);
  const longest = Math.round(Math.max(0, ...durations));
  expect(durations, `the main thread was blocked for ${longest} ms (${durations.length} task(s) over ${LONG_TASK_MS} ms)`).toEqual([]);
}
