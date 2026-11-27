// #238: Settings is a fixed-size modal with a rail of six categories down its left
// side (a vertical tablist) and the selected category's page (its tabpanel) on the right.
import { expect, test, type Page } from "@playwright/test";
import { dialog, openApp } from "./helpers";

const CATEGORIES = ["General", "Requests", "TLS", "Portability", "History", "Trusted workspaces"];

const settings = (page: Page) => dialog(page, "Settings");
const rail = (page: Page) => settings(page).getByRole("tablist", { name: "Settings categories" });
const categoryTab = (page: Page, name: string) => rail(page).getByRole("tab", { name, exact: true });
const panel = (page: Page, name: string) => settings(page).getByRole("tabpanel", { name, exact: true });

test("the rail lists the six categories in order, each with an icon, General selected from the gear", async ({ page }) => {
  await openApp(page);
  await page.getByRole("banner").getByRole("button", { name: "Settings" }).click();
  await expect(rail(page)).toHaveAttribute("aria-orientation", "vertical");
  await expect(rail(page).getByRole("tab")).toHaveText(CATEGORIES);
  for (const name of CATEGORIES) await expect(categoryTab(page, name).locator("svg")).toBeVisible();
  await expect(rail(page).getByRole("tab", { selected: true })).toHaveText("General");
  await expect(panel(page, "General")).toBeVisible();
});

test("Settings opened with ⌘, shows General", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  await expect(rail(page).getByRole("tab", { selected: true })).toHaveText("General");
  await expect(panel(page, "General")).toBeVisible();
});

test("clicking a tab shows only that category's page, with its heading", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  await categoryTab(page, "TLS").click();
  await expect(categoryTab(page, "TLS")).toHaveAttribute("aria-selected", "true");
  await expect(categoryTab(page, "General")).toHaveAttribute("aria-selected", "false");
  await expect(settings(page).getByRole("tabpanel")).toHaveCount(1);
  await expect(panel(page, "TLS").getByRole("heading", { name: "TLS" })).toBeVisible();
  await expect(panel(page, "TLS").getByRole("switch", { name: "Verify server certificates" })).toBeVisible();
  // General's settings are not shown.
  await expect(settings(page).getByRole("radiogroup", { name: "Theme" })).toHaveCount(0);
});

test("every setting sits under its new category", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  const expected: Record<string, string[]> = {
    General: ["Theme", "Response position", "Show parameter descriptions", "Check for updates on startup", "Check now"],
    Requests: ["Idle timeout", "Connection timeout", "Follow redirects", "Maximum redirects", "Maximum body size"],
    TLS: ["Verify server certificates", "CA certificate", "Client certificate", "Client key"],
    Portability: ["VS Code", "Rider", "Show portability notes as warnings"],
    History: ["Record History", "Entries per request", "Keep for", "Total size", "Location", "Clear all history"],
  };
  for (const [category, labels] of Object.entries(expected)) {
    await categoryTab(page, category).click();
    await expect(panel(page, category).locator(".setting > .label > span:first-child")).toHaveText(labels);
  }
  await categoryTab(page, "General").click();
  await expect(panel(page, "General")).toContainText("Downloads come from the project's GitHub releases");
  await expect(panel(page, "General").getByRole("button", { name: "Check for updates" })).toBeVisible();
  await categoryTab(page, "Requests").click();
  await expect(panel(page, "Requests")).toContainText("Larger responses are truncated");
  await expect(panel(page, "Requests")).toContainText("directives override these defaults");
  await categoryTab(page, "Trusted workspaces").click();
  await expect(panel(page, "Trusted workspaces")).toContainText("No workspace is trusted yet.");
});

test("the bottom bar's items open Settings on their category, whichever was shown before", async ({ page }) => {
  await openApp(page);
  const bottomBar = page.getByRole("contentinfo", { name: "Bottom bar" });
  for (const [item, category] of [
    [/^Portability/, "Portability"],
    [/^History/, "History"],
    [/^Scripts/, "Trusted workspaces"],
  ] as const) {
    await page.keyboard.press("Meta+Comma");
    await categoryTab(page, "Requests").click();
    await settings(page).getByRole("button", { name: "Done" }).click();
    await bottomBar.getByRole("button", { name: item }).click();
    await expect(rail(page).getByRole("tab", { selected: true })).toHaveText(category);
    await expect(panel(page, category)).toBeVisible();
    await settings(page).getByRole("button", { name: "Done" }).click();
  }
});

