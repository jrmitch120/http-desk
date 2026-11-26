// #217, #226: the bottom bar along the bottom of the window, below the panel area, with
// Problems at its right end, in a fixed-width button so a changing count moves nothing.
// Problems shows its icon and count, "0" included: muted at
// zero, the count in the warning colour with problems. It opens and closes the
// Problems panel, wherever focus is, with aria-pressed while the panel is open. The
// count follows the problems once they've stopped changing for about 300 ms, so it
// doesn't flicker as you type; the panel's list stays live. A changing count moves
// nothing in the topbar or the bottom bar but its own digits.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openApp, openRequest, treeItem, treeMenu, urlBar } from "./helpers";

const bottomBar = (page: Page) => page.getByRole("contentinfo", { name: "Bottom bar" });
const problemsButton = (page: Page) => bottomBar(page).getByRole("button", { name: /^Show Problems/ });
const problemsPanel = (page: Page) => page.getByRole("region", { name: "Problems" });
const group = (page: Page, file: string) => problemsPanel(page).getByRole("group", { name: file });
const fileView = (page: Page) => page.locator(".file-view .file-code");
const runnerButton = (page: Page) => bottomBar(page).getByRole("button", { name: /^Show Runner/ });
const runnerPanel = (page: Page) => page.getByRole("region", { name: "Runner" });
/** The Runner item's progress bar (decorative: its text says the same), and its fills. */
const progress = (page: Page) => runnerButton(page).locator(".run-progress");
const fill = (page: Page, kind: "passed" | "failed" | "sending") => progress(page).locator(`.${kind}`);

/** A theme token (`--warning`) as a computed colour, comparable with an element's computed colour. */
function token(page: Page, name: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, name);
}

const colour = (el: Locator) => el.evaluate((e) => getComputedStyle(e).color);
const box = async (l: Locator) => (await l.boundingBox())!;

/** The button's icon colour and background, as computed. */
const look = (button: Locator) =>
  button.evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.color, background: s.backgroundColor };
  });

/** Fixes problems/broken.http's request line in its file view, from the Problems panel: 2 problems become 1. */
async function fixBrokenLine(page: Page) {
  await group(page, "problems/broken.http").getByRole("listitem").filter({ hasText: "Line 2" }).click();
  await expect(fileView(page).locator(".cm-activeLine")).toContainText("search for pets");
  await page.keyboard.press("Shift+End");
  await page.keyboard.type("GET {{baseUrl}}/search");
}

test("spans the bottom of the window, below the panel area, with Problems at its right end", async ({ page }) => {
  await openApp(page);
  await problemsButton(page).click();
  await expect(problemsPanel(page)).toBeVisible();

  const viewport = page.viewportSize()!;
  const bar = await box(bottomBar(page));
  expect(bar.x).toBe(0);
  expect(bar.width).toBe(viewport.width);
  expect(bar.y + bar.height).toBe(viewport.height);
  expect((await box(problemsPanel(page))).y + (await box(problemsPanel(page))).height).toBeLessThanOrEqual(bar.y);

  const problems = await box(problemsButton(page));
  expect(bar.x + bar.width - (problems.x + problems.width)).toBeLessThan(16);
  // Nothing else is in it yet.
  await expect(bottomBar(page).getByRole("button")).toHaveCount(1);
});

test("with no problems it shows a muted 0", async ({ page }) => {
  await openApp(page);
  await expect(problemsButton(page)).toHaveText("0");
  await expect(problemsButton(page)).toHaveAccessibleName("Show Problems");
  await expect.poll(() => colour(problemsButton(page).getByText("0", { exact: true }))).toBe(await token(page, "--muted"));
});

test("with problems it shows the count in the warning colour, open or closed", async ({ page }) => {
  await openApp(page, "?problems=1");
  const count = problemsButton(page).getByText("2", { exact: true });
  await expect(count).toBeVisible();
  const warning = await token(page, "--warning");
  await expect.poll(() => colour(count)).toBe(warning);

  await problemsButton(page).click();
  await page.mouse.move(0, 300);
  await expect(problemsPanel(page)).toBeVisible();
  await expect.poll(() => colour(count)).toBe(warning);
});

