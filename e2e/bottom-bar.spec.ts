// #217, #226: the bottom bar along the bottom of the window, below the panel area, with
// Problems at its right end, in a fixed-width button so a changing count moves nothing.
// Problems shows its icon and count, "0" included: muted at
// zero, the count in the warning colour with problems. It opens and closes the
// Problems panel, wherever focus is, with aria-pressed while the panel is open. The
// count follows the problems once they've stopped changing for about 300 ms, so it
// doesn't flicker as you type; the panel's list stays live. A changing count moves
// nothing in the topbar or the bottom bar but its own digits.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { activeTab, dialog, hasRing, menuClick, mockState, openApp, openRequest, seedHistory, sentRequests, tab, tabTo, treeItem, treeMenu, urlBar, writeFileText } from "./helpers";

const bottomBar = (page: Page) => page.getByRole("contentinfo", { name: "Bottom bar" });
const problemsButton = (page: Page) => bottomBar(page).getByRole("button", { name: /^Show Problems/ });
const problemsPanel = (page: Page) => page.getByRole("region", { name: "Problems" });
const group = (page: Page, file: string) => problemsPanel(page).getByRole("group", { name: file });
const fileView = (page: Page) => page.locator(".file-view .file-code");
/** The left group: the active tab's file's facts, each a focusable text with a tooltip. */
const fileGroup = (page: Page) => bottomBar(page).getByRole("group", { name: "Active file" });
const fileFacts = (page: Page) => fileGroup(page).locator(":scope > *");
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
/** api/pets.http in the mock workspace, and its text with every line ending `ending`. */
const PETS = "/demo/api/pets.http";
const pets = (ending: string) => ["### List pets", "GET {{baseUrl}}/pets", "", "### Create pet", "POST {{baseUrl}}/pets", ""].join(ending);

const historyOff = (page: Page) => bottomBar(page).getByRole("button", { name: /History off/ });
/** The History slot, always shown: "History" while the switch is on, "History off" while it's off. */
const historyItem = (page: Page) => bottomBar(page).getByRole("button", { name: /^History/ });
const historySection = (page: Page) => dialog(page, "Settings").getByRole("region", { name: "History" });
const historySwitch = (page: Page) => historySection(page).getByRole("switch", { name: "Record History" });

/** Flips the History switch in Settings (keeping what's stored when turning it off), then closes Settings. */
async function flipHistory(page: Page) {
  await page.keyboard.press("Meta+Comma");
  const wasOn = (await historySwitch(page).getAttribute("aria-checked")) === "true";
  await historySwitch(page).click();
  if (wasOn) await dialog(page, "Also delete existing history?").getByRole("button", { name: "Keep" }).click();
  await expect(historySwitch(page)).toHaveAttribute("aria-checked", wasOn ? "false" : "true");
  await dialog(page, "Settings").getByRole("button", { name: "Done" }).click();
}

/** Expands the folders of `path`, then picks Run file on its file. */
async function runFile(page: Page, ...path: string[]) {
  for (const folder of path.slice(0, -1)) {
    const row = treeItem(page, folder);
    if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  }
  await treeMenu(page, path.at(-1)!, "Run file");
}

const scriptsSkipped = (page: Page) => bottomBar(page).getByRole("button", { name: "Scripts skipped" });
/** The Scripts slot, always shown: "Scripts", or "Scripts skipped" while the skip is in force. */
const scriptsItem = (page: Page) => bottomBar(page).getByRole("button", { name: /^Scripts/ });
const trustPrompt = (page: Page) => dialog(page, "Run this workspace's scripts?");
const send = (page: Page) => page.getByRole("button", { name: "Send", exact: true }).click();
const openHandler = (page: Page) => openRequest(page, ["samples", "jetbrains.http"], "Post with JSON body");

async function skipScripts(page: Page) {
  await openHandler(page);
  await send(page);
  await trustPrompt(page).getByRole("button", { name: "Send without scripts" }).click();
  await expect(page.getByText("Sent without scripts: the response handler didn't run.")).toBeVisible();
}

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
  // Every slot is always there (#235): Runner, Portability, History, Scripts, Problems.
  await expect(bottomBar(page).getByRole("button")).toHaveCount(5);
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
    const button = document.querySelector("footer button[aria-label^='Show Problems']")!;
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

