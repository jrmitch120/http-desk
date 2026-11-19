// Parse problems (#165): what the core can't read cleanly in a request's source is
// underlined there, with its message on hover, and listed in the check strip; so is
// a body file that doesn't exist, which the shell (here the mock, from its own
// files) is asked about. Neither blocks the send.
import { expect, test, type Page } from "@playwright/test";
import { bodyEditor, openApp, openRequest, sentRequests, urlBar } from "./helpers";

const strip = (page: Page) => page.getByRole("region", { name: "Pre-send checks" });
const toggleSource = (page: Page) => page.getByRole("button", { name: ".http", exact: true }).click();
const source = (page: Page) => page.locator(".source-code");

async function retypeUrl(page: Page, text: string) {
  await urlBar(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text);
}

test("a broken request line is underlined in the source, with its message on hover, and listed in the strip", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await toggleSource(page);
  await expect(source(page)).toContainText("POST {{baseUrl}}/pets");
  await expect(strip(page)).toHaveCount(0);

  // A space in the URL: the request line no longer reads as method, URL and version.
  await retypeUrl(page, "{{baseUrl}}/pets two");
  const underline = source(page).locator(".cm-underline-error");
  await expect(underline).toHaveText("POST {{baseUrl}}/pets two");
  await expect(strip(page).getByRole("listitem")).toHaveText([/Line 2\s*Can't read this request line/]);

  // Off the URL bar, so its own hover card can't cover the source.
  await page.mouse.move(0, 0);
  await underline.getByText("two").hover();
  await expect(page.locator(".cm-underline-tip")).toContainText("Can't read this request line");

  // Sending isn't blocked.
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(async () => (await sentRequests(page)).length).toBe(1);

  // Fixed: both go away.
  await retypeUrl(page, "{{baseUrl}}/pets");
  await expect(strip(page)).toHaveCount(0);
  await expect(source(page).locator(".cm-underline")).toHaveCount(0);
});

test("a body read from a file that doesn't exist is flagged before sending, and underlined in the source", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await page.locator(".subtab", { hasText: "Body" }).click();
  await bodyEditor(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("< ./payload.json");

  await expect(strip(page).getByRole("listitem")).toHaveText([/Line 5\s*\.\/payload\.json doesn't exist/]);
  await toggleSource(page);
  await expect(source(page).locator(".cm-underline-error")).toHaveText("< ./payload.json");
});

test("a body file the workspace has isn't flagged", async ({ page }) => {
  await openApp(page);
  // Its multipart part reads ./request-form-data.json, which the mock has next to it.
  await openRequest(page, ["samples", "jetbrains.http"], "Send a form with the text and file fields");
  await toggleSource(page);
  await expect(source(page)).toContainText("< ./request-form-data.json");
  // Give the shell's answers time to arrive; nothing is flagged.
  await page.waitForTimeout(500);
  await expect(strip(page)).toHaveCount(0);
  await expect(source(page).locator(".cm-underline")).toHaveCount(0);
});
