// #79: an environment can be marked production (sending anything but GET, HEAD
// or OPTIONS asks first) and given a colour that tints the top bar's indicator.
// Both live in the app settings, keyed by workspace + environment name, never in
// the env files. The mocked workspace (`/demo`) starts with `local` selected.
import { expect, test, type Page } from "@playwright/test";
import { dialog, mockState, openApp, openRequest, sentRequests } from "./helpers";

const environments = (page: Page) => dialog(page, "Environments");
const envSettings = async (page: Page) => (await mockState(page, "settings")).environmentSettings["/demo"];
const send = (page: Page) => page.getByRole("button", { name: "Send", exact: true }).click();
/** The top bar's environment indicator. */
const indicator = (page: Page) => page.locator(".topbar .env");

/** Opens the Environments modal on `local`, applies `edit`, and saves. */
async function editLocal(page: Page, edit: () => Promise<void>) {
  await page.getByRole("button", { name: "Manage environments" }).click();
  await edit();
  await environments(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(environments(page)).toBeHidden();
}

const markProduction = (page: Page) => environments(page).getByRole("checkbox", { name: "Production" }).click();

async function pickColour(page: Page, colour: string) {
  await environments(page).getByRole("combobox", { name: "Colour" }).click();
  await page.getByRole("option", { name: colour, exact: true }).click();
}

test("a POST with a production environment asks first; Cancel doesn't send", async ({ page }) => {
  await openApp(page);
  await editLocal(page, () => markProduction(page));
  await openRequest(page, ["api", "pets.http"], "Create pet");

  await send(page);
  const confirm = dialog(page, "Send to production?");
  await expect(confirm).toContainText('"local" is a production environment. Send this POST request anyway?');
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
  expect(await sentRequests(page)).toEqual([]);

  await send(page);
  await confirm.getByRole("button", { name: "Send POST" }).click();
  await expect.poll(async () => (await sentRequests(page)).map((r) => r.method)).toEqual(["POST"]);
});

test("a GET with a production environment sends without asking", async ({ page }) => {
  await openApp(page);
  await editLocal(page, () => markProduction(page));
  await openRequest(page, ["api", "pets.http"], "List pets");

  await send(page);
  await expect.poll(async () => (await sentRequests(page)).map((r) => r.method)).toEqual(["GET"]);
  await expect(dialog(page, "Send to production?")).toHaveCount(0);
});

test("production and colour survive a restart and stay out of the env files", async ({ page }) => {
  await openApp(page);
  const filesBefore = await mockState(page, "envFiles");
  await editLocal(page, async () => {
    await markProduction(page);
    await pickColour(page, "Blue");
  });

  expect(await envSettings(page)).toEqual({ local: { production: true, color: "blue" } });
  expect(await mockState(page, "envFiles")).toEqual(filesBefore);
  await expect(indicator(page)).toHaveCSS("border-top-color", "rgb(91, 157, 255)");

  await page.reload();
  await expect(indicator(page)).toHaveCSS("border-top-color", "rgb(91, 157, 255)");
  await page.getByRole("button", { name: "Manage environments" }).click();
  await expect(environments(page).getByRole("checkbox", { name: "Production" })).toHaveAttribute("aria-checked", "true");
  await expect(environments(page).getByRole("combobox", { name: "Colour" })).toHaveText(/Blue/);
});

test("the colour has a darker shade in the light theme, and none without a colour", async ({ page }) => {
  await openApp(page, "?theme=light");
  const plain = await indicator(page).evaluate((el) => getComputedStyle(el).borderTopColor);
  await editLocal(page, () => pickColour(page, "Blue"));
  await expect(indicator(page)).toHaveCSS("border-top-color", "rgb(31, 111, 209)");

  await editLocal(page, () => pickColour(page, "No colour"));
  await expect(indicator(page)).toHaveCSS("border-top-color", plain);
});

test("renaming an environment keeps its settings; deleting it drops them", async ({ page }) => {
  await openApp(page);
  await editLocal(page, async () => {
    await markProduction(page);
    await pickColour(page, "Red");
    await environments(page).getByRole("button", { name: "Rename" }).click();
    await page.getByRole("dialog", { name: "Rename environment" }).getByRole("textbox").fill("prod");
    await page.keyboard.press("Enter");
  });
  expect(await envSettings(page)).toEqual({ prod: { production: true, color: "red" } });

  await editLocal(page, async () => {
    // The environment's own Delete (in its header), not a variable row's.
    await environments(page).locator(".main-head").getByRole("button", { name: "Delete" }).click();
    await dialog(page, "Delete environment").getByRole("button", { name: "Delete" }).click();
  });
  expect(await envSettings(page)).toBeUndefined();
});
