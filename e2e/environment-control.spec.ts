// #212: the top bar's environment control shows only colour the user chose, and
// marks a Production environment with the red "Prod" badge, in the control and
// on its option in the picker. The mocked workspace (`/demo`) starts with
// `local` selected; `staging` is its other environment.
import { expect, test, type Page } from "@playwright/test";
import { dialog, openApp, openRequest } from "./helpers";

const environments = (page: Page) => dialog(page, "Environments");
const control = (page: Page) => page.getByRole("combobox", { name: "Active environment" });
const picker = (page: Page) => page.getByRole("listbox", { name: "Active environment" });
/** The globe icon at the start of the control. */
const icon = (page: Page) => page.locator(".topbar .env > svg").first();

/** The theme's value of a colour token, as the browser computes it. */
const token = (page: Page, name: string) =>
  page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, name);

/** Opens the Environments editor on `env`, applies `edit`, and saves. */
async function editEnvironment(page: Page, env: string, edit: () => Promise<void>) {
  await page.getByRole("button", { name: "Manage environments" }).click();
  await environments(page).getByRole("button", { name: new RegExp(`^${env}\\b`) }).click();
  await edit();
  await environments(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(environments(page)).toBeHidden();
}

const markProduction = (page: Page) => environments(page).getByRole("checkbox", { name: "Production" }).click();

async function pickColour(page: Page, colour: string) {
  await environments(page).getByRole("combobox", { name: "Colour" }).click();
  await page.getByRole("option", { name: colour, exact: true }).click();
}

async function choose(page: Page, env: string) {
  await control(page).click();
  await picker(page).getByRole("option", { name: env }).click();
  await expect(picker(page)).toHaveCount(0);
}

test("a selected environment without a colour has a neutral icon, not the success colour", async ({ page }) => {
  await openApp(page);
  await expect(control(page)).toHaveText("local");
  const colour = await icon(page).evaluate((el) => getComputedStyle(el).color);
  expect(colour).not.toBe(await token(page, "--success"));
  expect(colour).toBe(await token(page, "--text"));
});

test("a selected environment with a colour shows that colour", async ({ page }) => {
  await openApp(page);
  await editEnvironment(page, "local", () => pickColour(page, "Blue"));
  await expect(icon(page)).toHaveCSS("color", "rgb(91, 157, 255)");
});

test("a selected Production environment shows a red Prod badge, even when coloured green", async ({ page }) => {
  await openApp(page);
  await editEnvironment(page, "local", async () => {
    await markProduction(page);
    await pickColour(page, "Green");
  });
  const prod = control(page).getByText("Prod", { exact: true });
  await expect(prod).toBeVisible();
  await expect(prod).toHaveCSS("color", await token(page, "--danger"));

  await choose(page, "staging");
  await expect(control(page)).toHaveText("staging");
  await expect(control(page).getByText("Prod", { exact: true })).toHaveCount(0);
});

test("No environment keeps the control's width and looks muted", async ({ page }) => {
  await openApp(page);
  await editEnvironment(page, "local", () => markProduction(page)); // its Prod badge takes no extra width either
  const box = page.locator(".topbar .env");
  const width = async () => (await box.boundingBox())!.width;
  const selected = await width();

  await choose(page, "No environment");
  await expect(control(page)).toHaveText("No environment");
  expect(await width()).toBe(selected);
  await expect(icon(page)).toHaveCSS("color", await token(page, "--muted"));
});

test("Production options in the picker show the Prod badge; the not-defined note still shows", async ({ page }) => {
  // `?folderEnvs=1`: api/ has env files of its own with `qa`, which samples/ doesn't define.
  await openApp(page, "?folderEnvs=1");
  await editEnvironment(page, "staging", () => markProduction(page));
  await openRequest(page, ["samples", "jetbrains.http"], "Get request with a header");

  await control(page).click();
  const options = picker(page).getByRole("option");
  await expect(options).toHaveText(["No environment", "local", "stagingProd", "qanot defined for samples/"]);
  const prod = options.getByText("Prod", { exact: true });
  await expect(prod).toHaveCount(1);
  await expect(options.filter({ hasText: /^staging/ }).getByText("Prod", { exact: true })).toHaveCSS("color", await token(page, "--danger"));
});
