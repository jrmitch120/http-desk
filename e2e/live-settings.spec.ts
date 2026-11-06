import { expect, test, type Page } from "@playwright/test";
import { dialog, openApp } from "./helpers";

async function openSettings(page: Page) {
  await page.keyboard.press("ControlOrMeta+Comma");
  return dialog(page, "Settings");
}

/** The settings the mocked backend last saved. */
async function savedSettings(page: Page) {
  return page.evaluate(() => (window as unknown as { __mock: { settings: { exec: Record<string, unknown> } } }).__mock.settings);
}

test("toggling Follow redirects applies at once and is still applied after reopening Settings", async ({ page }) => {
  await openApp(page);
  let settings = await openSettings(page);
  const follow = () => settings.locator(".setting", { hasText: "Follow redirects" }).getByRole("switch");
  await expect(follow()).toHaveAttribute("aria-checked", "true");

  await follow().click();
  await expect(follow()).toHaveAttribute("aria-checked", "false");
  await expect.poll(async () => (await savedSettings(page)).exec.followRedirects).toBe(false);

  await settings.getByRole("button", { name: "Done" }).click();
  await expect(settings).toHaveCount(0);
  settings = await openSettings(page);
  await expect(follow()).toHaveAttribute("aria-checked", "false");
});

test("clearing the idle timeout shows an error and saves nothing; leaving the field restores it", async ({ page }) => {
  await openApp(page);
  const settings = await openSettings(page);
  const idle = settings.getByRole("textbox", { name: "Idle timeout" });
  await expect(idle).toHaveValue("30");

  await idle.fill("");
  await expect(idle).toHaveAttribute("aria-invalid", "true");
  await expect(settings.getByRole("alert")).toHaveText("Enter a number");
  await idle.press("Enter");
  await expect(settings.getByRole("alert")).toHaveText("Enter a number");

  await idle.fill("soon");
  await expect(settings.getByRole("alert")).toHaveText("Enter a number");

  await idle.blur();
  await expect(idle).toHaveValue("30");
  await expect(idle).not.toHaveAttribute("aria-invalid", "true");
  await expect(settings.getByRole("alert")).toHaveCount(0);
  expect((await savedSettings(page)).exec.timeoutMs).toBe(30000);
});

test("typing a new idle timeout saves it on Enter, not per keystroke", async ({ page }) => {
  await openApp(page);
  const settings = await openSettings(page);
  const idle = settings.getByRole("textbox", { name: "Idle timeout" });

  await idle.fill("45");
  expect((await savedSettings(page)).exec.timeoutMs).toBe(30000);
  await idle.press("Enter");
  await expect.poll(async () => (await savedSettings(page)).exec.timeoutMs).toBe(45000);
  await expect(idle).toBeFocused();
  await expect(idle).toHaveValue("45");
  await expect(settings).toBeVisible();
});

test("a maximum body size has to be a whole number of at least 1 MB", async ({ page }) => {
  await openApp(page);
  const settings = await openSettings(page);
  const size = settings.getByRole("textbox", { name: "Maximum body size" });
  await expect(size).toHaveValue("100");

  await size.fill("0");
  await expect(settings.getByRole("alert")).toHaveText("Must be at least 1");
  await size.fill("2.5");
  await expect(settings.getByRole("alert")).toHaveText("Enter a whole number");
  await size.fill("8");
  await expect(settings.getByRole("alert")).toHaveCount(0);
  await settings.getByRole("button", { name: "Done" }).click();
  await expect.poll(async () => (await savedSettings(page)).exec.maxBodyBytes).toBe(8 * 1024 * 1024);
});

test("a certificate path applies on Enter and on Clear, not per keystroke", async ({ page }) => {
  await openApp(page);
  const settings = await openSettings(page);
  const ca = settings.locator(".setting", { hasText: "CA certificate" });

  await ca.getByRole("textbox").fill("/certs/ca.pem");
  expect((await savedSettings(page)).exec.caCertPath).toBeNull();
  await ca.getByRole("textbox").press("Enter");
  await expect.poll(async () => (await savedSettings(page)).exec.caCertPath).toBe("/certs/ca.pem");

  await ca.getByRole("button", { name: "Clear" }).click();
  await expect.poll(async () => (await savedSettings(page)).exec.caCertPath).toBeNull();
  await expect(ca.getByRole("textbox")).toHaveValue("");
});

/**
 * Makes Chromium behave like WebKit, which fires no blur when the focused
 * element is removed from the page: blur and focusout events dispatched while
 * a node is being removed never reach their listeners.
 */
async function noBlurOnRemoval(page: Page) {
  await page.addInitScript(() => {
    let removing = 0;
    const wrap = <T extends object>(proto: T, name: keyof T) => {
      const original = proto[name] as (...args: unknown[]) => unknown;
      Object.defineProperty(proto, name, {
        configurable: true,
        writable: true,
        value(this: unknown, ...args: unknown[]) {
          removing++;
          try {
            return original.apply(this, args);
          } finally {
            removing--;
          }
        },
      });
    };
    wrap(Element.prototype, "remove");
    wrap(CharacterData.prototype, "remove");
    wrap(Node.prototype, "removeChild");
    wrap(Element.prototype, "replaceChildren");
    for (const type of ["blur", "focusout"]) {
      window.addEventListener(type, (e) => removing && e.stopImmediatePropagation(), true);
    }
  });
}

// Closing removes the focused field, and WebKit fires no blur for a removed
// element, so the modal has to commit the edit itself before it goes.
const closers: { how: string; close: (page: Page) => Promise<void> }[] = [
  { how: "Escape", close: (page) => page.keyboard.press("Escape") },
  { how: "a click on the backdrop", close: (page) => page.mouse.click(4, 4) },
];
test.describe("without a blur on removal (as in WebKit)", () => {
  test.beforeEach(({ page }) => noBlurOnRemoval(page));

  for (const { how, close } of closers) {
    test(`closing Settings with ${how} applies the number being typed`, async ({ page }) => {
      await openApp(page);
      const settings = await openSettings(page);
      await settings.getByRole("textbox", { name: "Idle timeout" }).fill("45");
      await close(page);
      await expect(settings).toHaveCount(0);
      await expect.poll(async () => (await savedSettings(page)).exec.timeoutMs).toBe(45000);
    });

    test(`closing Settings with ${how} applies the certificate path being typed`, async ({ page }) => {
      await openApp(page);
      const settings = await openSettings(page);
      await settings.locator(".setting", { hasText: "CA certificate" }).getByRole("textbox").fill("/certs/ca.pem");
      await close(page);
      await expect(settings).toHaveCount(0);
      await expect.poll(async () => (await savedSettings(page)).exec.caCertPath).toBe("/certs/ca.pem");
    });
  }
});

test("the Settings footer has only a Done button", async ({ page }) => {
  await openApp(page);
  const settings = await openSettings(page);
  await expect(settings.locator("footer").getByRole("button")).toHaveText(["Done"]);
});
