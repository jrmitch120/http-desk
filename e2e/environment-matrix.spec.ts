// The Environments matrix (#83): variables as rows, Shared and each environment
// as columns, edited in place. The mock has shared `version`, `local` with
// `baseUrl` and a Secret `token`, and `staging` with only `baseUrl`.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialog, mockState, openApp, showEnvironmentMatrix } from "./helpers";

/** Opens the Environments modal on the matrix (it opens on the list unless the matrix was picked). */
async function open(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Manage environments" }).click();
  await showEnvironmentMatrix(page);
  return dialog(page, "Environments");
}

const matrix = (modal: Locator) => modal.getByRole("group", { name: "Environments matrix" });
/** The cell of variable `name` in `column` ("Shared" or an environment's name). */
const cell = (modal: Locator, name: string, column: string) =>
  matrix(modal).locator(".m-cell").filter({ has: modal.page().getByRole("textbox", { name: `${name} in ${column}`, exact: true }) });
const envFiles = (page: Page) => mockState(page, "envFiles");
/** The open menu's items that draw an icon. */
const itemsWithIcons = (page: Page) => page.getByRole("menu").getByRole("menuitem").filter({ has: page.locator(".ico svg path:not([d=''])") });

test("shows every variable across Shared and the environments, with gaps highlighted", async ({ page }) => {
  await openApp(page);
  const modal = await open(page);
  const grid = matrix(modal);
  await expect(grid.locator(".kv-head > span")).toHaveText(["Variable", "Shared", "local", "staging", "Environment"]);
  await expect(grid.locator(".kv-row .m-name")).toHaveText(["baseUrl", "token", "version"]);
  await expect(grid.locator(".kv-row.ghost")).toHaveCount(0);

  await expect(cell(modal, "baseUrl", "staging")).toHaveText("https://staging.example.com");
  await expect(cell(modal, "token", "local").locator(".var-field")).toHaveText("•••••••••••••");

  // staging has no token and Shared doesn't supply one: a gap. Shared is optional, and
  // an environment without `version` uses the shared one, so neither is a gap.
  await expect(grid.locator(".m-cell.gap")).toHaveCount(1);
  await expect(cell(modal, "token", "staging")).toHaveClass(/\bgap\b/);
  const field = (name: string, column: string) => page.getByRole("textbox", { name: `${name} in ${column}`, exact: true });
  await expect(field("token", "staging")).toHaveAttribute("aria-placeholder", "Not set");
  await expect(cell(modal, "token", "Shared")).not.toHaveClass(/\bgap\b/);
  await expect(field("token", "Shared")).toHaveAttribute("aria-placeholder", "Not set");
  await expect(field("version", "local")).toHaveAttribute("aria-placeholder", "Uses shared");
});

test("a cell is edited in place, its gap clears, and Save writes it to that environment", async ({ page }) => {
  await openApp(page);
  const modal = await open(page);
  const gap = cell(modal, "token", "staging");
  await gap.locator(".var-field").click();
  await page.keyboard.type("stg-{{ver");
  await page.keyboard.press("Escape"); // closes the {{ list, not the modal
  await page.keyboard.type("sion}}");
  await expect(gap).not.toHaveClass(/\bgap\b/);
  await page.keyboard.press("Tab");
  await expect(gap.locator(".var-field")).toHaveText("stg-{{version}}");
  await expect(gap.locator(".cm-var-ok")).toHaveText("{{version}}");

  const baseUrl = cell(modal, "baseUrl", "local").locator(".var-field");
  await baseUrl.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("http://localhost:9000");
  await page.keyboard.press("Tab");

  await modal.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Environments saved")).toBeVisible();
  const files = await envFiles(page);
  expect(files.shared.staging).toEqual({ baseUrl: "https://staging.example.com", token: "stg-{{version}}" });
  expect(files.shared.local).toEqual({ baseUrl: "http://localhost:9000" });
  expect(files.private.local).toEqual({ token: "dev-token-123" });
});

