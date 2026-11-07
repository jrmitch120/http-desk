// The resolved preview under the URL bar (#77): the request as it will be sent,
// with the active environment and File variables applied, without sending.
// The mocked workspace `/demo` starts on `local` (baseUrl http://127.0.0.1:8765,
// Secret token dev-token-123); "List pets" is GET {{baseUrl}}/pets?limit=20 with
// Bearer {{token}} and an Accept header.
import { expect, type Page } from "@playwright/test";
import { test } from "@playwright/test";
import { mockState, openApp, openRequest, sentRequests, urlBar } from "./helpers";

const toggle = (page: Page) => page.getByRole("switch", { name: "Resolved" });
const preview = (page: Page) => page.getByRole("region", { name: "Resolved request" });
const lines = (page: Page, section: string) => preview(page).getByRole("group", { name: section }).locator(".line");

test("the Resolved toggle shows the final URL and headers without sending, and is remembered", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
  await expect(preview(page)).toHaveCount(0);

  await toggle(page).click();
  await expect(preview(page).locator(".target")).toHaveText("GET http://127.0.0.1:8765/pets?limit=20");
  // The Secret token is masked, like in a hover card, until revealed.
  await expect(lines(page, "Headers")).toHaveText([
    "Authorization: Bearer ••••••••",
    "Accept: application/json",
    /^User-Agent: HttpDesk\//,
    "Accept-Encoding: gzip, deflate, br, zstd",
  ]);
  await expect(lines(page, "Authorization")).toHaveText(["Token: ••••••••"]);
  await expect(preview(page)).not.toContainText("dev-token-123");
  await preview(page).getByRole("button", { name: "Reveal Secrets" }).click();
  await expect(lines(page, "Headers").first()).toHaveText("Authorization: Bearer dev-token-123");
  await expect(lines(page, "Authorization")).toHaveText(["Token: dev-token-123"]);
  await preview(page).getByRole("button", { name: "Hide Secrets" }).click();
  await expect(preview(page)).not.toContainText("dev-token-123");
  expect(await sentRequests(page)).toEqual([]);
  expect((await mockState(page, "settings")).showResolved).toBe(true);

  await page.reload();
  await openRequest(page, ["api", "pets.http"], "List pets");
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
  await expect(preview(page).locator(".target")).toHaveText("GET http://127.0.0.1:8765/pets?limit=20");

  await toggle(page).click();
  await expect(preview(page)).toHaveCount(0);
});

test("the preview follows edits and the environment; dynamic variables stay placeholders", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Get pet image"); // GET {{baseUrl}}/png/{{petId}}, File variable petId = 1
  await toggle(page).click();
  const target = preview(page).locator(".target");
  await expect(target).toHaveText("GET http://127.0.0.1:8765/png/1");

  await urlBar(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type("?q=a b&id={{$uuid}}");
  await page.keyboard.press("Escape");
  await expect(target).toHaveText("GET http://127.0.0.1:8765/png/1?q=a%20b&id={{$uuid}}");
  const dynamic = target.locator(".var.dynamic");
  await expect(dynamic).toHaveText("{{$uuid}}");
  await dynamic.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Dynamic variable: a new value is generated on every send");

  const env = page.getByRole("combobox", { name: "Active environment" });
  await env.click();
  await page.getByRole("listbox", { name: "Active environment" }).getByRole("option", { name: "staging" }).click();
  await expect(target).toHaveText("GET https://staging.example.com/png/1?q=a%20b&id={{$uuid}}");

  await env.click();
  await page.getByRole("listbox", { name: "Active environment" }).getByRole("option", { name: "No environment" }).click();
  await expect(target).toHaveText("GET {{baseUrl}}/png/1?q=a%20b&id={{$uuid}}");
  await expect(target.locator(".var.undefined")).toHaveText("{{baseUrl}}");
  await expect(preview(page)).toContainText("Can't be sent: The URL's scheme or host uses undefined variables: baseUrl");
  expect(await sentRequests(page)).toEqual([]);
});

test("a Content-Type the body implies is shown when the request sets none", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Create pet"); // JSON body, Content-Type: application/json
  await toggle(page).click();
  await expect(lines(page, "Headers").filter({ hasText: "Content-Type" })).toHaveText(["Content-Type: application/json"]);
  await expect(preview(page).locator(".row", { hasText: "Content-Type" }).locator(".note")).toHaveCount(0);

  await page.locator(".subtab", { hasText: "Headers" }).click();
  await page.locator(".kv-row:not(.ghost)").getByRole("button", { name: "Delete" }).first().click();
  const implied = preview(page).locator(".row", { hasText: "Content-Type" });
  await expect(implied.locator(".line")).toHaveText("Content-Type: application/json");
  await expect(implied.locator(".note")).toHaveText("from Body");
  await expect(lines(page, "Authorization")).toHaveCount(0);
});

test("typing is debounced: one preview for a burst of keystrokes", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await toggle(page).click();
  await expect(preview(page).locator(".target")).toContainText("limit=20");
  const before = await mockState(page, "previewRequests");
  await urlBar(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type("&page=12345", { delay: 20 });
  await expect(preview(page).locator(".target")).toContainText("page=12345");
  expect((await mockState(page, "previewRequests")) - before).toBeLessThanOrEqual(2);
});