test("keeps its tooltip", async ({ page }) => {
  await openApp(page);
  await problemsButton(page).hover();
  await expect(page.getByRole("tooltip")).toContainText("Problems: none in the workspace's .http files");
});

test("clicking it opens and closes the panel, and aria-pressed follows", async ({ page }) => {
  await openApp(page);
  await expect(problemsButton(page)).toHaveAttribute("aria-pressed", "false");

  await problemsButton(page).click();
  await expect(problemsPanel(page)).toBeVisible();
  await expect(problemsButton(page)).toHaveAttribute("aria-pressed", "true");

  await problemsButton(page).click();
  await expect(problemsPanel(page)).toHaveCount(0);
  await expect(problemsButton(page)).toHaveAttribute("aria-pressed", "false");
});

test("clicking it closes the open panel even with focus elsewhere", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await problemsButton(page).click();
  await expect(problemsPanel(page)).toBeVisible();
  await urlBar(page).click();

  await problemsButton(page).click();
  await expect(problemsPanel(page)).toHaveCount(0);
  await expect(problemsButton(page)).toHaveAttribute("aria-pressed", "false");
});

for (const theme of ["dark", "light"] as const) {
  test(`${theme} theme: pressed while the panel is open, it looks quiet, not accent`, async ({ page }) => {
    await openApp(page, `?theme=${theme}`);
    await expect.poll(() => look(problemsButton(page))).toEqual({ color: await token(page, "--muted"), background: "rgba(0, 0, 0, 0)" });

    await problemsButton(page).click();
    await page.mouse.move(0, 300);
    const [text, hover, accent] = [await token(page, "--text"), await token(page, "--hover"), await token(page, "--accent")];
    await expect.poll(() => look(problemsButton(page))).toEqual({ color: text, background: hover });
    expect(text).not.toBe(accent);
  });
}

test("a changing count moves nothing in the topbar or the bottom bar but its own digits", async ({ page }) => {
  await openApp(page, "?problems=1");
  await expect(problemsButton(page)).toHaveText("2");
  const topbarControls = page.getByRole("banner").locator("button, [role=combobox]");
  const places = () => topbarControls.evaluateAll((els) => els.map((e) => JSON.stringify(e.getBoundingClientRect())));
  const before = { topbar: await places(), bar: await box(bottomBar(page)), problems: await box(problemsButton(page)) };

  await problemsButton(page).click();
  await fixBrokenLine(page);
  await expect(problemsButton(page)).toHaveText("1");
  // The panel is open now, so only compare positions that don't depend on it.
  const bar = await box(bottomBar(page));
  expect(await places()).toEqual(before.topbar);
  expect(bar).toEqual(before.bar);
  const after = await box(problemsButton(page));
  expect(after.x).toBe(before.problems.x);
  expect(after.width).toBe(before.problems.width);
});

test("the Problems button is as wide with no problems as with some", async ({ page }) => {
  await openApp(page);
  await expect(problemsButton(page)).toHaveText("0");
  const none = await box(problemsButton(page));
  await openApp(page, "?problems=1");
  await expect(problemsButton(page)).toHaveText("2");
  const some = await box(problemsButton(page));
  expect(some.width).toBe(none.width);
  expect(some.x).toBe(none.x);
});