test("each cell has its own Secret toggle, and Save moves the value between the files", async ({ page }) => {
  await openApp(page);
  const modal = await open(page);
  const staging = cell(modal, "baseUrl", "staging");
  const local = cell(modal, "token", "local");
  await staging.getByRole("button", { name: "Secret" }).click();
  await expect(staging.getByRole("button", { name: "Secret" })).toHaveAttribute("aria-pressed", "true");
  await expect(staging.locator(".var-field")).toHaveText("•".repeat("https://staging.example.com".length));
  await staging.getByRole("button", { name: "Show value" }).click();
  await expect(staging.locator(".var-field")).toHaveText("https://staging.example.com");
  // Only that cell: local's baseUrl stays shareable.
  await expect(cell(modal, "baseUrl", "local").getByRole("button", { name: "Secret" })).toHaveAttribute("aria-pressed", "false");

  await local.getByRole("button", { name: "Secret" }).click();
  await expect(local.locator(".var-field")).toHaveText("dev-token-123");

  await modal.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Environments saved")).toBeVisible();
  const files = await envFiles(page);
  expect(files.private.staging).toEqual({ baseUrl: "https://staging.example.com" });
  expect(files.shared.staging).toEqual({ baseUrl: "" }); // a Secret's placeholder, as before
  expect(files.shared.local).toEqual({ baseUrl: "http://127.0.0.1:8765", token: "dev-token-123" });
  expect(files.private.local).toBeUndefined();
});

test("Add variable to all environments adds a row every environment saves", async ({ page }) => {
  await openApp(page);
  const modal = await open(page);
  await modal.getByRole("button", { name: "Add variable to all environments" }).click();
  const ask = dialog(page, "Add variable to all environments");
  await ask.getByRole("textbox").fill("apiKey");
  await ask.getByRole("button", { name: "OK" }).click();

  await expect(matrix(modal).locator(".kv-row .m-name")).toHaveText(["apiKey", "baseUrl", "token", "version"]);
  await expect(cell(modal, "apiKey", "local")).not.toHaveClass(/\bgap\b/);
  await expect(cell(modal, "apiKey", "staging")).not.toHaveClass(/\bgap\b/);
  // Set but empty reads "Empty", unlike Shared, which doesn't define it ("Not set"),
  // and looks different from it too.
  const field = (column: string) => page.getByRole("textbox", { name: `apiKey in ${column}`, exact: true });
  await expect(field("local")).toHaveAttribute("aria-placeholder", "Empty");
  await expect(field("staging")).toHaveAttribute("aria-placeholder", "Empty");
  await expect(field("Shared")).toHaveAttribute("aria-placeholder", "Not set");
  const placeholderStyle = (column: string) => field(column).evaluate((el) => getComputedStyle(el, "::before").fontStyle);
  // Retried: a VarField re-rendered just as it is read has no style at all ("").
  await expect.poll(() => placeholderStyle("staging")).toBe("italic"); // local has focus, so it shows its editor
  await expect.poll(() => placeholderStyle("Shared")).toBe("normal");
  await cell(modal, "apiKey", "staging").locator(".var-field").click();
  await page.keyboard.type("k-stg");
  await page.keyboard.press("Tab");

  await modal.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Environments saved")).toBeVisible();
  const files = await envFiles(page);
  expect(files.shared.local.apiKey).toBe("");
  expect(files.shared.staging.apiKey).toBe("k-stg");
});

