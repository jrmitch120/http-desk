// #133: Request variables (VS Code REST Client). `?chain=1` makes the mock name
// Create pet `# @name createPet` and has Get pet image read the new pet's id from
// its latest exchange: `GET {{baseUrl}}/png/{{createPet.response.body.$.id}}`.
// A send that reads a request not sent in this Session is blocked with its own
// report and a "Send `createPet` first" that goes through the normal send.
import { expect, test, type Page } from "@playwright/test";
import { activeTab, dialog, openApp, openRequest, sentRequests, tab, urlBar } from "./helpers";

const send = (page: Page) => page.getByRole("button", { name: "Send", exact: true }).click();
const blocked = (page: Page) => page.getByRole("alert").filter({ hasText: "Request not sent in this Session" });

test("a Request variable of a request named in the file is marked as one, not as undefined", async ({ page }) => {
  await openApp(page, "?chain=1");
  await openRequest(page, ["api", "pets.http"], "Get pet image");

  await expect(urlBar(page).locator(".cm-var-request")).toHaveText("{{createPet.response.body.$.id}}");
  await expect(urlBar(page).locator(".cm-var-bad")).toHaveCount(0);
});

test("a send reading an unsent request is blocked; Send first sends it, then the original goes through", async ({ page }) => {
  await openApp(page, "?chain=1");
  await openRequest(page, ["api", "pets.http"], "Get pet image");

  await send(page);
  const report = blocked(page);
  await expect(report).toContainText("This request reads the response of `createPet`, so send `createPet` first.");
  expect(await sentRequests(page)).toEqual([]);

  await report.getByRole("button", { name: "Send `createPet` first" }).click();
  await expect(activeTab(page)).toContainText("Create pet");
  await expect.poll(async () => (await sentRequests(page)).map((r) => r.method)).toEqual(["POST"]);
  await expect(page.getByText("201 Created")).toBeVisible();

  await tab(page, "Get pet image").click();
  await send(page);
  await expect.poll(async () => (await sentRequests(page)).map((r) => r.method)).toEqual(["POST", "GET"]);
  await expect(blocked(page)).toHaveCount(0);
});

test("Send first goes through the production confirmation", async ({ page }) => {
  await openApp(page, "?chain=1");
  await page.getByRole("button", { name: "Manage environments" }).click();
  const environments = dialog(page, "Environments");
  await environments.getByRole("checkbox", { name: "Production" }).click();
  await environments.getByRole("button", { name: "Save", exact: true }).click();
  await expect(environments).toBeHidden();
  await openRequest(page, ["api", "pets.http"], "Get pet image");
  await send(page);

  await blocked(page).getByRole("button", { name: "Send `createPet` first" }).click();
  const confirm = dialog(page, "Send to production?");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
  expect(await sentRequests(page)).toEqual([]);
});

test("a path that matches nothing gets its own report naming the exchange it looked in", async ({ page }) => {
  // The mock fails every send with the report; any request will do.
  await openApp(page, "?sendError=unmatchedPath");
  await openRequest(page, ["api", "pets.http"], "List pets");

  await send(page);

  const report = page.getByRole("alert").filter({ hasText: "A Request variable matched nothing" });
  await expect(report).toContainText("{{createPet.response.body.$.idd}}: `$.idd` matches nothing");
  await expect(report).toContainText("Looked in the latest exchange of `createPet`, received at");
  await expect(report.getByRole("button", { name: "Retry" })).toBeVisible();
});

// #136: completion inside a Request variable reads the named request's latest exchange.
const completions = (page: Page) => page.locator(".popup-layer .cm-tooltip-autocomplete");
const labels = (page: Page) => completions(page).locator(".cm-completionLabel");

test("completion offers a named request, then response, then its latest response's JSON keys as you go", async ({ page }) => {
  await openApp(page, "?chain=1");
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await send(page);
  await expect(page.getByText("201 Created")).toBeVisible();
  await openRequest(page, ["api", "pets.http"], "Get pet image");

  await urlBar(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("{{baseUrl}}/png/{{createP");
  await expect(completions(page).getByRole("option").filter({ hasText: "createPet" })).toContainText("request");
  await expect(async () => {
    await page.keyboard.press("Enter");
    await expect(urlBar(page)).toHaveText("{{baseUrl}}/png/{{createPet.}}", { timeout: 200 });
  }).toPass();
  // The name goes on with its path: the next segment is offered at once.
  await expect(labels(page)).toHaveText(["response", "request"]);

  await page.keyboard.type("response.body.$.");
  await expect(labels(page)).toHaveText(["items", "method"]);
  await page.keyboard.type("items[0].");
  await expect(labels(page)).toHaveText(["id", "name", "tags", "active", "owner"]);
  await expect(async () => {
    await page.keyboard.press("Enter");
    await expect(urlBar(page)).toHaveText("{{baseUrl}}/png/{{createPet.response.body.$.items[0].id}}", { timeout: 200 });
  }).toPass();
});

test("before the request is sent, completion offers the structure and says it hasn't been sent", async ({ page }) => {
  await openApp(page, "?chain=1");
  await openRequest(page, ["api", "pets.http"], "Get pet image");

  await urlBar(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("{{createPet.response.");
  await expect(labels(page)).toHaveText(["body", "headers"]);
  await page.keyboard.type("headers.");
  await expect(labels(page)).toHaveText(["createPet hasn't been sent in this Session"]);
});
