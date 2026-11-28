import { expect, test, type Page } from "@playwright/test";
import { dialog, menuClick, mockState, openApp, setClipboard, setFilePick, showSettingsPage } from "./helpers";

/** Opens Settings on `category`. */
async function openSettings(page: Page, category = "General") {
  await page.keyboard.press("Meta+Comma");
  await showSettingsPage(page, category);
  return dialog(page, "Settings");
}

/** The settings the mocked backend last saved. */
async function savedSettings(page: Page) {
  return mockState(page, "settings");
}

test("toggling Follow redirects applies at once and is still applied after reopening Settings", async ({ page }) => {
  await openApp(page);
  let settings = await openSettings(page, "Requests");
  const follow = () => settings.locator(".setting", { hasText: "Follow redirects" }).getByRole("switch");
  await expect(follow()).toHaveAttribute("aria-checked", "true");

  await follow().click();
  await expect(follow()).toHaveAttribute("aria-checked", "false");
  await expect.poll(async () => (await savedSettings(page)).exec.followRedirects).toBe(false);

  await settings.getByRole("button", { name: "Done" }).click();
  await expect(settings).toHaveCount(0);
  settings = await openSettings(page, "Requests");
  await expect(follow()).toHaveAttribute("aria-checked", "false");
});

test("the idle timeout takes only digits and one decimal point; anything else typed or pasted is dropped", async ({ page }) => {
  // Linux, where the Edit menu's Paste is the app's own command (as a paste lands in a field).
  await openApp(page, "?platform=linux");
  await page.getByRole("banner").getByRole("button", { name: "Settings" }).click();
  const settings = await showSettingsPage(page, "Requests");
  const idle = settings.getByRole("textbox", { name: "Idle timeout" });

  await idle.selectText();
  await idle.pressSequentially("1a.5s.2");
  await expect(idle).toHaveValue("1.52");
  // A paste is cleaned the same way, and the caret stays after what was inserted.
  await idle.fill("");
  await setClipboard(page, "4x5");
  await menuClick(page, "paste");
  await expect(idle).toHaveValue("45");
  await idle.pressSequentially("0");
  await expect(idle).toHaveValue("450");
  await expect(settings.getByRole("alert")).toHaveCount(0);
});

test("leaving the idle timeout empty puts back the last value and saves nothing, on blur or Enter", async ({ page }) => {
  await openApp(page);
  const settings = await openSettings(page, "Requests");
  const idle = settings.getByRole("textbox", { name: "Idle timeout" });
  await expect(idle).toHaveValue("30");

  await idle.fill("");
  await idle.press("Enter");
  await expect(idle).toHaveValue("30");
  await idle.fill("");
  await idle.blur();
  await expect(idle).toHaveValue("30");
  await expect(idle).not.toHaveAttribute("aria-invalid", "true");
  await expect(settings.getByRole("alert")).toHaveCount(0);
  expect((await savedSettings(page)).exec.timeoutMs).toBe(30000);
});

test("typing a new idle timeout saves it on Enter, not per keystroke", async ({ page }) => {
  await openApp(page);
  const settings = await openSettings(page, "Requests");
  const idle = settings.getByRole("textbox", { name: "Idle timeout" });

  await idle.fill("45");
  expect((await savedSettings(page)).exec.timeoutMs).toBe(30000);
  await idle.press("Enter");
  await expect.poll(async () => (await savedSettings(page)).exec.timeoutMs).toBe(45000);
  await expect(idle).toBeFocused();
  await expect(idle).toHaveValue("45");
  await expect(settings).toBeVisible();
});

test("a maximum body size takes only digits, and below 1 MB puts back the last value", async ({ page }) => {
  await openApp(page);
  const settings = await openSettings(page, "Requests");
  const size = settings.getByRole("textbox", { name: "Maximum body size" });
  await expect(size).toHaveValue("100");

  // A whole-number field drops the decimal point too.
  await size.selectText();
  await size.pressSequentially("2.5");
  await expect(size).toHaveValue("25");
  await size.fill("0");
  await size.blur();
  await expect(size).toHaveValue("100");
  await expect(settings.getByRole("alert")).toHaveCount(0);
  await size.fill("8");
  await settings.getByRole("button", { name: "Done" }).click();
  await expect.poll(async () => (await savedSettings(page)).exec.maxBodyBytes).toBe(8 * 1024 * 1024);
});

test("a certificate path is set only with Browse…, shown read-only, and removed with Clear", async ({ page }) => {
  await openApp(page);
  const settings = await openSettings(page, "TLS");
  const ca = settings.getByRole("textbox", { name: "CA certificate" });
  await expect(ca).toHaveValue("");
  await expect(ca).toHaveAttribute("readonly", "");

  // Typing does nothing: the path can't be mistyped.
  await ca.click();
  await page.keyboard.type("asdasd");
  await expect(ca).toHaveValue("");

  // Cancelling the picker changes nothing.
  await settings.getByRole("button", { name: "Browse for CA certificate" }).click();
  expect((await savedSettings(page)).exec.caCertPath).toBeNull();

  // Setting a path shows Clear in a slot kept for it: the field and Browse… don't move.
  const browse = settings.getByRole("button", { name: "Browse for CA certificate" });
  const before = [await ca.boundingBox(), await browse.boundingBox()];
  await setFilePick(page, "/certs/ca.pem");
  await browse.click();
  await expect.poll(async () => (await savedSettings(page)).exec.caCertPath).toBe("/certs/ca.pem");
  await expect(ca).toHaveValue("/certs/ca.pem");
  await expect(settings.getByRole("button", { name: "Clear CA certificate" })).toBeVisible();
  expect([await ca.boundingBox(), await browse.boundingBox()]).toEqual(before);
  // Clear sits inside the field's box, at its end; Browse… ends on the page's edge, with the switch.
  const field = (await ca.boundingBox())!;
  const clear = (await settings.getByRole("button", { name: "Clear CA certificate" }).boundingBox())!;
  expect(clear.x).toBeGreaterThan(field.x);
  expect(clear.x + clear.width).toBeLessThanOrEqual(field.x + field.width);
  const toggle = (await settings.getByRole("switch", { name: "Verify server certificates" }).boundingBox())!;
  const b = (await browse.boundingBox())!;
  expect(Math.round(b.x + b.width)).toBe(Math.round(toggle.x + toggle.width));

  await settings.getByRole("button", { name: "Clear CA certificate" }).click();
  await expect.poll(async () => (await savedSettings(page)).exec.caCertPath).toBeNull();
  await expect(ca).toHaveValue("");
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
      const settings = await openSettings(page, "Requests");
      await settings.getByRole("textbox", { name: "Idle timeout" }).fill("45");
      await close(page);
      await expect(settings).toHaveCount(0);
      await expect.poll(async () => (await savedSettings(page)).exec.timeoutMs).toBe(45000);
    });
  }
});

test("the Settings footer has only a Done button", async ({ page }) => {
  await openApp(page);
  const settings = await openSettings(page);
  await expect(settings.locator("footer").getByRole("button")).toHaveText(["Done"]);
});