test("a row's menu deletes the variable from every environment", async ({ page }) => {
  await openApp(page);
  const modal = await open(page);
  await matrix(modal).locator(".m-name", { hasText: "baseUrl" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete from all environments" }).click();
  await expect(matrix(modal).locator(".kv-row .m-name")).toHaveText(["token", "version"]);

  // The row's actions button opens the same menu. It sits at the right edge of the
  // Variable cell, shown on hover and focus; the last column only heads "+ Environment".
  const row = matrix(modal).locator(".kv-row").filter({ hasText: "token" });
  const actions = row.locator(".c-name").getByRole("button", { name: "Actions for token" });
  await expect(actions).toHaveCSS("opacity", "0");
  await row.hover();
  await expect(actions).toHaveCSS("opacity", "1");
  const nameBox = (await row.locator(".c-name").boundingBox())!;
  const buttonBox = (await actions.boundingBox())!;
  expect(nameBox.x + nameBox.width - (buttonBox.x + buttonBox.width)).toBeLessThan(8);
  await expect(matrix(modal).locator(".kv-row .c-actions").first()).toBeEmpty();
  await actions.click();
  await expect(page.getByRole("menuitem", { name: "Delete from all environments" })).toBeVisible();
  await expect(itemsWithIcons(page)).toHaveText(["Find usages", "Rename everywhere…", "Delete from all environments"]);
  await page.keyboard.press("Escape");
  await expect(actions).toBeFocused();

  // From the keyboard: the button is reachable with Tab, and shows while focused.
  await page.mouse.move(0, 0);
  await matrix(modal).getByRole("button", { name: "New environment" }).focus();
  await page.keyboard.press("Tab");
  const first = matrix(modal).locator(".kv-row").first().getByRole("button", { name: /^Actions for / });
  await expect(first).toBeFocused();
  await expect(first).toHaveCSS("opacity", "1");
});

test("a hover card's Edit focuses the cell that defines the variable", async ({ page }) => {
  await openApp(page);
  const modal = await open(page);
  await cell(modal, "token", "staging").locator(".var-field").click();
  await page.keyboard.type("{{version}}");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  await cell(modal, "token", "staging").locator(".cm-var", { hasText: "{{version}}" }).hover();
  await page.locator(".var-card").getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("textbox", { name: "version in Shared", exact: true })).toBeFocused();
});

test("the List / Matrix choice is remembered, and the filter narrows rows", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Manage environments" }).click();
  let modal = dialog(page, "Environments");

  // List first, Matrix second; the list is the default.
  const view = modal.getByRole("radiogroup", { name: "View" });
  await expect(view.getByRole("radio")).toHaveText(["List", "Matrix"]);
  await expect(view.getByRole("radio", { name: "List" })).toBeChecked();
  await expect(modal.getByRole("group", { name: "Variables" })).toBeVisible();
  await expect(matrix(modal)).toHaveCount(0);
  await view.getByRole("radio", { name: "Matrix" }).click();
  await expect(modal.getByRole("group", { name: "Variables" })).toHaveCount(0);
  await expect.poll(async () => (await mockState(page, "settings")).envView).toBe("matrix");
  await modal.getByPlaceholder("Filter variables").fill("staging.example");
  await expect(matrix(modal).locator(".kv-row .m-name")).toHaveText(["baseUrl"]);

  await page.reload();
  await page.getByRole("button", { name: "Manage environments" }).click();
  modal = dialog(page, "Environments");
  await expect(modal.getByRole("radiogroup", { name: "View" }).getByRole("radio", { name: "Matrix" })).toBeChecked();
  await expect(matrix(modal)).toBeVisible();
});

test("the header's last cell adds an environment as a new column", async ({ page }) => {
  await openApp(page);
  const modal = await open(page);
  // The only way to add one in the matrix: no stray button in the toolbar.
  const add = modal.getByRole("button", { name: "New environment" });
  await expect(add).toHaveCount(1);
  await expect(matrix(modal).locator(".kv-head")).toContainText("Environment");
  await add.click();
  const ask = dialog(page, "New environment");
  await ask.getByRole("textbox").fill("prod");
  await ask.getByRole("button", { name: "OK" }).click();
  await expect(matrix(modal).locator(".kv-head > span")).toHaveText(["Variable", "Shared", "local", "staging", "prod", "Environment"]);
  await expect(cell(modal, "baseUrl", "prod")).toHaveClass(/\bgap\b/);
});

test("typing a value never moves a row, even where the variable is first seen", async ({ page }) => {
  await openApp(page);
  const modal = await open(page);
  const names = matrix(modal).locator(".kv-row .m-name");
  await expect(names).toHaveText(["baseUrl", "token", "version"]);
  // token was first seen in local; filling Shared's cell makes Shared define it first.
  await cell(modal, "token", "Shared").locator(".var-field").click();
  await page.keyboard.type("t");
  await expect(names).toHaveText(["baseUrl", "token", "version"]);
  await expect(page.getByRole("textbox", { name: "token in Shared", exact: true })).toBeFocused();
  await page.keyboard.type("ok");
  await page.keyboard.press("Tab");
  await expect(cell(modal, "token", "Shared")).toHaveText("tok");
  await expect(names).toHaveText(["baseUrl", "token", "version"]);
});

