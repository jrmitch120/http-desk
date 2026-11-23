// #132: the Session panel shows what the workspace's Session holds, below the
// requests: its Cookies section lists the jar, deletes one cookie or clears them
// all, and Clear session (after a confirmation) forgets everything, prompt
// answers included. ⌘J and View → Show Session open it. `?response=cookies` makes
// List pets' response set three cookies the mock's jar keeps; `__mock.sentCookies`
// is the Cookie header each send got from the jar.
import { expect, test, type Page } from "@playwright/test";
import { clipboard, dialog, menuClick, mockState, openApp, openRequest, setMockResponse, tab, urlBar } from "./helpers";

const panel = (page: Page) => page.getByRole("region", { name: "Session" });
const rows = (page: Page) => panel(page).getByRole("list", { name: "Session cookies" }).getByRole("listitem");
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
  // The column headings are for the eye: each row reads as a list item (#194).
  const headers = panel(page).locator("thead th");
  await expect(headers).toHaveText(["Name", "Value", "Domain", "Path", "Expires", "Secure", "HttpOnly", "SameSite", ""]);
  const cells = (i: number) => rows(page).nth(i).locator("td");
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

test("Clear session takes the test markers off the tab and the tree row (#138)", async ({ page }) => {
  // `?trusted=1`: the demo workspace runs the sample handler, whose test fails on the mock's 201.
  await openApp(page, "?trusted=1");
  await openRequest(page, ["samples", "jetbrains.http"], "Post with JSON body");
  await send(page);
  const marker = page.getByTestId("req-Post with JSON body").getByRole("img", { name: /^Tests/ });
  await expect(marker).toBeVisible();
  await expect(tab(page, "Post with JSON body").getByRole("img", { name: /^Tests/ })).toBeVisible();

  await page.keyboard.press("Meta+j");
  await panel(page).getByRole("button", { name: "Clear session" }).click();
  await dialog(page, "Clear the session?").getByRole("button", { name: "Clear session" }).click();

  await expect(marker).toHaveCount(0);
  await expect(tab(page, "Post with JSON body").getByRole("img", { name: /^Tests/ })).toHaveCount(0);
});

// #139: `?globals=1` has List pets' handler store the Global variable `loginToken`, and
// samples/jetbrains.http's "Get request with a header" (another file) use `{{loginToken}}`.
const globalRows = (page: Page) => panel(page).getByRole("list", { name: "Global variables" }).getByRole("listitem");
const tokenMark = (page: Page, state: "ok" | "bad") => urlBar(page).locator(`.cm-var-${state}`, { hasText: "{{loginToken}}" });
const undefinedCheck = (page: Page) => page.getByText("is undefined, used in");

test("a Global variable a handler stores is listed at once, defines {{loginToken}} in another file, and can be deleted or cleared", async ({ page }) => {
  await openApp(page, "?globals=1&trusted=1");
  await page.keyboard.press("Meta+j");
  await expect(panel(page)).toContainText("No Global variables");
  await openRequest(page, ["samples", "jetbrains.http"], "Get request with a header");
  await expect(tokenMark(page, "bad")).toBeVisible();
  await expect(undefinedCheck(page)).toBeVisible();

  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);

  await expect(globalRows(page)).toHaveCount(1);
  await expect(globalRows(page).first().locator("td")).toHaveText(["loginToken", "abc123", ""]);
  await expect(panel(page).getByRole("heading", { name: /^Global variables/ })).toContainText("1");
  await tab(page, "Get request with a header").click();
  await expect(tokenMark(page, "ok")).toBeVisible();
  await expect(undefinedCheck(page)).toHaveCount(0);

  await panel(page).getByRole("button", { name: "Delete Global variable loginToken" }).click();
  await expect(globalRows(page)).toHaveCount(0);
  await expect(tokenMark(page, "bad")).toBeVisible();

  await tab(page, "List pets").click();
  await send(page);
  await expect(globalRows(page)).toHaveCount(1);
  await panel(page).getByRole("button", { name: "Clear Global variables" }).click();
  await expect(globalRows(page)).toHaveCount(0);
  await expect(panel(page)).toContainText("No Global variables");
});

test("Clear session clears the Global variables, and another workspace starts with none", async ({ page }) => {
  await openApp(page, "?globals=1&trusted=1&recent=/work/shop");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+j");
  await send(page);
  await expect(globalRows(page)).toHaveCount(1);

  await panel(page).getByRole("button", { name: "Clear session" }).click();
  const confirm = dialog(page, "Clear the session?");
  await expect(confirm).toContainText("Global variables");
  await confirm.getByRole("button", { name: "Clear session" }).click();
  await expect(panel(page)).toContainText("No Global variables");

  await send(page);
  await expect(globalRows(page)).toHaveCount(1);
  // The mock opens the demo workspace again, as a new one with a new Session.
  await menuClick(page, "open-recent:/work/shop");
  await expect.poll(() => mockState(page, "settings").then((s) => s.recentWorkspaces[0])).toBe("/work/shop");
  await expect(panel(page)).toContainText("No Global variables");
});

// #194: the Session panel is one list of rows across its sections, in order: Named
// exchanges, Global variables, Cookies. With `?chain=1&globals=1&trusted=1&response=cookies`,
// sending Create pet keeps the exchange `createPet`, and sending List pets the Global
// variable `loginToken`; both responses set the cookies session, visits and theme.
const sessionRow = (page: Page, name: string) => panel(page).getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) });
const clearButton = (page: Page, name: string) => panel(page).getByRole("button", { name });

