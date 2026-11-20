// Typing in the file view of a large `.http` file stays fast (#168): the main
// thread's work for a keystroke, handling the key and painting the frame that
// shows it, fits in a frame (16 ms), so the keystroke shows on the next one; and
// reading the typed text into the file, once typing pauses, blocks nothing
// either. Run with `pnpm test:perf`.
//
// Every keystroke must fit in a frame. What a request appearing or going costs (`@` at
// the top reads as a request line until ` = ` follows) waits until typing pauses: the
// outline and the explorer's selection follow the text once the editor is still, and the
// text is read into the file after a pause too. Measured at PERF_CPU_THROTTLE=2 (about
// CI's speed) on an M1 Pro, the slowest keystroke of each case is 10–12 ms.
//
// Timings come from a Chrome trace of the page's main thread (each task's
// duration), not from timestamps taken in the page: those would also count the
// wait for the next frame, which is up to a frame whatever the work. The trace
// adds a little to each task; PERF_CPU_THROTTLE slows the CPU as in
// large-response.spec.ts.
import { expect, test, type Page } from "@playwright/test";
import { activeTab, openApp, tab, treeItem, treeMenu } from "../helpers";
import { expectNoLongTasks } from "./longtasks";

/** How many requests the large file has. */
const REQUESTS = 1000;
/** A frame at 60 Hz: the most a keystroke's work may take. */
const FRAME_MS = 16;

// A Playwright trace snapshots the page's DOM, in the page, for each action: each keystroke here.
test.use({ trace: "off" });

test.beforeEach(async ({ page }, info) => {
  const rate = Number(info.project.metadata.cpuThrottle ?? 1); // PERF_CPU_THROTTLE (playwright.config.ts)
  if (rate > 1) await (await page.context().newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate });
});

const fileView = (page: Page) => page.locator(".file-view .file-code");
const line = (page: Page, text: string) => fileView(page).locator(".cm-line", { hasText: text });

/** Opens api/pets.http, made a file of REQUESTS requests, in its file view. */
async function openLargeFile(page: Page): Promise<void> {
  await openApp(page);
  await page.evaluate((n) => (window as unknown as { __mock: { prepareLargeFile(n: number): void } }).__mock.prepareLargeFile(n), REQUESTS);
  await treeItem(page, "api").click();
  await treeMenu(page, "pets.http", "View file as text");
  await expect(activeTab(page)).toContainText("pets.http");
  await expect(line(page, "@host = http://localhost:8765")).toBeVisible();
}

/** Puts the caret at the end of the first line holding `text`, found with the editor's Find. */
async function caretAfter(page: Page, text: string): Promise<void> {
  await fileView(page).locator(".cm-content").click();
  // CodeMirror's own key, so the test machine's (e2e/helpers.ts openApp).
  await page.keyboard.press("ControlOrMeta+f");
  const field = page.getByRole("search", { name: "Find in editor" }).getByRole("textbox", { name: "Find" });
  await field.fill(text);
  await field.press("Enter");
  await expect(fileView(page).locator(".cm-searchMatch-selected")).toHaveText(text);
  await field.press("Escape");
  await page.keyboard.press("End");
}

/** A task the page's main thread ran (a Chrome trace event), and what ran in it. */
interface TraceEvent {
  name: string;
  ts: number;
  dur: number;
  pid: number;
  tid: number;
  ph: string;
  args?: { name?: string; data?: { type?: string } };
}