// #231: the left group shows the active tab's file's line endings and encoding, for a
// request tab or a File view; nothing for anything not backed by a file.
test.describe("the active file's facts", () => {

  test("a request in an LF file shows LF and UTF-8", async ({ page }) => {
    await openApp(page);
    await openRequest(page, ["api", "pets.http"], "List pets");
    await expect(fileFacts(page)).toHaveText(["LF", "UTF-8"]);
  });

  for (const { name, text, facts } of [
    { name: "a CRLF file", text: pets("\r\n"), facts: ["CRLF", "UTF-8"] },
    // Mostly CRLF; List pets' request line ends in LF.
    { name: "a file with mixed endings", text: pets("\r\n").replace("pets\r\n", "pets\n"), facts: ["Mixed", "UTF-8"] },
    { name: "a file that starts with a BOM", text: `﻿${pets("\n")}`, facts: ["LF", "UTF-8 BOM"] },
  ]) {
    test(`a request in ${name} shows ${facts.join(" and ")}, and so does the file's File view`, async ({ page }) => {
      await openApp(page);
      await writeFileText(page, PETS, text);
      await page.reload();
      await openRequest(page, ["api", "pets.http"], "List pets");
      await expect(fileFacts(page)).toHaveText(facts);

      await treeMenu(page, "pets.http", "View file as text");
      await expect(activeTab(page)).toContainText("pets.http");
      // A File view adds the caret (#232).
      await expect(fileFacts(page)).toHaveText([...facts, "Ln 1, Col 1"]);
    });
  }

  test("they follow the active tab, and the left group is empty on a History entry or with no tab open", async ({ page }) => {
    await seedHistory(page, [{ url: "https://api.test/pets/1", time: new Date(Date.UTC(2026, 10, 16, 8, 1)).toISOString() }]);
    await openApp(page);
    await writeFileText(page, "/demo/samples/jetbrains.http", "### Plain\r\nGET https://api.test/plain\r\n");
    await page.reload();
    await openRequest(page, ["api", "pets.http"], "List pets");
    await expect(fileFacts(page)).toHaveText(["LF", "UTF-8"]);
    await openRequest(page, ["samples", "jetbrains.http"], "Plain");
    await expect(fileFacts(page)).toHaveText(["CRLF", "UTF-8"]);
    await tab(page, "List pets").click();
    await expect(fileFacts(page)).toHaveText(["LF", "UTF-8"]);

    // A History entry isn't backed by a file.
    await page.getByRole("radiogroup", { name: "Sidebar" }).getByRole("radio", { name: "History" }).click();
    await page.getByRole("region", { name: "Workspace History" }).getByRole("listitem").first().click();
    await expect(dialog(page, "History entry")).toBeVisible();
    await expect(fileFacts(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog(page, "History entry")).toHaveCount(0);
    await expect(fileFacts(page)).toHaveText(["LF", "UTF-8"]);

    // No tab open.
    await activeTab(page).click();
    await page.keyboard.press("Meta+W");
    await page.keyboard.press("Meta+W");
    await expect(page.getByRole("tablist", { name: "Open requests" }).getByRole("tab")).toHaveCount(0);
    await expect(fileFacts(page)).toHaveCount(0);
  });

  test("a change on disk updates them", async ({ page }) => {
    await openApp(page);
    await writeFileText(page, PETS, pets("\r\n"));
    await page.reload();
    await openRequest(page, ["api", "pets.http"], "List pets");
    await expect(fileFacts(page)).toHaveText(["CRLF", "UTF-8"]);

    // Another editor saves it with LF endings and a BOM.
    await page.evaluate(
      async ([path, text]) => {
        const mock = (window as unknown as { __mock: DiskMock }).__mock;
        mock.writeText(path, text);
        await mock.changeFile(path, mock.files[path]);
      },
      [PETS, `﻿${pets("\n")}`],
    );
    await expect(fileFacts(page)).toHaveText(["LF", "UTF-8 BOM"]);
  });

  test("each fact's tooltip is reachable from the keyboard and says what HttpDesk keeps", async ({ page }) => {
    await openApp(page);
    await writeFileText(page, PETS, `﻿${pets("\r\n").replace("pets\r\n", "pets\n")}`);
    await page.reload();
    await openRequest(page, ["api", "pets.http"], "List pets");
    const endings = fileGroup(page).getByText("Mixed", { exact: true });
    const encoding = fileGroup(page).getByText("UTF-8 BOM", { exact: true });

    await tabTo(page, endings, 80);
    expect(await hasRing(endings)).toBe(true);
    await expect(page.getByRole("tooltip")).toHaveText(
      "Line endings: mixed CRLF and LF. HttpDesk keeps each line's own ending; a new line gets CRLF, the file's most common.",
    );
    await page.keyboard.press("Tab");
    await expect(encoding).toBeFocused();
    await expect(page.getByRole("tooltip")).toHaveText("Encoding: UTF-8, starting with a byte order mark (BOM). HttpDesk keeps the BOM on save.");
  });
});

// #232: in a File view, the left group also shows the caret's "Ln l, Col c" (1-based,
// columns counting characters), after the line endings and encoding.
test.describe("the File view's caret", () => {
  const caret = (page: Page) => fileFacts(page).nth(2);
  /** The File view's editor line that reads `text`. */
  const line = (page: Page, text: string) => fileView(page).locator(".cm-line").filter({ hasText: text });
  /** Opens api/pets.http's File view from the explorer. */
  async function viewPets(page: Page) {
    if ((await treeItem(page, "api").getAttribute("aria-expanded")) !== "true") await treeItem(page, "api").click();
    await treeMenu(page, "pets.http", "View file as text");
    await expect(activeTab(page)).toContainText("pets.http");
  }

  test("follows the caret as it moves and as the user types", async ({ page }) => {
    await openApp(page);
    await writeFileText(page, PETS, pets("\n"));
    await page.reload();
    await viewPets(page);
    await expect(fileFacts(page)).toHaveText(["LF", "UTF-8", "Ln 1, Col 1"]);

    await line(page, "GET {{baseUrl}}/pets").first().click();
    await page.keyboard.press("End");
    await expect(caret(page)).toHaveText("Ln 2, Col 21");
    await page.keyboard.type("/1");
    await expect(caret(page)).toHaveText("Ln 2, Col 23");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Home");
    await expect(caret(page)).toHaveText("Ln 1, Col 1");
  });

  test("shows the line a Problems entry jumps to", async ({ page }) => {
    await openApp(page, "?problems=1");
    await problemsButton(page).click();
    await group(page, "problems/upload.http").getByRole("listitem").filter({ hasText: "Line 5" }).click();
    await expect(activeTab(page)).toContainText("upload.http");
    await expect(caret(page)).toHaveText("Ln 5, Col 1");

    await group(page, "problems/broken.http").getByRole("listitem").filter({ hasText: "Line 2" }).click();
    await expect(activeTab(page)).toContainText("broken.http");
    await expect(caret(page)).toHaveText("Ln 2, Col 1");
  });

  test("counts columns by characters, not UTF-16 units", async ({ page }) => {
    await openApp(page);
    // "😀" is two UTF-16 units: one character.
    await writeFileText(page, PETS, "### Smile 😀 é\nGET https://api.test/pets\n");
    await page.reload();
    await viewPets(page);
    await line(page, "### Smile").click();
    await page.keyboard.press("End");
    await expect(caret(page)).toHaveText("Ln 1, Col 14");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(caret(page)).toHaveText("Ln 1, Col 11");
  });

  test("a request tab shows no caret: switching from the File view to one removes it", async ({ page }) => {
    await openApp(page);
    await openRequest(page, ["api", "pets.http"], "List pets");
    await expect(fileFacts(page)).toHaveText(["LF", "UTF-8"]);
    await viewPets(page);
    await expect(fileFacts(page)).toHaveText(["LF", "UTF-8", "Ln 1, Col 1"]);
    await tab(page, "List pets").click();
    await expect(fileFacts(page)).toHaveText(["LF", "UTF-8"]);
  });

  test("a changing position doesn't move the line endings and encoding", async ({ page }) => {
    await openApp(page);
    await viewPets(page);
    await expect(caret(page)).toHaveText("Ln 1, Col 1");
    const endings = fileGroup(page).getByText("LF", { exact: true });
    const encoding = fileGroup(page).getByText("UTF-8", { exact: true });
    const before = [await box(endings), await box(encoding)];

    await line(page, "POST {{baseUrl}}/pets").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type("/many/more/characters");
    await expect(caret(page)).toHaveText(/^Ln \d\d, Col 43$/);
    expect([await box(endings), await box(encoding)]).toEqual(before);
  });

  test("its tooltip is reachable from the keyboard", async ({ page }) => {
    await openApp(page);
    await viewPets(page);
    await expect(caret(page)).toHaveText("Ln 1, Col 1");
    // The editor keeps Tab for itself until Escape.
    await fileView(page).locator(".cm-content").focus();
    await page.keyboard.press("Escape");
    await tabTo(page, caret(page), 20);
    expect(await hasRing(caret(page))).toBe(true);
    await expect(page.getByRole("tooltip")).toHaveText("The caret: line 1, column 1. Columns count characters.");
  });
});

/** The mock's files "on disk", and its way of changing one while the app runs (src/dev/mock.ts). */
interface DiskMock {
  files: Record<string, unknown>;
  writeText: (path: string, text: string) => void;
  changeFile: (path: string, file: unknown) => Promise<void>;
}

// #227, #235: the Runner item, in the centre: the current Run's progress and result, or a
// muted "Runner" before any Run.
// `?download=slow` makes each send take 2 s; with `?trusted=1&status=404`,
// samples/jetbrains.http's second request ("Post with JSON body") fails its test.
test.describe("Runner item", () => {
  const stop = (page: Page) => runnerPanel(page).getByRole("button", { name: "Stop", exact: true }).click();

  test("reads Runner before any Run, then the Run, in the same place", async ({ page }) => {
    await openApp(page);
    await expect(runnerButton(page)).toHaveText("Runner");
    const before = await box(runnerButton(page));

    await runFile(page, "api", "pets.http");
    await expect(runnerButton(page)).toHaveText("Run: 3 passed");
    expect(await box(runnerButton(page))).toEqual(before);
  });

  test("mid-run it shows the progress bar and Run n/m, the request being sent pulsing", async ({ page }) => {
    await openApp(page, "?download=slow");
    await runFile(page, "api", "pets.http");

    await expect(runnerButton(page)).toHaveText("Run 0/3");
    await expect(fill(page, "sending")).toBeVisible();
    expect(await fill(page, "sending").evaluate((e) => getComputedStyle(e).animationName)).not.toBe("none");
    await expect(runnerButton(page)).toHaveText("Run 1/3", { timeout: 5000 });
    expect((await box(progress(page))).width).toBe(160);
    expect((await box(fill(page, "passed"))).width).toBeCloseTo(160 / 3, 0);
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
    expect((await box(fill(page, "failed"))).width).toBeCloseTo(160 / 5, 0);
    await expect(runnerPanel(page)).toContainText("Run 2/5 · 1 failed");

    await stop(page);
    await expect(runnerButton(page)).toHaveText("Run stopped: 2/5 · 1 failed");
    // Ended, the bar stays, still: what finished, nothing pulsing.
    await expect(fill(page, "sending")).toHaveCSS("width", "0px");
    await expect(runnerPanel(page)).toContainText("Run stopped: 2/5 · 1 failed");
  });

  test("a finished Run reads its passed and failed counts, as the Runner panel does", async ({ page }) => {
    await openApp(page, "?trusted=1&status=404");
    await runFile(page, "samples", "jetbrains.http");

    await expect(runnerButton(page)).toHaveText("Run: 4 passed · 1 failed");
    expect((await box(fill(page, "passed"))).width).toBeCloseTo((160 * 4) / 5, 0);
    expect((await box(fill(page, "failed"))).width).toBeCloseTo(160 / 5, 0);
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

  test("lasts until another workspace opens", async ({ page }) => {
    await openApp(page, "?recent=/work/api");
    await runFile(page, "api", "pets.http");
    await expect(runnerButton(page)).toHaveText("Run: 3 passed");

    // The mock opens the demo workspace again for any recent path it doesn't know.
    await menuClick(page, "open-recent:/work/api");
    await expect(runnerButton(page)).toHaveText("Runner");
  });
});

// #228, #235: the Scripts slot, always shown: a muted "Scripts", and "Scripts skipped",
// warning-toned, while the user's "Send without scripts" is in force for the open,
// untrusted workspace. Clicking it then asks again: "Trust this workspace" (stored like
// "Trust and run") clears it; "Keep skipping" or Cancel leave it. Reopening the
// workspace ends the skip. Otherwise (trusted, or not asked yet) it opens Settings at
// Trusted workspaces.
test.describe("Scripts skipped", () => {
  const trustSection = (page: Page) => dialog(page, "Settings").getByRole("region", { name: "Trusted workspaces" });
  const askAgain = (page: Page) => dialog(page, "Trust this workspace?");

  test("a muted Scripts before the user is asked, then Scripts skipped warning-toned after Send without scripts", async ({ page }) => {
    await openApp(page);
    await openHandler(page);
    await expect(scriptsItem(page)).toHaveText("Scripts");
    await expect.poll(() => colour(scriptsItem(page))).toBe(await token(page, "--muted"));

    await send(page);
    await trustPrompt(page).getByRole("button", { name: "Send without scripts" }).click();
    await expect(scriptsSkipped(page)).toHaveText("Scripts skipped");
    await expect.poll(() => colour(scriptsSkipped(page))).toBe(await token(page, "--warning"));

    await scriptsSkipped(page).hover();
    await expect(page.getByRole("tooltip")).toContainText("sends in this workspace skip their scripts");
    await expect(page.getByRole("tooltip")).toContainText("trust");
  });

  test("sits left of Problems, in the right group", async ({ page }) => {
    await openApp(page);
    const [item, problems] = [await box(scriptsItem(page)), await box(problemsButton(page))];
    expect(item.x + item.width).toBeLessThanOrEqual(problems.x);
    expect(item.x).toBeGreaterThan((await box(bottomBar(page))).width / 2);
  });

  test("a muted Scripts in a trusted workspace", async ({ page }) => {
    await openApp(page, "?trusted=1");
    await openHandler(page);
    await send(page);
    await expect.poll(() => mockState(page, "sentSkipScripts")).toEqual([false]);
    await expect(scriptsItem(page)).toHaveText("Scripts");
    await expect.poll(() => colour(scriptsItem(page))).toBe(await token(page, "--muted"));
  });

  for (const [state, query] of [
    ["trusted", "?trusted=1"],
    ["not asked yet", ""],
  ] as const) {
    test(`${state}, clicking it opens Settings with Trusted workspaces in view`, async ({ page }) => {
      await page.setViewportSize({ width: 1000, height: 400 });
      await openApp(page, query);
      await scriptsItem(page).hover();
      await expect(page.getByRole("tooltip")).toContainText("Trusted workspaces");
      await scriptsItem(page).click();
      await expect(trustSection(page)).toBeInViewport();
      if (query) await expect(trustSection(page).getByTestId("trusted-workspace")).toContainText("/demo");
      else await expect(trustSection(page)).toContainText("No workspace is trusted yet.");
    });
  }

  test("clicking it asks again; Keep skipping and Cancel leave it", async ({ page }) => {
    await openApp(page);
    await skipScripts(page);

    await scriptsSkipped(page).click();
    const prompt = askAgain(page);
    await expect(prompt).toContainText("/demo");
    for (const name of ["Cancel", "Keep skipping", "Trust this workspace"]) {
      await expect(prompt.getByRole("button", { name, exact: true })).toBeVisible();
    }
    await expect(prompt.getByRole("button", { name: "Keep skipping" })).toBeFocused();
    await prompt.getByRole("button", { name: "Keep skipping" }).click();
    await expect(prompt).toBeHidden();
    await expect(scriptsSkipped(page)).toBeVisible();

    await scriptsSkipped(page).click();
    await askAgain(page).getByRole("button", { name: "Cancel" }).click();
    await expect(askAgain(page)).toBeHidden();
    await expect(scriptsSkipped(page)).toBeVisible();
    expect((await mockState(page, "settings")).trustedWorkspaces).toEqual([]);
  });

  test("Trust this workspace removes it, lists the workspace in Settings, and the next send runs its script", async ({ page }) => {
    await openApp(page);
    await skipScripts(page);

    await scriptsSkipped(page).click();
    await askAgain(page).getByRole("button", { name: "Trust this workspace" }).click();
    await expect(askAgain(page)).toBeHidden();
    await expect(scriptsSkipped(page)).toHaveCount(0);
    await expect(scriptsItem(page)).toHaveText("Scripts");
    expect((await mockState(page, "settings")).trustedWorkspaces).toEqual(["/demo"]);

    await page.getByRole("banner").getByRole("button", { name: "Settings" }).click();
    await expect(dialog(page, "Settings").getByTestId("trusted-workspace")).toContainText("/demo");
    await dialog(page, "Settings").getByRole("button", { name: "Done" }).click();

    await send(page);
    await expect.poll(() => mockState(page, "sentSkipScripts")).toEqual([true, false]);
    await expect(trustPrompt(page)).toBeHidden();
  });

  test("reopening the workspace clears it", async ({ page }) => {
    await openApp(page, "?recent=/work/api");
    await skipScripts(page);
    await expect(scriptsSkipped(page)).toBeVisible();

    // The mock opens the demo workspace again for any recent path it doesn't know.
    await menuClick(page, "open-recent:/work/api");
    await expect(scriptsSkipped(page)).toHaveCount(0);
    await expect(scriptsItem(page)).toHaveText("Scripts");
    expect(await sentRequests(page)).toHaveLength(1);
  });
});

// #230: Portability, always shown at the left end of the right group, names the editors
// turned on in Settings → Portability, or "HttpDesk only" with both off. It opens Settings there.
const portabilityButton = (page: Page) => bottomBar(page).getByRole("button", { name: /^Portability/ });
const portabilitySection = (page: Page) => dialog(page, "Settings").getByRole("region", { name: "Portability" });

test.describe("Portability", () => {
  for (const [query, label] of [
    ["", "HttpDesk only"],
    ["?portability=vscode", "VS Code"],
    ["?portability=rider", "Rider"],
    ["?portability=vscode,rider", "VS Code · Rider"],
  ] as const) {
    test(`reads "${label}" for those editors`, async ({ page }) => {
      await openApp(page, query);
      await expect(portabilityButton(page)).toHaveText(label);
    });
  }

  test("follows Settings at once", async ({ page }) => {
    await openApp(page);
    await expect(portabilityButton(page)).toHaveText("HttpDesk only");
    await page.keyboard.press("Meta+Comma");
    const settings = dialog(page, "Settings");
    await settings.getByRole("switch", { name: "Rider" }).click();
    await expect(portabilityButton(page)).toHaveText("Rider");
    await settings.getByRole("switch", { name: "VS Code" }).click();
    await expect(portabilityButton(page)).toHaveText("VS Code · Rider");
    await settings.getByRole("switch", { name: "Rider" }).click();
    await expect(portabilityButton(page)).toHaveText("VS Code");
    await settings.getByRole("switch", { name: "VS Code" }).click();
    await expect(portabilityButton(page)).toHaveText("HttpDesk only");
  });

  test("clicking it opens Settings with the Portability section in view", async ({ page }) => {
    // Short enough that Settings must scroll to show the whole section, down to its last switch.
    await page.setViewportSize({ width: 1000, height: 360 });
    await openApp(page);
    await portabilityButton(page).click();
    await expect(portabilitySection(page)).toBeInViewport();
    await expect(portabilitySection(page).getByRole("switch", { name: "Show portability notes as warnings" })).toBeInViewport({ ratio: 1 });
  });

  test("is reachable by Tab, with a focus ring and its tooltip", async ({ page }) => {
    await openApp(page, "?portability=vscode");
    await tabTo(page, portabilityButton(page), 80);
    expect(await hasRing(portabilityButton(page))).toBe(true);
    await expect(page.getByRole("tooltip")).toContainText("Portability notes show for VS Code");
    await page.keyboard.press("Enter");
    await expect(portabilitySection(page)).toBeInViewport();
  });

  test("with both editors off, the tooltip says Portability notes are off", async ({ page }) => {
    await openApp(page);
    await portabilityButton(page).hover();
    await expect(page.getByRole("tooltip")).toContainText("Portability notes are off");
  });

  test("sits left of Problems, and a longer label doesn't move or resize it", async ({ page }) => {
    await openApp(page);
    const problems = await box(problemsButton(page));
    const portability = await box(portabilityButton(page));
    expect(portability.x + portability.width).toBeLessThanOrEqual(problems.x);

    await page.keyboard.press("Meta+Comma");
    await dialog(page, "Settings").getByRole("switch", { name: "VS Code" }).click();
    await dialog(page, "Settings").getByRole("switch", { name: "Rider" }).click();
    await expect(portabilityButton(page)).toHaveText("VS Code · Rider");
    expect(await box(problemsButton(page))).toEqual(problems);
    expect(await box(portabilityButton(page))).toEqual(portability);
  });

  test("stays the left end of the right group, left of History", async ({ page }) => {
    await openApp(page);
    const history = await box(historyItem(page));
    const portability = await box(portabilityButton(page));
    expect(portability.x + portability.width).toBeLessThanOrEqual(history.x);
  });
});

// #229, #235: the History slot, always shown: a muted "History" while the History switch
// is on, "History off" in the text colour (a deliberate choice, not a warning) while
// it's off. It opens Settings at the History section.
test.describe("History off", () => {
  test("reads a muted History while the switch is on, History off while it's off", async ({ page }) => {
    await openApp(page);
    const [text, muted] = [await token(page, "--text"), await token(page, "--muted")];
    await expect(historyItem(page)).toHaveText("History");
    await expect(historyOff(page)).toHaveCount(0);
    await expect.poll(() => colour(historyItem(page))).toBe(muted);

    await flipHistory(page);
    await expect(historyOff(page)).toHaveText("History off");
    await page.mouse.move(0, 300);
    await expect.poll(() => colour(historyOff(page))).toBe(text);

    await flipHistory(page);
    await expect(historyItem(page)).toHaveText("History");
    await expect(historyOff(page)).toHaveCount(0);
  });

  test("with the switch on, clicking it opens Settings with the History section in view", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 500 });
    await openApp(page);
    await historyItem(page).click();
    await expect(historySwitch(page)).toBeInViewport();
    await expect(historySwitch(page)).toHaveAttribute("aria-checked", "true");
  });

  test("clicking it opens Settings with the History section in view", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 500 });
    await openApp(page);
    await flipHistory(page);

    await historyOff(page).click();
    await expect(historySwitch(page)).toBeInViewport();
    await expect(historySwitch(page)).toHaveAttribute("aria-checked", "false");
  });

  test("keyboard: reachable by Tab, with a focus ring and its tooltip", async ({ page }) => {
    await openApp(page);
    await flipHistory(page);

    await tabTo(page, historyOff(page), 80);
    expect(await hasRing(historyOff(page))).toBe(true);
    await expect(page.getByRole("tooltip")).toContainText("sends aren't recorded in History");
    await expect(page.getByRole("tooltip")).toContainText("open the setting");
    await page.keyboard.press("Enter");
    await expect(historySwitch(page)).toBeInViewport();
  });

  test("sits left of Problems, and neither moves when the switch goes off", async ({ page }) => {
    await openApp(page);
    const before = { history: await box(historyItem(page)), problems: await box(problemsButton(page)) };
    expect(before.history.x + before.history.width).toBeLessThanOrEqual(before.problems.x);

    await flipHistory(page);
    expect(await box(historyOff(page))).toEqual(before.history);
    expect(await box(problemsButton(page))).toEqual(before.problems);
  });
});