test("the count waits until the problems stop changing, while the panel's list follows at once", async ({ page }) => {
  await openApp(page, "?problems=1");
  await expect(problemsButton(page)).toHaveText("2");
  await problemsButton(page).click();
  const tab = page.getByRole("radio", { name: /^Problems/ });
  await expect(tab).toContainText("2");

  // When the list and the count each last changed, in page time.
  await page.evaluate(() => {
    const w = window as unknown as { changed: { list: number[]; count: { at: number; text: string }[] } };
    w.changed = { list: [], count: [] };
    const button = document.querySelector("footer button[aria-pressed]")!;
    new MutationObserver(() => w.changed.count.push({ at: performance.now(), text: button.textContent!.trim() })).observe(button, { subtree: true, characterData: true, childList: true });
    const panel = document.querySelector("section[aria-label=Problems]")!;
    new MutationObserver(() => w.changed.list.push(performance.now())).observe(panel, { subtree: true, childList: true });
  });
  await fixBrokenLine(page);
  await expect(group(page, "problems/broken.http")).toHaveCount(0);
  await expect(problemsButton(page)).toHaveText("1");
  await expect(tab).toContainText("1");

  const changed = await page.evaluate(() => (window as unknown as { changed: { list: number[]; count: { at: number; text: string }[] } }).changed);
  // The count changed once, to 1, about 300 ms after the list stopped changing.
  expect(changed.count.map((c) => c.text)).toEqual(["1"]);
  expect(changed.list.length).toBeGreaterThan(0);
  const lastListChange = Math.max(...changed.list);
  expect(changed.count[0].at - lastListChange).toBeGreaterThanOrEqual(250);
});