test("the modal keeps its size across categories, and a long Trusted workspaces list scrolls inside the page", async ({ page }) => {
  // The smallest window HttpDesk allows.
  await page.setViewportSize({ width: 960, height: 600 });
  const many = Array.from({ length: 30 }, (_, i) => `/work/project-${i}`);
  await openApp(page, `?trusted=${many.join(",")}`);
  await page.keyboard.press("Meta+Comma");
  // Measured once it has finished popping in.
  await settings(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const first = (await settings(page).boundingBox())!;
  expect(first.y).toBeGreaterThanOrEqual(0);
  expect(first.y + first.height).toBeLessThanOrEqual(600);
  for (const name of CATEGORIES) {
    await categoryTab(page, name).click();
    expect(await settings(page).boundingBox()).toEqual(first);
  }
  const trust = panel(page, "Trusted workspaces");
  const rows = trust.getByTestId("trusted-workspace");
  await expect(rows).toHaveCount(30);
  const done = settings(page).getByRole("button", { name: "Done" });
  const [railBefore, doneBefore] = [await rail(page).boundingBox(), await done.boundingBox()];
  await expect(rows.last()).not.toBeInViewport();
  await rows.last().scrollIntoViewIfNeeded();
  await expect(rows.last()).toBeInViewport();
  expect(await trust.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await rail(page).boundingBox()).toEqual(railBefore);
  expect(await done.boundingBox()).toEqual(doneBefore);
  await expect(done).toBeInViewport();
});

// #239: Settings reopens on the category last selected during this run, General after
// a reload, and a deep link selects (and is then remembered as) its own category.
test.describe("Settings reopens on the last-visited category", () => {
  const gear = (page: Page) => page.getByRole("banner").getByRole("button", { name: "Settings" });
  const done = (page: Page) => settings(page).getByRole("button", { name: "Done" });
  const selected = (page: Page) => rail(page).getByRole("tab", { selected: true });

  test("selecting Requests, closing and reopening from the gear shows Requests", async ({ page }) => {
    await openApp(page);
    await gear(page).click();
    await categoryTab(page, "Requests").click();
    await done(page).click();
    await gear(page).click();
    await expect(selected(page)).toHaveText("Requests");
    await expect(panel(page, "Requests")).toBeVisible();
    // ⌘, opens there too.
    await done(page).click();
    await page.keyboard.press("Meta+Comma");
    await expect(selected(page)).toHaveText("Requests");
  });

  test("after a reload, Settings opens on General again", async ({ page }) => {
    await openApp(page);
    await gear(page).click();
    await categoryTab(page, "TLS").click();
    await done(page).click();
    await openApp(page);
    await gear(page).click();
    await expect(selected(page)).toHaveText("General");
    await expect(panel(page, "General")).toBeVisible();
  });

  test("a deep link selects its own category, which the gear then reopens on", async ({ page }) => {
    await openApp(page);
    await gear(page).click();
    await categoryTab(page, "Requests").click();
    await done(page).click();
    await page.getByRole("contentinfo", { name: "Bottom bar" }).getByRole("button", { name: /^History/ }).click();
    await expect(selected(page)).toHaveText("History");
    await done(page).click();
    await gear(page).click();
    await expect(selected(page)).toHaveText("History");
    await expect(panel(page, "History")).toBeVisible();
  });
});

// #241: while Verify server certificates is off, the TLS tab carries a warning mark,
// described in words as well as colour. No other category shows a mark.
const warningMark = (page: Page, name: string) => categoryTab(page, name).getByTestId("warning-mark");

test("the TLS tab shows a warning mark while certificate verification is off, live", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  for (const name of CATEGORIES) await expect(warningMark(page, name)).toHaveCount(0);
  await expect(categoryTab(page, "TLS")).toHaveAccessibleDescription("");

  await categoryTab(page, "TLS").click();
  const verify = panel(page, "TLS").getByRole("switch", { name: "Verify server certificates" });
  await verify.click();
  await expect(warningMark(page, "TLS")).toBeVisible();
  await expect(categoryTab(page, "TLS")).toHaveAccessibleDescription(/certificate verification is off/i);
  // The mark doesn't change the tab's name.
  await expect(rail(page).getByRole("tab")).toHaveText(CATEGORIES);
  for (const name of CATEGORIES.filter((n) => n !== "TLS")) await expect(warningMark(page, name)).toHaveCount(0);
  // It stays while another category is shown.
  await categoryTab(page, "General").click();
  await expect(warningMark(page, "TLS")).toBeVisible();

  await categoryTab(page, "TLS").click();
  await verify.click();
  await expect(warningMark(page, "TLS")).toHaveCount(0);
  await expect(categoryTab(page, "TLS")).toHaveAccessibleDescription("");
});

/** WCAG relative luminance and contrast ratio of two sRGB colours. */
function contrast(a: number[], b: number[]): number {
  const lum = ([r, g, b]: number[]) =>
    [r, g, b].map((c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The mark as drawn: its centre pixel, its pixels, and the tab's background just left of it. */
async function renderedMark(page: Page) {
  const mark = (await warningMark(page, "TLS").boundingBox())!;
  const clip = { x: mark.x - 6, y: mark.y - 2, width: mark.width + 8, height: mark.height + 4 };
  const png = (await page.screenshot({ clip })).toString("base64");
  return page.evaluate(
    async ({ png, w, h }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const scale = img.width / w;
      const canvas = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height });
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const px = (x: number, y: number) => [...ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data.slice(0, 3)];
      const pixels: number[][] = [];
      for (let y = 2; y < h - 2; y += 0.5) for (let x = 6; x < w - 2; x += 0.5) pixels.push(px(x, y));
      return { centre: px(6 + (w - 8) / 2, h / 2), pixels, background: px(2, h / 2) };
    },
    { png, w: clip.width, h: clip.height },
  );
}

/** A theme token as sRGB bytes. */
function tokenRgb(page: Page, name: string): Promise<number[]> {
  return page.evaluate((name) => {
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  }, name);
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme} theme: the TLS warning mark is in the warning colour and stands out from its tab, selected or not`, async ({ page }) => {
    await openApp(page, `?theme=${theme}`);
    await page.keyboard.press("Meta+Comma");
    await categoryTab(page, "TLS").click();
    await panel(page, "TLS").getByRole("switch", { name: "Verify server certificates" }).click();
    const warning = await tokenRgb(page, "--warning");
    for (const shown of ["TLS", "General"]) {
      await categoryTab(page, shown).click();
      await page.mouse.move(0, 0);
      const { centre, pixels, background } = await renderedMark(page);
      centre.forEach((c, i) => expect(Math.abs(c - warning[i])).toBeLessThanOrEqual(2));
      // A non-text mark needs 3:1 against what's around it (WCAG 1.4.11).
      expect(Math.max(...pixels.map((p) => contrast(p, background)))).toBeGreaterThanOrEqual(3);
    }
  });
}
