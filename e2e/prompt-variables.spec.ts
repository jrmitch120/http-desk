// #89: Prompt variables (`# @prompt name [description]`, VS Code REST Client).
// Sending asks once for every unanswered one, and the values are remembered per
// request for the app session only. `?prompts=` makes the mock declare them on
// pets.http's "List pets" (GET {{baseUrl}}/pets?limit=20, `local` selected).
import { expect, test, type Page } from "@playwright/test";
import { dialog, mockState, openApp, openRequest, urlBar } from "./helpers";

const PROMPTS = `?prompts=${encodeURIComponent("baseUrl Where to send it;pass")}`;
const form = (page: Page) => dialog(page, "Values for this request");
const send = (page: Page) => page.getByRole("button", { name: "Send", exact: true }).click();
const sentPrompts = (page: Page) => mockState(page, "sentPrompts");
const preview = (page: Page) => page.getByRole("region", { name: "Resolved request" });

async function answer(page: Page, baseUrl: string, pass: string) {
  await form(page).getByLabel("baseUrl", { exact: true }).fill(baseUrl);
  await form(page).getByLabel("pass", { exact: true }).fill(pass);
  await form(page).getByLabel("pass", { exact: true }).press("Enter");
  await expect(form(page)).toBeHidden();
}

test("sending asks once for all prompts; Cancel doesn't send, and a second send uses the remembered values", async ({ page }) => {
  await openApp(page, PROMPTS);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await expect(urlBar(page).locator(".cm-var-prompt")).toHaveText("{{baseUrl}}");

  await send(page);
  await expect(form(page)).toContainText("Where to send it");
  await expect(form(page).getByLabel("baseUrl", { exact: true })).toBeFocused();
  const pass = form(page).getByLabel("pass", { exact: true });
  await expect(pass).toHaveAttribute("type", "password");
  await form(page).getByRole("button", { name: "Show pass" }).click();
  await expect(pass).toHaveAttribute("type", "text");
  await expect(form(page).getByRole("button", { name: "Hide baseUrl" })).toBeVisible();
  await form(page).getByRole("button", { name: "Cancel" }).click();
  await expect(form(page)).toBeHidden();
  expect(await sentPrompts(page)).toEqual([]);

  await send(page);
  await answer(page, "http://typed.example", "s3cret");
  await expect.poll(() => sentPrompts(page)).toEqual([{ baseUrl: "http://typed.example", pass: "s3cret" }]);
  await expect(urlBar(page).locator(".cm-var-ok")).toHaveText("{{baseUrl}}");

  await send(page);
  await expect.poll(async () => (await sentPrompts(page)).length).toBe(2);
  await expect(form(page)).toHaveCount(0);
  expect((await sentPrompts(page))[1]).toEqual({ baseUrl: "http://typed.example", pass: "s3cret" });
});

test("the resolved preview shows remembered values, and Forget prompted values asks again", async ({ page }) => {
  await openApp(page, PROMPTS);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.getByRole("switch", { name: "Resolved" }).click();
  await expect(preview(page).locator(".target")).toHaveText("GET {{baseUrl}}/pets?limit=20");
  await expect(preview(page).locator(".var.prompt")).toHaveText("{{baseUrl}}");
  await expect(preview(page)).not.toContainText("Unresolved");

  await send(page);
  await answer(page, "http://typed.example", "s3cret");
  await expect(preview(page).locator(".target")).toHaveText("GET http://typed.example/pets?limit=20");
  await preview(page).getByRole("button", { name: "Forget prompted values" }).click();
  await expect(preview(page).locator(".target")).toHaveText("GET {{baseUrl}}/pets?limit=20");

  await send(page);
  await expect(form(page)).toBeVisible();
  await form(page).getByRole("button", { name: "Cancel" }).click();

  // Two `# @prompt` lines are listed with the request's other directives.
  await page.locator(".subtab", { hasText: "Settings" }).click();
  await expect(page.getByText("# @prompt pass", { exact: true })).toBeVisible();
  await expect(page.getByText("# @prompt baseUrl Where to send it", { exact: true })).toBeVisible();
});