// #227: the Runner item, left of Problems: the current Run's progress and result.
// `?download=slow` makes each send take 2 s; with `?trusted=1&status=404`,
// samples/jetbrains.http's second request ("Post with JSON body") fails its test.
test.describe("Runner item", () => {
  /** Expands the folders of `path`, then picks Run file on its file. */
  async function runFile(page: Page, ...path: string[]) {
    for (const folder of path.slice(0, -1)) {
      const row = treeItem(page, folder);
      if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
    }
    await treeMenu(page, path.at(-1)!, "Run file");
  }
  const stop = (page: Page) => runnerPanel(page).getByRole("button", { name: "Stop", exact: true }).click();

  test("isn't there before any Run; appears left of Problems, which doesn't move", async ({ page }) => {
    await openApp(page);
    await expect(runnerButton(page)).toHaveCount(0);
    const before = await box(problemsButton(page));

    await runFile(page, "api", "pets.http");
    await expect(runnerButton(page)).toHaveText("Run: 3 passed");
    const [runner, after] = [await box(runnerButton(page)), await box(problemsButton(page))];
    expect(after).toEqual(before);
    expect(runner.x + runner.width).toBeLessThanOrEqual(after.x);
  });

  test("mid-run it shows the progress bar and Run n/m, the request being sent pulsing", async ({ page }) => {
    await openApp(page, "?download=slow");
    await runFile(page, "api", "pets.http");

    await expect(runnerButton(page)).toHaveText("Run 0/3");
    await expect(fill(page, "sending")).toBeVisible();
    expect(await fill(page, "sending").evaluate((e) => getComputedStyle(e).animationName)).not.toBe("none");
    await expect(runnerButton(page)).toHaveText("Run 1/3", { timeout: 5000 });
    expect((await box(progress(page))).width).toBe(48);
    expect((await box(fill(page, "passed"))).width).toBeCloseTo(16, 0);
    await expect(runnerPanel(page)).toContainText("Run 1/3");
  });

  test("under reduced motion, nothing pulses", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openApp(page, "?download=slow");
    await runFile(page, "api", "pets.http");
    await expect(fill(page, "sending")).toBeVisible();
    expect(await fill(page, "sending").evaluate((e) => getComputedStyle(e).animationName)).toBe("none");
  });

  test("a failure mid-run shows · 1 failed and the failed share in the warning colour; stopped, it reads Run stopped: n/m", async ({ page }) => {
    await openApp(page, "?trusted=1&status=404&download=slow");
    await runFile(page, "samples", "jetbrains.http");

    await expect(runnerButton(page)).toHaveText("Run 2/5 · 1 failed", { timeout: 8000 });
    const warning = await token(page, "--warning");
    expect(await colour(runnerButton(page).getByText("· 1 failed"))).toBe(warning);
    expect(await fill(page, "failed").evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(warning);
    expect((await box(fill(page, "failed"))).width).toBeCloseTo(48 / 5, 0);
    await expect(runnerPanel(page)).toContainText("Run 2/5 · 1 failed");

    await stop(page);
    await expect(runnerButton(page)).toHaveText("Run stopped: 2/5 · 1 failed");
    await expect(progress(page)).toHaveCount(0);
    await expect(runnerPanel(page)).toContainText("Run stopped: 2/5 · 1 failed");
  });

  test("a finished Run reads its passed and failed counts, as the Runner panel does", async ({ page }) => {
    await openApp(page, "?trusted=1&status=404");
    await runFile(page, "samples", "jetbrains.http");

    await expect(runnerButton(page)).toHaveText("Run: 4 passed · 1 failed");
    await expect(progress(page)).toHaveCount(0);
    await expect(runnerPanel(page)).toContainText("Run: 4 passed · 1 failed");
  });

  test("a Run stopped before any request finished reads Run stopped: 0/m", async ({ page }) => {
    await openApp(page, "?download=slow");
    await runFile(page, "api", "pets.http");
    await expect(runnerButton(page)).toHaveText("Run 0/3");
    await stop(page);
    await expect(runnerButton(page)).toHaveText("Run stopped: 0/3");
    await expect(runnerPanel(page)).toContainText("Run stopped: 0/3");
  });

  test("clicking it opens and closes the Runner panel, wherever focus is, and aria-pressed follows", async ({ page }) => {
    await openApp(page);
    await openRequest(page, ["api", "pets.http"], "List pets");
    await runFile(page, "api", "pets.http");
    await expect(runnerButton(page)).toHaveText("Run: 3 passed");
    await expect(runnerButton(page)).toHaveAttribute("aria-pressed", "true");

    await urlBar(page).click();
    await runnerButton(page).click();
    await expect(runnerPanel(page)).toHaveCount(0);
    await expect(runnerButton(page)).toHaveAttribute("aria-pressed", "false");

    await runnerButton(page).click();
    await expect(runnerPanel(page)).toBeVisible();
    await expect(runnerButton(page)).toHaveAttribute("aria-pressed", "true");
  });

  test("its tooltip says what the Run is and what clicking opens", async ({ page }) => {
    await openApp(page);
    await runFile(page, "api", "pets.http");
    await expect(runnerButton(page)).toHaveText("Run: 3 passed");
    await runnerButton(page).hover();
    await expect(page.getByRole("tooltip")).toHaveText("Run: 3 passed. Opens the Runner panel");
  });

  test("an ended Run turns muted once the Runner panel has been shown, until the next Run", async ({ page }) => {
    await openApp(page, "?download=slow");
    const [text, muted] = [await token(page, "--text"), await token(page, "--muted")];
    await runFile(page, "api", "pets.http");
    await expect(runnerButton(page)).toHaveText("Run 0/3");
    // Closed before it ends: its results haven't been seen.
    await runnerButton(page).click();
    await expect(runnerPanel(page)).toHaveCount(0);
    await page.mouse.move(0, 300);
    await expect(runnerButton(page)).toHaveText("Run: 3 passed", { timeout: 10000 });
    expect(await colour(runnerButton(page))).toBe(text);

    await runnerButton(page).click();
    await expect(runnerPanel(page)).toBeVisible();
    await runnerButton(page).click();
    await page.mouse.move(0, 300);
    await expect.poll(() => colour(runnerButton(page))).toBe(muted);

    await runFile(page, "api", "pets.http");
    await expect(runnerButton(page)).toHaveText("Run 0/3");
    await runnerButton(page).click();
    await expect(runnerPanel(page)).toHaveCount(0);
    await page.mouse.move(0, 300);
    await expect.poll(() => colour(runnerButton(page))).toBe(text);
  });
});
