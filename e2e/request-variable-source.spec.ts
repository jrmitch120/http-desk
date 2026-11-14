// #135: where a Request variable's value comes from. Hovering one in any editor
// shows what it reads now (the value, "not sent yet" or "path matches nothing"),
// the exchange it reads (the request, its file and when it arrived), and a quiet
// note that Rider refuses to send it. The Session panel's Named exchanges lists
// each named request's latest exchange, live; one can be forgotten, all cleared, or
// opened in the response viewer. A `# @name` two requests in a file share is
// flagged. `?chain=1`: Create pet is `# @name createPet` (its response is
// `{"id":7,"name":"Rex"}`) and Get pet image reads `{{createPet.response.body.$.id}}`
// in its URL and `$.name` in an X-Pet-Name header.
import { expect, test, type Page } from "@playwright/test";
import { activeTab, mockState, openApp, openRequest, sentRequests, tab, urlBar } from "./helpers";

const card = (page: Page) => page.locator(".popup-layer .var-card");
const send = (page: Page) => page.getByRole("button", { name: "Send", exact: true }).click();
const panel = (page: Page) => page.getByRole("region", { name: "Session" });
const exchanges = (page: Page) => panel(page).getByRole("table", { name: "Named exchanges" }).locator("tbody tr");
const RIDER = "Rider refuses to send a request containing this";

/** Hovers the URL bar's Request variable, from off the bar so the hover starts fresh. */
async function hoverReference(page: Page) {
  await page.mouse.move(0, 0);
  await expect(card(page)).toHaveCount(0);
  await urlBar(page).locator(".cm-var-request").hover();
}

/** Sends Create pet from its tab, recording createPet's exchange. */
async function sendCreatePet(page: Page) {
  await openRequest(page, ["api", "pets.http"], "Create pet");
  const before = (await sentRequests(page)).length;
  await send(page);
  await expect.poll(async () => (await sentRequests(page)).length).toBe(before + 1);
  await expect(page.getByText("201 Created")).toBeVisible();
}

test("before its request is sent, the hover says so, names the request and its file, and notes Rider", async ({ page }) => {
  await openApp(page, "?chain=1");
  await openRequest(page, ["api", "pets.http"], "Get pet image");

  await hoverReference(page);

  await expect(card(page).locator(".var-card-name")).toHaveText("createPet.response.body.$.id");
  await expect(card(page).locator(".var-card-value")).toHaveText("Not sent yet — send createPet first");
  await expect(card(page).locator(".var-card-source")).toHaveText("from createPet in api/pets.http, not sent in this Session");
  await expect(card(page).locator(".var-card-note")).toHaveText(RIDER);
});

test("once sent, the hover shows the value and the exchange: request, file and time received", async ({ page }) => {
  await openApp(page, "?chain=1");
  await sendCreatePet(page);
  await openRequest(page, ["api", "pets.http"], "Get pet image");

  await hoverReference(page);

  await expect(card(page).locator(".var-card-value")).toHaveText("7");
  await expect(card(page).locator(".var-card-source")).toHaveText(/^from the latest exchange of createPet in api\/pets\.http, received at .+ \(201\)$/);
  await expect(card(page).locator(".var-card-note")).toHaveText(RIDER);
});

test("a header cell's hover reads the same way", async ({ page }) => {
  await openApp(page, "?chain=1");
  await sendCreatePet(page);
  await openRequest(page, ["api", "pets.http"], "Get pet image");
  await page.locator(".subtab", { hasText: "Headers" }).click();

  await page.locator(".kv-row .c-value .cm-var-request").first().hover();

  await expect(card(page).locator(".var-card-value")).toHaveText("Rex");
  await expect(card(page).locator(".var-card-source")).toContainText("from the latest exchange of createPet");
  await expect(card(page).locator(".var-card-note")).toHaveText(RIDER);
});

test("a path that matches nothing says so, and why", async ({ page }) => {
  await openApp(page, "?chain=1");
  await sendCreatePet(page);
  await openRequest(page, ["api", "pets.http"], "Get pet image");
  await urlBar(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText("{{baseUrl}}/png/{{createPet.response.body.$.idd}}");

  await hoverReference(page);

  await expect(card(page).locator(".var-card-value")).toHaveText("Path matches nothing — `$.idd` matches nothing");
  await expect(card(page).locator(".var-card-source")).toContainText("from the latest exchange of createPet in api/pets.http");
});

test("Named exchanges lists each named request's latest exchange as sends happen, without a refresh", async ({ page }) => {
  await openApp(page, "?chain=1");
  await page.keyboard.press("Meta+j");
  await expect(panel(page)).toContainText("No named exchanges");

  await sendCreatePet(page);

  await expect(exchanges(page)).toHaveCount(1);
  const cells = exchanges(page).first().getByRole("cell");
  await expect(cells.nth(0)).toHaveText("createPet");
  await expect(cells.nth(1)).toHaveText("api/pets.http");
  await expect(cells.nth(2)).toHaveText("201");
  await expect(cells.nth(3)).toHaveText(/\d/);
  await expect(panel(page).getByRole("heading", { name: /^Named exchanges/ })).toContainText("1");
});

test("forgetting an exchange, or clearing them, makes its references report not sent", async ({ page }) => {
  await openApp(page, "?chain=1");
  await sendCreatePet(page);
  await page.keyboard.press("Meta+j");
  await expect(exchanges(page)).toHaveCount(1);

  await panel(page).getByRole("button", { name: "Forget createPet" }).click();

  await expect(exchanges(page)).toHaveCount(0);
  await openRequest(page, ["api", "pets.http"], "Get pet image");
  await hoverReference(page);
  await expect(card(page).locator(".var-card-value")).toHaveText("Not sent yet — send createPet first");
  await send(page);
  await expect(page.getByRole("alert").filter({ hasText: "Request not sent in this Session" })).toBeVisible();

  await tab(page, "Create pet").click();
  await send(page);
  await expect(exchanges(page)).toHaveCount(1);
  await panel(page).getByRole("button", { name: "Clear named exchanges" }).click();
  await expect(exchanges(page)).toHaveCount(0);
  await tab(page, "Get pet image").click();
  await hoverReference(page);
  await expect(card(page).locator(".var-card-value")).toHaveText("Not sent yet — send createPet first");
});

test("an exchange opens in the response viewer, and the request's tab keeps its own response", async ({ page }) => {
  await openApp(page, "?chain=1");
  await sendCreatePet(page);
  await page.keyboard.press("Meta+j");

  await panel(page).getByRole("button", { name: "Open createPet" }).click();

  const shown = page.getByRole("dialog", { name: "createPet" });
  await expect(shown).toContainText("201 Created");
  await expect(shown).toContainText("api/pets.http");
  await expect(shown.locator(".cm-content")).toContainText('"name": "Rex"');
  await shown.getByRole("button", { name: "Close" }).click();
  await expect(shown).toBeHidden();

  // The opened copy is released; the tab's response stays.
  await expect(activeTab(page)).toContainText("Create pet");
  await expect(page.getByText("201 Created")).toBeVisible();
  const released = await mockState(page, "releasedResponses");
  expect(released).toHaveLength(1);
});

test("a # @name another request in the file also has is flagged on the request", async ({ page }) => {
  await openApp(page, "?chain=dup");
  await openRequest(page, ["api", "pets.http"], "Create pet");

  const strip = page.getByRole("region", { name: "Pre-send checks" });
  await expect(strip).toContainText("# @name createPet is also the name of another request in this file");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await expect(page.getByRole("region", { name: "Pre-send checks" })).toHaveCount(0);
});