/** The main thread's tasks while `step` runs, each with the events inside it. */
async function traceTasks(page: Page, step: () => Promise<void>): Promise<{ task: TraceEvent; inside: TraceEvent[] }[]> {
  const cdp = await page.context().newCDPSession(page);
  const events: TraceEvent[] = [];
  cdp.on("Tracing.dataCollected", (e) => events.push(...(e.value as unknown as TraceEvent[])));
  const complete = new Promise((done) => cdp.once("Tracing.tracingComplete", done));
  // `toplevel` has the tasks; `devtools.timeline` what ran in them (events, frames).
  await cdp.send("Tracing.start", { categories: "toplevel,devtools.timeline", transferMode: "ReportEvents" });
  await step();
  await cdp.send("Tracing.end");
  await complete;
  await cdp.detach();
  const main = events.find((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain")!;
  const onMain = events.filter((e) => e.pid === main.pid && e.tid === main.tid && e.ph === "X").sort((a, b) => a.ts - b.ts);
  return onMain
    .filter((e) => e.name === "ThreadControllerImpl::RunTask")
    .map((task) => ({ task, inside: onMain.filter((e) => e !== task && e.ts >= task.ts && e.ts + e.dur <= task.ts + task.dur) }));
}

/** Each keystroke's work, in ms: its key's task, and the task that painted the frame after it. */
function keystrokes(tasks: Awaited<ReturnType<typeof traceTasks>>): number[] {
  const out: number[] = [];
  tasks.forEach(({ task, inside }, i) => {
    if (!inside.some((e) => e.name === "EventDispatch" && e.args?.data?.type === "keydown")) return;
    const frame = tasks.slice(i + 1).find((t) => t.inside.some((e) => e.name === "Paint"));
    out.push((task.dur + (frame?.task.dur ?? 0)) / 1000);
  });
  return out;
}

/** Logs the median, 90th percentile and most of `times` (ms), for the run's output. */
function report(label: string, times: number[]): void {
  const sorted = [...times].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(1);
  console.log(`${label}: ${times.length}, median ${at(0.5)} ms, p90 ${at(0.9)} ms, most ${at(1)} ms`);
}

/**
 * Types `bursts` at the caret, a pause after each long enough for the text to be
 * read into the file, and checks every keystroke fits in a frame.
 */
async function typeAndMeasure(page: Page, label: string, bursts: string[]): Promise<void> {
  // A character typed and taken back first: an editor's first edit runs its code for
  // the first time, and costs as much in a file of 8 requests (11–15 ms, measured on
  // #168) as in one of a thousand. Then a pause, so what that set off is done.
  await page.keyboard.type(" ");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(500);
  let tasks: Awaited<ReturnType<typeof traceTasks>> = [];
  await expectNoLongTasks(page, async () => {
    tasks = await traceTasks(page, async () => {
      for (const burst of bursts) {
        await page.keyboard.type(burst, { delay: 40 });
        await page.waitForTimeout(400);
      }
    });
  });
  const work = keystrokes(tasks);
  expect(work).toHaveLength(bursts.join("").length);
  report(`${label}, each keystroke's work`, work);
  console.log(`  ${work.map((t) => t.toFixed(1)).join(" ")}`);
  report(`${label}, every task`, tasks.map((t) => t.task.dur / 1000).filter((d) => d > 1));
  const all = `each keystroke's work (ms): ${work.map((t) => t.toFixed(1)).join(", ")}`;
  expect(Math.max(...work), all).toBeLessThan(FRAME_MS);
}

test("typing in a request in the middle of a 1,000-request file", async ({ page }) => {
  await openLargeFile(page);
  await caretAfter(page, "page=500&limit=20");
  await typeAndMeasure(page, "A request in the middle", ["&sort", "=name", "&order=desc"]);
  await expect(line(page, "page=500&limit=20&sort=name&order=desc")).toBeVisible();
  // Read into the file: it reads as edited.
  await expect(tab(page, "pets.http").locator(".dot")).toBeVisible();
});

test("typing a new request between two in the middle of a 1,000-request file", async ({ page }) => {
  await openLargeFile(page);
  // The end of the middle request's last line (`#~ X-Debug: true`).
  await caretAfter(page, "page=500&limit=20");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await typeAndMeasure(page, "A new request", ["\n\n### Added", "\nGET {{host}}/added", "\nAccept: text/plain"]);
  await expect(line(page, "### Added")).toBeVisible();
  await expect(line(page, "GET {{host}}/added")).toBeVisible();
});

test("typing in the File variables at the top of a 1,000-request file", async ({ page }) => {
  await openLargeFile(page);
  await caretAfter(page, "@token = secret-token");
  await typeAndMeasure(page, "The File variables", ["-2", "\n@page", " = 1"]);
  await expect(line(page, "@page = 1")).toBeVisible();
});