async function fillSession(page: Page) {
  await openApp(page, "?chain=1&globals=1&trusted=1&response=cookies");
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await send(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await menuClick(page, "toggle-session");
  await expect(panel(page).getByRole("listitem")).toHaveCount(5);
}

test("the Session's rows are one Tab stop, and Up/Down/Home/End move across its sections", async ({ page }) => {
  await fillSession(page);

  await clearButton(page, "Clear named exchanges").focus();
  await page.keyboard.press("Tab");
  await expect(sessionRow(page, "createPet")).toBeFocused();
  for (const name of ["loginToken", "session", "visits", "theme", "theme"]) {
    await page.keyboard.press("ArrowDown");
    await expect(sessionRow(page, name)).toBeFocused();
  }
  await page.keyboard.press("Home");
  await expect(sessionRow(page, "createPet")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(sessionRow(page, "createPet")).toBeFocused();
  await page.keyboard.press("End");
  await expect(sessionRow(page, "theme")).toBeFocused();

  // The headings' Clear buttons stay in the Tab order; the rows' own buttons don't.
  await page.keyboard.press("Shift+Tab");
  await expect(clearButton(page, "Clear cookies")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(clearButton(page, "Clear Global variables")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(clearButton(page, "Clear named exchanges")).toBeFocused();
  for (const name of ["Clear Global variables", "Clear cookies"]) {
    await page.keyboard.press("Tab");
    await expect(clearButton(page, name)).toBeFocused();
  }
  await page.keyboard.press("Tab");
  await expect(sessionRow(page, "theme")).toBeFocused();
});

test("a row clicked shows no focus ring; the row an arrow key moves to does", async ({ page }) => {
  await fillSession(page);
  const ring = (name: string) => sessionRow(page, name).evaluate((el) => getComputedStyle(el).outlineStyle);

  await sessionRow(page, "createPet").locator("td").first().click();
  await expect(sessionRow(page, "createPet")).toBeFocused();
  expect(await ring("createPet")).toBe("none");
  await page.keyboard.press("ArrowDown");
  await expect(sessionRow(page, "loginToken")).toBeFocused();
  await expect.poll(() => ring("loginToken")).not.toBe("none");
});

test("Enter on a named exchange opens it; on a Global variable or a cookie it copies the value", async ({ page }) => {
  await fillSession(page);
  const toast = (text: string) => page.locator(".toast", { hasText: text });

  await sessionRow(page, "loginToken").focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => clipboard(page)).toBe("abc123");
  await expect(toast("Global variable value copied")).toBeVisible();

  await sessionRow(page, "theme").focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => clipboard(page)).toBe("dark");
  await expect(toast("Cookie value copied")).toBeVisible();

  await sessionRow(page, "createPet").focus();
  await page.keyboard.press("Enter");
  const shown = page.getByRole("dialog", { name: "createPet" });
  await expect(shown).toContainText("201 Created");
  await expect(shown).toContainText("api/pets.http");
});

test("Delete removes the focused row, and focus goes to the next row, else the one before, else the list", async ({ page }) => {
  await fillSession(page);
  const names = panel(page).getByRole("listitem").locator("td:first-child");

  // The only Global variable: the next row is the first cookie.
  await sessionRow(page, "loginToken").focus();
  await page.keyboard.press("Delete");
  await expect(names).toHaveText(["createPet", "session", "visits", "theme"]);
  await expect(panel(page)).toContainText("No Global variables");
  await expect(sessionRow(page, "session")).toBeFocused();

  // The last row: the one before it.
  await page.keyboard.press("End");
  await page.keyboard.press("Delete");
  await expect(names).toHaveText(["createPet", "session", "visits"]);
  await expect(sessionRow(page, "visits")).toBeFocused();

  // Backspace forgets a named exchange.
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace");
  await expect(names).toHaveText(["session", "visits"]);
  await expect(panel(page)).toContainText("No named exchanges");
  await expect(sessionRow(page, "session")).toBeFocused();

  // The last row of all: focus stays in the panel, on the (empty) list.
  await page.keyboard.press("Delete");
  await expect(sessionRow(page, "visits")).toBeFocused();
  await page.keyboard.press("Delete");
  await expect(panel(page)).toContainText("No cookies");
  await expect(panel(page).locator(":focus")).toHaveCount(1);
  await expect(panel(page).getByRole("button").and(page.locator(":focus"))).toHaveCount(0);
  // And the cookies are gone from the Session, not just the panel.
  await openRequest(page, ["api", "pets.http"], "List pets");
  await setMockResponse(page, null);
  await sendListPets(page);
  expect((await sentCookies(page)).at(-1)).toBe("");
});

test("Shift+F10 opens a row's menu with the actions that apply to it", async ({ page }) => {
  await fillSession(page);
  const items = page.getByRole("menu").getByRole("menuitem");

  await sessionRow(page, "createPet").focus();
  await page.keyboard.press("Shift+F10");
  await expect(items).toHaveText(["Open", "Forget"]);
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sessionRow(page, "createPet")).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+F10");
  await expect(items).toHaveText(["Copy value", "Delete"]);
  await page.keyboard.press("Enter");
  await expect.poll(() => clipboard(page)).toBe("abc123");

  // Delete from the menu moves focus on as the key does.
  await page.keyboard.press("ArrowDown");
  await expect(sessionRow(page, "session")).toBeFocused();
  await page.keyboard.press("Shift+F10");
  await expect(items).toHaveText(["Copy value", "Delete"]);
  await items.filter({ hasText: "Delete" }).click();
  await expect(sessionRow(page, "session")).toHaveCount(0);
  await expect(sessionRow(page, "visits")).toBeFocused();

  // Open, from the named exchange's menu.
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+F10");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "createPet" })).toContainText("201 Created");
});
