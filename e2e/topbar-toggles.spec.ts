// #211: pressed toggles in the topbar look quiet, not accent. Pressed (sidebar shown,
// Problems panel open): the hover background and the text colour. Unpressed: no
// background and a muted icon. Accent is kept for what needs attention, and active
// icon buttons outside the topbar keep their accent look.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openApp, openRequest } from "./helpers";

const sidebarToggle = (page: Page) => page.getByRole("button", { name: "Show sidebar", exact: true });
const problemsToggle = (page: Page) => page.getByRole("button", { name: /^Show Problems/ });

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

async function expectPressed(page: Page, button: Locator) {
  await expect(button).toHaveAttribute("aria-pressed", "true");
  const [text, hover, accent] = [await token(page, "--text"), await token(page, "--hover"), await token(page, "--accent")];
  await expect.poll(() => look(button)).toEqual({ color: text, background: hover });
  expect(text).not.toBe(accent);
}

async function expectUnpressed(page: Page, button: Locator) {
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => look(button)).toEqual({ color: await token(page, "--muted"), background: "rgba(0, 0, 0, 0)" });
}

for (const theme of ["dark", "light"] as const) {
  test.describe(`${theme} theme`, () => {
    test("the sidebar toggle is quietly pressed while the sidebar is shown, and plain while it's hidden", async ({ page }) => {
      await openApp(page, `?theme=${theme}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expectPressed(page, sidebarToggle(page));

      await sidebarToggle(page).click();
      await page.mouse.move(0, 400);
      await expectUnpressed(page, sidebarToggle(page));

      await sidebarToggle(page).click();
      await page.mouse.move(0, 400);
      await expectPressed(page, sidebarToggle(page));
    });

    test("the Problems toggle follows the same rule while its panel is open or closed", async ({ page }) => {
      await openApp(page, `?theme=${theme}`);
      await expectUnpressed(page, problemsToggle(page));

      await problemsToggle(page).click();
      await page.mouse.move(0, 400);
      await expect(page.getByRole("region", { name: "Problems" })).toBeVisible();
      await expectPressed(page, problemsToggle(page));

      await page.getByRole("button", { name: /^Hide panel/ }).click();
      await page.mouse.move(0, 400);
      await expectUnpressed(page, problemsToggle(page));
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