// #225, #235: the right group reads, left to right, Portability, History, Scripts,
// Problems, with the Runner in the centre, left of them all.
test("the items sit in the agreed order", async ({ page }) => {
  await openApp(page);
  const before = await box(problemsButton(page));

  await flipHistory(page);
  await skipScripts(page);
  await runFile(page, "api", "pets.http");
  await expect(runnerButton(page)).toHaveText("Run: 3 passed");

  const items = [runnerButton(page), portabilityButton(page), historyOff(page), scriptsSkipped(page), problemsButton(page)];
  const boxes = await Promise.all(items.map(box));
  for (let i = 1; i < boxes.length; i++) expect(boxes[i - 1].x + boxes[i - 1].width).toBeLessThanOrEqual(boxes[i].x);
  expect(boxes.at(-1)).toEqual(before);
});

// #235: every item has a permanent slot of fixed width, and a condition changes only
// what's inside it. The Runner sits in the true centre; the right group holds
// Portability, History, Scripts and Problems. Nothing in either moves or resizes.
test("no item moves or resizes as the Run, History, Scripts and Portability change", async ({ page }) => {
  await openApp(page, "?status=404&download=slow");
  const slots = [portabilityButton(page), historyItem(page), scriptsItem(page), problemsButton(page), runnerButton(page)];
  const boxes = () => Promise.all(slots.map(box));
  await expect(runnerButton(page)).toHaveText("Runner");
  const before = await boxes();
  const unmoved = async (when: string) => expect(await boxes(), when).toEqual(before);

  await flipHistory(page);
  await expect(historyItem(page)).toHaveText("History off");
  await unmoved("History off");
  await flipHistory(page);
  await expect(historyItem(page)).toHaveText("History");
  await unmoved("History on");

  await skipScripts(page);
  await expect(scriptsItem(page)).toHaveText("Scripts skipped");
  await unmoved("Scripts skipped");
  await scriptsItem(page).click();
  await dialog(page, "Trust this workspace?").getByRole("button", { name: "Trust this workspace" }).click();
  await expect(scriptsItem(page)).toHaveText("Scripts");
  await unmoved("Scripts trusted");

  await page.keyboard.press("Meta+Comma");
  await dialog(page, "Settings").getByRole("switch", { name: "VS Code" }).click();
  await expect(portabilityButton(page)).toHaveText("VS Code");
  await dialog(page, "Settings").getByRole("switch", { name: "Rider" }).click();
  await expect(portabilityButton(page)).toHaveText("VS Code · Rider");
  await dialog(page, "Settings").getByRole("button", { name: "Done" }).click();
  await unmoved("Portability VS Code · Rider");

  await runFile(page, "api", "pets.http");
  await expect(runnerButton(page)).toHaveText("Run 0/3");
  await unmoved("running");
  await expect(runnerButton(page)).toHaveText("Run: 3 passed", { timeout: 10000 });
  await unmoved("ended");

  await runFile(page, "samples", "jetbrains.http");
  await expect(runnerButton(page)).toHaveText("Run 2/5 · 1 failed", { timeout: 8000 });
  await runnerPanel(page).getByRole("button", { name: "Stop", exact: true }).click();
  await expect(runnerButton(page)).toHaveText("Run stopped: 2/5 · 1 failed");
  await unmoved("stopped with failures");
});

