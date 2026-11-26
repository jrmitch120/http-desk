// #217, #226: the bottom bar along the bottom of the window, below the panel area, with
// Problems at its right end, in a fixed-width button so a changing count moves nothing.
// Problems shows its icon and count, "0" included: muted at
// zero, the count in the warning colour with problems. It opens and closes the
// Problems panel, wherever focus is, with aria-pressed while the panel is open. The
// count follows the problems once they've stopped changing for about 300 ms, so it
// doesn't flicker as you type; the panel's list stays live. A changing count moves
// nothing in the topbar or the bottom bar but its own digits.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { activeTab, dialog, hasRing, openApp, openRequest, seedHistory, tab, tabTo, treeMenu, urlBar, writeFileText } from "./helpers";

const bottomBar = (page: Page) => page.getByRole("contentinfo", { name: "Bottom bar" });
const problemsButton = (page: Page) => bottomBar(page).getByRole("button", { name: /^Show Problems/ });
const problemsPanel = (page: Page) => page.getByRole("region", { name: "Problems" });
const group = (page: Page, file: string) => problemsPanel(page).getByRole("group", { name: file });
const fileView = (page: Page) => page.locator(".file-view .file-code");
/** The left group: the active tab's file's facts, each a focusable text with a tooltip. */
const fileGroup = (page: Page) => bottomBar(page).getByRole("group", { name: "Active file" });
const fileFacts = (page: Page) => fileGroup(page).locator(":scope > *");

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

// #231: the left group shows the active tab's file's line endings and encoding, for a
// request tab or a File view; nothing for anything not backed by a file.
test.describe("the active file's facts", () => {
  const PETS = "/demo/api/pets.http";
  const pets = (ending: string) => ["### List pets", "GET {{baseUrl}}/pets", "", "### Create pet", "POST {{baseUrl}}/pets", ""].join(ending);

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
      await expect(fileFacts(page)).toHaveText(facts);
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

/** The mock's files "on disk", and its way of changing one while the app runs (src/dev/mock.ts). */
interface DiskMock {
  files: Record<string, unknown>;
  writeText: (path: string, text: string) => void;
  changeFile: (path: string, file: unknown) => Promise<void>;
}