test("rows are sorted A to Z by name, the Variable header flips the order, and the order lasts the session", async ({ page }) => {
  await openApp(page);
  let modal = await open(page);
  const names = matrix(modal).locator(".kv-row .m-name");
  const header = matrix(modal).getByRole("columnheader", { name: "Variable" });
  const sort = header.getByRole("button", { name: "Variable" });
  await expect(header).toHaveAttribute("aria-sort", "ascending");
  await expect(names).toHaveText(["baseUrl", "token", "version"]);

  await sort.click();
  await expect(header).toHaveAttribute("aria-sort", "descending");
  await expect(names).toHaveText(["version", "token", "baseUrl"]);
  await sort.press("Enter");
  await expect(header).toHaveAttribute("aria-sort", "ascending");
  await expect(names).toHaveText(["baseUrl", "token", "version"]);
  await sort.press("Space");
  await expect(header).toHaveAttribute("aria-sort", "descending");
  await sort.press("Space");
  await expect(header).toHaveAttribute("aria-sort", "ascending");

  // A new variable takes its sorted place, and the filter still applies.
  await modal.getByRole("button", { name: "Add variable to all environments" }).click();
  const ask = dialog(page, "Add variable to all environments");
  await ask.getByRole("textbox").fill("apiKey");
  await ask.getByRole("button", { name: "OK" }).click();
  await expect(names).toHaveText(["apiKey", "baseUrl", "token", "version"]);
  await page.keyboard.type("zzz"); // a value sorts nothing
  await page.keyboard.press("Tab");
  await expect(names).toHaveText(["apiKey", "baseUrl", "token", "version"]);
  await modal.getByPlaceholder("Filter variables").fill("k");
  await expect(names).toHaveText(["apiKey", "token"]);

  // Kept when the modal opens again, but not saved with the settings.
  await sort.click();
  await modal.getByRole("button", { name: "Cancel" }).click();
  await dialog(page, "Discard changes?").getByRole("button", { name: "Discard" }).click();
  modal = await open(page);
  await expect(matrix(modal).getByRole("columnheader", { name: "Variable" })).toHaveAttribute("aria-sort", "descending");
  await expect(matrix(modal).locator(".kv-row .m-name")).toHaveText(["version", "token", "baseUrl"]);
  await page.reload();
  modal = await open(page);
  await expect(matrix(modal).locator(".kv-row .m-name")).toHaveText(["baseUrl", "token", "version"]);
});

test("a cell's Unset button and context menu remove the variable from that column, and Save drops it from both files", async ({ page }) => {
  await openApp(page);
  const modal = await open(page);
  const names = matrix(modal).locator(".kv-row .m-name");

  // The button shows on hover, only on a cell that's set.
  const staging = cell(modal, "baseUrl", "staging");
  const unset = staging.getByRole("button", { name: "Unset" });
  await expect(unset).toHaveCSS("opacity", "0");
  await staging.hover();
  await expect(unset).toHaveCSS("opacity", "1");
  await expect(cell(modal, "token", "staging").getByRole("button", { name: "Unset" })).toHaveCount(0);
  await unset.click();
  await expect(staging).toHaveClass(/\bgap\b/);
  await expect(page.getByRole("textbox", { name: "baseUrl in staging", exact: true })).toHaveAttribute("aria-placeholder", "Not set");
  await expect(staging.getByRole("button", { name: "Unset" })).toHaveCount(0);

  // An empty value is still set until it's unset.
  const local = cell(modal, "baseUrl", "local");
  await local.locator(".var-field").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Tab");
  await expect(local).not.toHaveClass(/\bgap\b/);
  await local.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unset in local" }).click();
  await expect(local).toHaveClass(/\bgap\b/);
  // No column defines baseUrl now; its row stays until the modal closes.
  await expect(names).toHaveText(["baseUrl", "token", "version"]);

  // A Secret, and a shared variable (an environment without its own then has a gap).
  await cell(modal, "token", "local").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unset in local" }).click();
  await cell(modal, "version", "Shared").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unset in Shared" }).click();
  await expect(page.getByRole("textbox", { name: "version in Shared", exact: true })).toHaveAttribute("aria-placeholder", "Not set");
  await expect(cell(modal, "version", "local")).toHaveClass(/\bgap\b/);

  await modal.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Environments saved")).toBeVisible();
  const files = await envFiles(page);
  expect(files.shared).toEqual({ $shared: {}, local: {}, staging: {} });
  expect(files.private).toEqual({});
});