test("the Runner sits in the centre of the window, whatever the left group holds", async ({ page }) => {
  await openApp(page);
  const width = page.viewportSize()!.width;
  const centre = async () => {
    const b = await box(runnerButton(page));
    return b.x + b.width / 2;
  };
  await expect(fileFacts(page)).toHaveCount(0);
  expect(Math.abs((await centre()) - width / 2)).toBeLessThanOrEqual(1);
  await treeItem(page, "api").click();
  await treeMenu(page, "pets.http", "View file as text");
  await expect(fileFacts(page)).toHaveText(["LF", "UTF-8", "Ln 1, Col 1"]);
  expect(Math.abs((await centre()) - width / 2)).toBeLessThanOrEqual(1);
});

test("before any Run, a muted Runner opens the Runner panel", async ({ page }) => {
  await openApp(page);
  await expect(runnerButton(page)).toHaveText("Runner");
  await expect(runnerButton(page)).toHaveAccessibleName("Show Runner");
  await expect.poll(() => colour(runnerButton(page))).toBe(await token(page, "--muted"));
  await runnerButton(page).click();
  await expect(runnerPanel(page)).toBeVisible();
  await expect(runnerButton(page)).toHaveAttribute("aria-pressed", "true");
});

test("the Runner's text has a fixed width with tabular numerals, and its progress bar is 160 px", async ({ page }) => {
  await openApp(page);
  const text = runnerButton(page).locator(".run-text");
  expect(await text.evaluate((e) => getComputedStyle(e).fontVariantNumeric)).toBe("tabular-nums");
  const width = (await box(text)).width;
  // Sized for the longest text it shows.
  const longest = await text.evaluate((e) => {
    const probe = document.createElement("span");
    probe.textContent = "Run stopped: 99/99 · 99 failed";
    probe.style.whiteSpace = "nowrap";
    probe.style.fontVariantNumeric = "tabular-nums";
    e.after(probe);
    const w = probe.getBoundingClientRect().width;
    probe.remove();
    return w;
  });
  expect(Math.abs(width - longest)).toBeLessThanOrEqual(1);
  expect((await box(progress(page))).width).toBe(160);
});

// Each text item's label sits centred in its button, so its hover box is even on both sides.
test("every text item's label is centred in its button", async ({ page }) => {
  await openApp(page);
  const items = [
    bottomBar(page).getByRole("button", { name: /^Portability/ }),
    historyItem(page),
    scriptsItem(page),
    runnerButton(page).locator(".run-text"),
  ];
  for (const item of items) {
    const [text, outer] = await item.evaluate((el) => {
      const shown = el.querySelector(".shown")!;
      const range = document.createRange();
      range.selectNodeContents(shown);
      const t = range.getBoundingClientRect();
      const o = el.querySelector(".slot")?.getBoundingClientRect() ?? el.getBoundingClientRect();
      return [t.left + t.width / 2, o.left + o.width / 2];
    });
    expect(Math.abs(text - outer)).toBeLessThanOrEqual(1);
  }
});
