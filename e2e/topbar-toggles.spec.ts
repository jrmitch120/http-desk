// #211: pressed toggles look quiet, not accent: accent is kept for what needs
// attention, and active icon buttons elsewhere keep their accent look. The topbar's
// sidebar toggle is gone (#218): the sidebar collapses from its own header to a rail
// (sidebar-rail.spec.ts), whose marked view follows the same rule: the text colour,
// the other view muted. (Problems, in the bottom bar, follows it too:
// bottom-bar.spec.ts.)
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openApp, openRequest } from "./helpers";

const railButton = (page: Page, name: string) => page.getByRole("navigation", { name: "Sidebar" }).getByRole("button", { name, exact: true });

/** A theme token (`--text`) as a computed colour, comparable with an element's computed colour. */
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

/** The button's icon colour and background, as computed. */
function look(button: Locator): Promise<{ color: string; background: string }> {
  return button.evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.color, background: s.backgroundColor };
  });
}

for (const theme of ["dark", "light"] as const) {
  test.describe(`${theme} theme`, () => {
    test("the rail marks its last-used view quietly: the text colour, never accent", async ({ page }) => {
      await openApp(page, `?theme=${theme}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.keyboard.press("Meta+B");
      await page.mouse.move(600, 400);
      const [text, muted, accent] = [await token(page, "--text"), await token(page, "--muted"), await token(page, "--accent")];
      const marked = railButton(page, "Explorer");
      await expect(marked).toHaveAttribute("aria-current", "true");
      await expect.poll(async () => (await look(marked)).color).toBe(text);
      expect(text).not.toBe(accent);
      await expect.poll(async () => (await look(railButton(page, "History"))).color).toBe(muted);
    });

    test("an active icon button outside the topbar still uses the accent colour", async ({ page }) => {
      await openApp(page, `?theme=${theme}`);
      await openRequest(page, ["api", "pets.http"], "List pets");
      await page.keyboard.press("Meta+Enter");
      const wrap = page.getByRole("button", { name: "Wrap lines" });
      await wrap.click();
      await page.mouse.move(0, 400);
      await expect(wrap).toHaveAttribute("aria-pressed", "true");
      await expect.poll(async () => (await look(wrap)).color).toBe(await token(page, "--accent"));
    });
  });
}
