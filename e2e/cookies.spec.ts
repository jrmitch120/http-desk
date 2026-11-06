// Cookies tab (#69): every cookie the response set, redirect hops included,
// parsed into columns, with click-to-copy values and a count on the tab.
// `?response=cookies` makes the mocked JSON response carry four cookies: one set
// by a redirect hop, one with Expires, one with Max-Age, and one malformed.
import { expect, test, type Page } from "@playwright/test";
import { openApp, openRequest } from "./helpers";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const viewerTabs = (page: Page) => page.getByRole("radiogroup", { name: "Response tabs" });
const cookiesTab = (page: Page) => viewerTabs(page).getByRole("radio", { name: /^Cookies\b/ });
const rows = (page: Page) => page.getByRole("table", { name: "Response cookies" }).locator("tbody tr");

async function sendListPets(page: Page, query = "?response=cookies") {
  await openApp(page, query);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(viewerTabs(page)).toBeVisible();
}

test("the Cookies tab counts the cookies and lists their attributes in columns", async ({ page }) => {
  await sendListPets(page);
  await expect(cookiesTab(page)).toHaveAccessibleName("Cookies 4");
  await expect(cookiesTab(page).locator(".count")).toHaveText("4");
  // Between Headers and Timing.
  await expect(viewerTabs(page).getByRole("radio")).toHaveText([/^Body/, /^Headers/, /^Cookies/, /^Timing/, /^Request/]);

  await cookiesTab(page).click();
  const headers = page.getByRole("table", { name: "Response cookies" }).getByRole("columnheader");
  await expect(headers).toHaveText(["Name", "Value", "Domain", "Path", "Expires", "Secure", "HttpOnly", "SameSite", "Set by"]);
  await expect(rows(page)).toHaveCount(4);

  const cells = (i: number) => rows(page).nth(i).getByRole("cell");
  // Set on the redirect hop, host-only.
  await expect(cells(0)).toHaveText(["session", "abc123", "127.0.0.1", "/", "Session", "Yes", "Yes", "Lax", /\/login\s*Redirect/]);
  await expect(cells(1)).toHaveText(["theme", "dark", "example.com", "", "Tue, 01 Dec 2026 00:00:00 GMT", "", "", "", "http://127.0.0.1:8765/pets?limit=20"]);
  await expect(cells(2).nth(4)).toHaveText("Max-Age 1 h");
  await expect(cells(2).nth(7)).toHaveText("Strict");
});

test("a Set-Cookie that doesn't parse is listed raw with the reason", async ({ page }) => {
  await sendListPets(page);
  await cookiesTab(page).click();
  const row = rows(page).nth(3);
  await expect(row).toContainText("not a cookie");
  await expect(row).toContainText("Could not parse: the cookie is missing a name/value pair");
});

test("clicking a cookie value copies it", async ({ page }) => {
  await sendListPets(page);
  await cookiesTab(page).click();
  await page.getByRole("button", { name: "abc123" }).click();
  await expect(page.getByText("Cookie value copied")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("abc123");
});

test("a response without cookies has no Cookies tab", async ({ page }) => {
  await sendListPets(page, "");
  await expect(viewerTabs(page).getByRole("radio")).toHaveCount(4);
  await expect(cookiesTab(page)).toHaveCount(0);
});
