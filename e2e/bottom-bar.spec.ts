// #217, #226: the bottom bar along the bottom of the window, below the panel area, with
// Problems at its right end, in a fixed-width button so a changing count moves nothing.
// Problems shows its icon and count, "0" included: muted at
// zero, the count in the warning colour with problems. It opens and closes the
// Problems panel, wherever focus is, with aria-pressed while the panel is open. The
// count follows the problems once they've stopped changing for about 300 ms, so it
// doesn't flicker as you type; the panel's list stays live. A changing count moves
// nothing in the topbar or the bottom bar but its own digits.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialog, hasRing, menuClick, mockState, openApp, openRequest, sentRequests, tabTo, urlBar } from "./helpers";

const bottomBar = (page: Page) => page.getByRole("contentinfo", { name: "Bottom bar" });
const problemsButton = (page: Page) => bottomBar(page).getByRole("button", { name: /^Show Problems/ });
const problemsPanel = (page: Page) => page.getByRole("region", { name: "Problems" });
const group = (page: Page, file: string) => problemsPanel(page).getByRole("group", { name: file });
const fileView = (page: Page) => page.locator(".file-view .file-code");

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

// #228: "Scripts skipped", warning-toned, while the user's "Send without scripts" is in
// force for the open, untrusted workspace. Clicking it asks again: "Trust this
// workspace" (stored like "Trust and run") clears it; "Keep skipping" or Cancel leave
// it. Reopening the workspace ends the skip, and the item with it.
test.describe("Scripts skipped", () => {
  const scriptsSkipped = (page: Page) => bottomBar(page).getByRole("button", { name: "Scripts skipped" });
  const trustPrompt = (page: Page) => dialog(page, "Run this workspace's scripts?");
  const askAgain = (page: Page) => dialog(page, "Trust this workspace?");
  const send = (page: Page) => page.getByRole("button", { name: "Send", exact: true }).click();
  const openHandler = (page: Page) => openRequest(page, ["samples", "jetbrains.http"], "Post with JSON body");

  async function skipScripts(page: Page) {
    await openHandler(page);
    await send(page);
    await trustPrompt(page).getByRole("button", { name: "Send without scripts" }).click();
    await expect(page.getByText("Sent without scripts: the response handler didn't run.")).toBeVisible();
  }

  test("not shown before the user is asked, then shown warning-toned after Send without scripts", async ({ page }) => {
    await openApp(page);
    await openHandler(page);
    await expect(problemsButton(page)).toBeVisible();
    await expect(scriptsSkipped(page)).toHaveCount(0);

    await send(page);
    await trustPrompt(page).getByRole("button", { name: "Send without scripts" }).click();
    await expect(scriptsSkipped(page)).toHaveText("Scripts skipped");
    await expect.poll(() => colour(scriptsSkipped(page))).toBe(await token(page, "--warning"));

    await scriptsSkipped(page).hover();
    await expect(page.getByRole("tooltip")).toContainText("sends in this workspace skip their scripts");
    await expect(page.getByRole("tooltip")).toContainText("trust");
  });

  test("appears left of Problems, in the right group, and Problems' box doesn't move", async ({ page }) => {
    await openApp(page);
    await openHandler(page);
    const before = await box(problemsButton(page));
    await send(page);
    await trustPrompt(page).getByRole("button", { name: "Send without scripts" }).click();
    await expect(scriptsSkipped(page)).toBeVisible();

    expect(await box(problemsButton(page))).toEqual(before);
    const item = await box(scriptsSkipped(page));
    expect(item.x + item.width).toBeLessThanOrEqual(before.x);
    expect(item.x).toBeGreaterThan((await box(bottomBar(page))).width / 2);
  });

  test("not shown in a trusted workspace", async ({ page }) => {
    await openApp(page, "?trusted=1");
    await openHandler(page);
    await send(page);
    await expect.poll(() => mockState(page, "sentSkipScripts")).toEqual([false]);
    await expect(scriptsSkipped(page)).toHaveCount(0);
  });

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
    expect(await sentRequests(page)).toHaveLength(1);
  });
});

// #229: History off. Shown only while the History switch is off, muted (a deliberate
// choice, not a warning). It opens Settings at the History section.
test.describe("History off", () => {
  const historyOff = (page: Page) => bottomBar(page).getByRole("button", { name: /History off/ });
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

  test("shows, muted, only while the History switch is off", async ({ page }) => {
    await openApp(page);
    await expect(historyOff(page)).toHaveCount(0);

    await flipHistory(page);
    await expect(historyOff(page)).toHaveText("History off");
    await expect.poll(() => colour(historyOff(page))).toBe(await token(page, "--muted"));

    await flipHistory(page);
    await expect(historyOff(page)).toHaveCount(0);
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

  test("sits left of Problems, whose box doesn't move when it appears", async ({ page }) => {
    await openApp(page);
    const before = await box(problemsButton(page));

    await flipHistory(page);
    const off = await box(historyOff(page));
    expect(await box(problemsButton(page))).toEqual(before);
    expect(off.x + off.width).toBeLessThanOrEqual(before.x);
  });
});