test("an environment's header has Rename, Duplicate and Delete, from its actions button or a right-click; Shared's has none", async ({ page }) => {
  await openApp(page);
  const modal = await open(page);
  const heads = matrix(modal).locator(".kv-head > span");
  const head = (name: string) => heads.filter({ hasText: new RegExp(`^\\s*${name}\\s*$`) });

  // Shown on hover and focus, like a row's.
  const actions = head("local").getByRole("button", { name: "Actions for environment local" });
  await expect(actions).toHaveCSS("opacity", "0");
  await head("local").hover();
  await expect(actions).toHaveCSS("opacity", "1");
  await actions.click();
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Rename…", "Duplicate", "Delete environment…"]);
  await expect(itemsWithIcons(page)).toHaveText(["Rename…", "Duplicate", "Delete environment…"]);
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  const ask = dialog(page, "Rename environment");
  await ask.getByRole("textbox").fill("dev");
  await ask.getByRole("button", { name: "OK" }).click();
  await expect(heads).toHaveText(["Variable", "Shared", "dev", "staging", "Environment"]);

  await head("staging").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(heads).toHaveText(["Variable", "Shared", "dev", "staging", "staging copy", "Environment"]);
  await expect(cell(modal, "baseUrl", "staging copy")).toHaveText("https://staging.example.com");

  // Delete asks first, as the List view does.
  await head("staging copy").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete environment…" }).click();
  await dialog(page, "Delete environment").getByRole("button", { name: "Delete" }).click();
  await expect(heads).toHaveText(["Variable", "Shared", "dev", "staging", "Environment"]);

  // Shared has no environment actions.
  await expect(head("Shared").getByRole("button")).toHaveCount(0);
  await head("Shared").click({ button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("deleting an environment takes the rows only it defined with it", async ({ page }) => {
  await openApp(page);
  const modal = await open(page);
  const names = matrix(modal).locator(".kv-row .m-name");
  await expect(names).toHaveText(["baseUrl", "token", "version"]);
  // Only local defines token.
  await matrix(modal).locator(".kv-head > span").filter({ hasText: /^\s*local\s*$/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete environment…" }).click();
  await dialog(page, "Delete environment").getByRole("button", { name: "Delete" }).click();
  await expect(names).toHaveText(["baseUrl", "version"]);
});

/** The header's resize separator for `column`. */
const resizer = (modal: Locator, column: string) => matrix(modal).getByRole("separator", { name: `Resize ${column} column` });
const headWidth = async (modal: Locator, column: string) => {
  const head = matrix(modal).locator(".kv-head > span").filter({ hasText: new RegExp(`^\\s*${column}\\s*$`) });
  return Math.round((await head.boundingBox())!.width);
};

test("a column resizes by dragging or the keyboard, double-click fits its widest value, and the width is remembered", async ({ page }) => {
  await openApp(page);
  let modal = await open(page);
  const local = resizer(modal, "local");
  await expect(local).toHaveAttribute("aria-orientation", "vertical");
  // Its value is the column's width as laid out.
  await expect.poll(async () => Number(await local.getAttribute("aria-valuenow")) - (await headWidth(modal, "local"))).toBe(0);
  const start = Number(await local.getAttribute("aria-valuenow"));

  // The keyboard: arrows step, Home goes to the narrowest.
  await local.focus();
  await page.keyboard.press("ArrowRight");
  await expect(local).toHaveAttribute("aria-valuenow", String(start + 16));
  expect(await headWidth(modal, "local")).toBe(start + 16);
  await page.keyboard.press("Home");
  await expect(local).toHaveAttribute("aria-valuenow", "100");

  // A drag.
  const box = (await local.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(local).toHaveAttribute("aria-valuenow", "200");
  expect(await headWidth(modal, "local")).toBe(200);

  // Double-click fits the widest value: nothing in the column is cut off, and it isn't wider than that.
  const staging = resizer(modal, "staging");
  await staging.focus();
  await page.keyboard.press("Home");
  await staging.dblclick();
  const valueOf = async (sep: Locator) => Number(await sep.getAttribute("aria-valuenow"));
  await expect.poll(() => valueOf(staging)).toBeGreaterThan(200);
  const fitted = await valueOf(staging);
  const cut = await matrix(modal)
    .locator('.m-cell[data-column="m2"] .vf-static')
    .evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth).length);
  expect(cut).toBe(0);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter"); // Enter fits too
  await expect(staging).toHaveAttribute("aria-valuenow", String(fitted));

  // Remembered for the workspace, in the app settings.
  await expect.poll(async () => (await mockState(page, "settings")).envMatrixWidths?.["/demo"]?.columns).toEqual({ local: 200, staging: fitted });
  await page.reload();
  modal = await open(page);
  await expect(resizer(modal, "local")).toHaveAttribute("aria-valuenow", "200");
  await expect(resizer(modal, "staging")).toHaveAttribute("aria-valuenow", String(fitted));

  // The Variable column and Shared resize too; "+ Environment" doesn't.
  await expect(resizer(modal, "Variable")).toHaveCount(1);
  await expect(resizer(modal, "Shared")).toHaveCount(1);
  await expect(matrix(modal).getByRole("separator")).toHaveCount(4);
});

test("a renamed environment keeps its column width, and a deleted one's is dropped when saved", async ({ page }) => {
  await openApp(page);
  let modal = await open(page);
  await resizer(modal, "local").focus();
  await page.keyboard.press("Home");
  await resizer(modal, "staging").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  const widths = async () => (await mockState(page, "settings")).envMatrixWidths?.["/demo"]?.columns;
  await expect.poll(widths).toEqual({ local: 100, staging: 116 });

  const head = (name: string) => matrix(modal).locator(".kv-head > span").filter({ hasText: new RegExp(`^\\s*${name}\\s*$`) });
  await head("local").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  await dialog(page, "Rename environment").getByRole("textbox").fill("dev");
  await dialog(page, "Rename environment").getByRole("button", { name: "OK" }).click();
  await expect(head("dev")).toBeVisible();
  await expect.poll(() => headWidth(modal, "dev")).toBe(100);

  await head("staging").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete environment…" }).click();
  await dialog(page, "Delete environment").getByRole("button", { name: "Delete" }).click();
  await modal.getByRole("button", { name: "Save", exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect.poll(widths).toEqual({ dev: 100 });

  // The mock's env files don't survive a reload, so reopen instead.
  modal = await open(page);
  await expect.poll(() => headWidth(modal, "dev")).toBe(100);
});

test("a cut-off value shows in full in a tooltip, except a masked Secret", async ({ page }) => {
  await openApp(page);
  const modal = await open(page);
  // Narrow enough to cut off local's values, but not their fields.
  await resizer(modal, "local").focus();
  await page.keyboard.press("Home");
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  await expect(resizer(modal, "local")).toHaveAttribute("aria-valuenow", "148");

  const tip = page.getByRole("tooltip");
  await page.getByRole("textbox", { name: "baseUrl in local", exact: true }).hover();
  await expect(tip).toHaveText("http://127.0.0.1:8765");

  // On keyboard focus too, in the field's editor.
  await page.mouse.move(0, 0);
  await expect(tip).toBeHidden();
  await cell(modal, "baseUrl", "Shared").getByRole("button", { name: "Secret" }).focus();
  await page.keyboard.press("Tab");
  await expect(cell(modal, "baseUrl", "local").locator(".cm-content")).toBeFocused();
  await expect(tip).toHaveText("http://127.0.0.1:8765");
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());

  // A masked Secret gives nothing away.
  await page.mouse.move(0, 0);
  await expect(tip).toBeHidden();
  await page.getByRole("textbox", { name: "token in local", exact: true }).hover();
  await page.waitForTimeout(600);
  await expect(tip).toBeHidden();

  // A value that fits has none.
  await page.getByRole("textbox", { name: "version in Shared", exact: true }).hover();
  await page.waitForTimeout(600);
  await expect(tip).toBeHidden();
});
