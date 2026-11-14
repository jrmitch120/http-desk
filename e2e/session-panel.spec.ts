// #132: the Session panel shows what the workspace's Session holds, below the
// requests: its Cookies section lists the jar, deletes one cookie or clears them
// all, and Clear session (after a confirmation) forgets everything, prompt
// answers included. ⌘J and View → Show Session open it. `?response=cookies` makes
// List pets' response set three cookies the mock's jar keeps; `__mock.sentCookies`
// is the Cookie header each send got from the jar.
import { expect, test, type Page } from "@playwright/test";
import { dialog, menuClick, mockState, openApp, openRequest, setMockResponse, tab } from "./helpers";

const panel = (page: Page) => page.getByRole("region", { name: "Session" });
const rows = (page: Page) => panel(page).getByRole("table", { name: "Session cookies" }).locator("tbody tr");
const send = (page: Page) => page.getByRole("button", { name: "Send", exact: true }).click();
const sentCookies = (page: Page) => mockState(page, "sentCookies");

async function sendListPets(page: Page) {
  const before = (await sentCookies(page)).length;
  await send(page);
  await expect.poll(async () => (await sentCookies(page)).length).toBe(before + 1);
}

test("after a send that sets cookies, the open panel lists them with their attributes, without a refresh", async ({ page }) => {
  await openApp(page, "?response=cookies");
  await page.keyboard.press("Meta+j");
  await expect(panel(page)).toContainText("No cookies");
  await openRequest(page, ["api", "pets.http"], "List pets");

  await send(page);

  await expect(rows(page)).toHaveCount(3);
  const headers = panel(page).getByRole("columnheader");
  await expect(headers).toHaveText(["Name", "Value", "Domain", "Path", "Expires", "Secure", "HttpOnly", "SameSite", ""]);
  const cells = (i: number) => rows(page).nth(i).getByRole("cell");
  // By domain, then path, then name; the Set-Cookie that didn't parse isn't kept.
  await expect(cells(0)).toHaveText(["session", "abc123", "127.0.0.1", "/", "Session", "Yes", "Yes", "Lax", ""]);
  await expect(cells(1).first()).toHaveText("visits");
  await expect(cells(2)).toHaveText(["theme", "dark", "example.com", "/", "Tue, 01 Dec 2026 00:00:00 GMT", "", "", "", ""]);
  await expect(panel(page).getByRole("heading", { name: /^Cookies/ })).toContainText("3");

  await page.keyboard.press("Meta+j");
  await expect(panel(page)).toBeHidden();
});

test("hiding the panel from its own button hands focus to the active tab", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await menuClick(page, "toggle-session");

  await page.getByRole("button", { name: /^Hide panel/ }).click();

  await expect(panel(page)).toBeHidden();
  await expect(tab(page, "List pets")).toBeFocused();
});

test("a deleted cookie isn't sent on the next request, and Clear cookies stops all of them", async ({ page }) => {
  await openApp(page, "?response=cookies");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await sendListPets(page);
  await menuClick(page, "toggle-session");
  await expect(rows(page)).toHaveCount(3);

  await panel(page).getByRole("button", { name: "Delete cookie theme" }).click();

  await expect(rows(page)).toHaveCount(2);
  await setMockResponse(page, null);
  await sendListPets(page);
  expect((await sentCookies(page)).at(-1)).toBe("session=abc123; visits=3");

  await panel(page).getByRole("button", { name: "Clear cookies" }).click();
  await expect(rows(page)).toHaveCount(0);
  await expect(panel(page)).toContainText("No cookies");
  await sendListPets(page);
  expect((await sentCookies(page)).at(-1)).toBe("");
});

test("Clear session asks first, then forgets the cookies and the prompt answers", async ({ page }) => {
  await openApp(page, `?response=cookies&prompts=${encodeURIComponent("otp One-time code")}`);
  await openRequest(page, ["api", "pets.http"], "List pets");
  const form = dialog(page, 'Value for "otp"');
  await send(page);
  await form.getByLabel("otp", { exact: true }).fill("123456");
  await form.getByLabel("otp", { exact: true }).press("Enter");
  await expect.poll(() => mockState(page, "sentPrompts")).toEqual([{ otp: "123456" }]);
  await page.keyboard.press("Meta+j");
  await expect(rows(page)).toHaveCount(3);

  await panel(page).getByRole("button", { name: "Clear session" }).click();
  const confirm = dialog(page, "Clear the session?");
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(rows(page)).toHaveCount(3);

  await panel(page).getByRole("button", { name: "Clear session" }).click();
  await confirm.getByRole("button", { name: "Clear session" }).click();

  await expect(panel(page)).toContainText("No cookies");
  await send(page);
  await expect(form).toBeVisible();
});
