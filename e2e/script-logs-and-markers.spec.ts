// #138: what a response handler logs shows with its response, in the Tests tab's
// Log section, and the tab and tree row of a request whose latest send ran tests
// show a green (all passed) or red (any failed) marker for the rest of the Session.
// The mocked sample `samples/jetbrains.http` "Post with JSON body" has a handler
// testing `response.status === 200`; the mock answers a POST with 201 (so it
// fails) unless `?status=200`. `?handlerLogs=1` adds two `client.log` lines to
// that handler, and `?trusted=1` starts with the demo workspace trusted.
import { expect, test, type Page } from "@playwright/test";
import { menuClick, openApp, openRequest, tab, treeItem } from "./helpers";

const HANDLER = "Post with JSON body";
const send = (page: Page) => page.getByRole("button", { name: "Send", exact: true }).click();
const viewerTabs = (page: Page) => page.getByRole("radiogroup", { name: "Response tabs" });
const testsTab = (page: Page) => viewerTabs(page).getByRole("radio", { name: /^Tests\b/ });
const logLines = (page: Page) => page.getByRole("list", { name: "Log" }).getByRole("listitem");
const openHandler = (page: Page) => openRequest(page, ["samples", "jetbrains.http"], HANDLER);
const treeRow = (page: Page) => page.getByTestId(`req-${HANDLER}`);
const marker = (row: ReturnType<typeof tab>, state: "passed" | "failed") => row.getByRole("img", { name: `Tests ${state}` });

test("the Tests tab's Log section shows what the handler logged, in order, for that response only", async ({ page }) => {
  await openApp(page, "?trusted=1&handlerLogs=1");
  await openHandler(page);
  await send(page);
  await testsTab(page).click();
  await expect(logLines(page)).toHaveText(["Checking the status", "Done"]);

  // The next send's log replaces it, rather than adding to it.
  await send(page);
  await expect(page.getByRole("button", { name: "Cancel", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(logLines(page)).toHaveText(["Checking the status", "Done"]);

  // Another request's response has no handler, so no Tests tab and no log.
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await expect(viewerTabs(page).getByRole("radio", { name: /^Body/ })).toBeVisible();
  await expect(testsTab(page)).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Log" })).toHaveCount(0);
});

test("a handler that logs nothing has no Log section", async ({ page }) => {
  await openApp(page, "?trusted=1");
  await openHandler(page);
  await send(page);
  await testsTab(page).click();
  await expect(page.getByTestId("test-result")).toHaveCount(1);
  await expect(page.getByRole("list", { name: "Log" })).toHaveCount(0);
});

test("a failing test marks the tab and the tree row red", async ({ page }) => {
  await openApp(page, "?trusted=1");
  await openHandler(page);
  await expect(marker(tab(page, HANDLER), "failed")).toHaveCount(0);
  await send(page);
  await expect(marker(tab(page, HANDLER), "failed")).toBeVisible();
  await expect(marker(treeRow(page), "failed")).toBeVisible();
  await expect(marker(treeRow(page), "passed")).toHaveCount(0);
  await expect(marker(tab(page, HANDLER), "failed")).toHaveCSS("color", await cssColor(page, "--danger"));
});

test("passing tests mark the tab and the tree row green", async ({ page }) => {
  await openApp(page, "?trusted=1&status=200");
  await openHandler(page);
  await send(page);
  await expect(marker(tab(page, HANDLER), "passed")).toBeVisible();
  await expect(marker(treeRow(page), "passed")).toBeVisible();
  await expect(marker(treeRow(page), "passed")).toHaveCSS("color", await cssColor(page, "--success"));
});

test("a request without tests has no marker", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await expect(viewerTabs(page).getByRole("radio", { name: /^Body/ })).toBeVisible();
  await expect(tab(page, "List pets").getByRole("img", { name: /^Tests/ })).toHaveCount(0);
  await expect(page.getByTestId("req-List pets").getByRole("img", { name: /^Tests/ })).toHaveCount(0);
});

test("the tree row keeps its marker after the tab closes, until another workspace is opened", async ({ page }) => {
  await openApp(page, "?trusted=1&recent=/work/shop");
  await openHandler(page);
  await send(page);
  await expect(marker(tab(page, HANDLER), "failed")).toBeVisible();
  await tab(page, HANDLER).getByRole("button", { name: "Close" }).click();
  await expect(tab(page, HANDLER)).toHaveCount(0);
  await expect(marker(treeRow(page), "failed")).toBeVisible();

  // The mock opens the demo workspace again, as a new one with a new Session.
  await menuClick(page, "open-recent:/work/shop");
  await expect(treeItem(page, "samples")).toHaveAttribute("aria-expanded", "false");
  await openHandler(page);
  await expect(treeRow(page)).toBeVisible();
  await expect(treeRow(page).getByRole("img", { name: /^Tests/ })).toHaveCount(0);
  await expect(tab(page, HANDLER).getByRole("img", { name: /^Tests/ })).toHaveCount(0);
});

/** The color a theme variable resolves to, as computed styles report it. */
function cssColor(page: Page, variable: string): Promise<string> {
  return page.evaluate((v) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${v})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, variable);
}
