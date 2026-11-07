// Hover cards and autocomplete in variable-aware fields (#81): a Secret is masked
// until revealed in that card, Edit jumps to the variable's row, and `{{` lists
// each name with its source and a value preview, then the dynamic variables.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openApp, openRequest, showEnvironmentMatrix, urlBar } from "./helpers";

/** Opens List pets (the `local` environment is selected: baseUrl, Secret token; shared: version). */
async function openSection(page: Page, section: "Headers" | "Settings"): Promise<void> {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.locator(".subtab", { hasText: section }).click();
}

/** The first header's value cell, retyped to `text`, left without focus (its static rendering). */
async function headerValue(page: Page, text: string): Promise<Locator> {
  await page.locator(".subtab", { hasText: "Headers" }).click();
  const cell = page.locator(".kv-row").first().locator(".c-value");
  await cell.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text);
  await page.keyboard.press("Tab");
  return cell;
}

const card = (page: Page) => page.locator(".popup-layer .var-card");

/** The grid row that has focus: its name, and the value cell's text if focus is in it (an input or a VarField). */
const focusedRow = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    const name = (el?.closest(".kv-row")?.querySelector(".c-name") as HTMLInputElement | null)?.value ?? null;
    const cell = el?.closest(".c-value");
    return { name, value: !cell ? null : el instanceof HTMLInputElement ? el.value : cell.textContent?.trim() };
  });

test("a Secret is masked in its hover card until revealed, and only in that card", async ({ page }) => {
  await openSection(page, "Headers");
  const cell = await headerValue(page, "{{token}}");

  await cell.locator(".cm-var").hover();
  await expect(card(page)).toContainText("••••••••");
  await expect(card(page)).not.toContainText("dev-token-123");
  await card(page).getByRole("button", { name: "Reveal" }).click();
  await expect(card(page)).toContainText("dev-token-123");
  await card(page).getByRole("button", { name: "Hide" }).click();
  await expect(card(page)).not.toContainText("dev-token-123");
  await card(page).getByRole("button", { name: "Reveal" }).click();

  // A new card starts masked.
  await page.mouse.move(0, 0);
  await expect(card(page)).toHaveCount(0);
  await cell.locator(".cm-var").hover();
  await expect(card(page)).toContainText("••••••••");
  await expect(card(page)).not.toContainText("dev-token-123");

  // In the editor's card too, and revealing doesn't end editing.
  await page.mouse.move(0, 0);
  await cell.click();
  await cell.locator(".cm-var").hover();
  await card(page).getByRole("button", { name: "Reveal" }).click();
  await expect(card(page)).toContainText("dev-token-123");
  await expect(page.locator(".kv .cm-editor")).toHaveCount(1);
});

test("Edit in a header value's hover card opens the Environments modal on the variable's row, or its cell in the matrix", async ({ page }) => {
  await openSection(page, "Headers");
  const cell = await headerValue(page, "{{baseUrl}} {{version}}");
  const modal = page.getByRole("dialog", { name: "Environments" });

  // The list (the default): the environment, on the variable's row.
  await cell.locator(".cm-var", { hasText: "{{baseUrl}}" }).hover();
  await card(page).getByRole("button", { name: "Edit" }).click();
  await expect(modal).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await expect(modal.locator(".main-head .title")).toHaveText("local");
  await expect.poll(() => focusedRow(page)).toEqual({ name: "baseUrl", value: "http://127.0.0.1:8765" });

  // A shared variable opens the shared variables.
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await cell.locator(".cm-var", { hasText: "{{version}}" }).hover();
  await card(page).getByRole("button", { name: "Edit" }).click();
  await expect(modal.locator(".main-head .title")).toContainText("Shared variables");
  await expect.poll(() => focusedRow(page)).toEqual({ name: "version", value: "v1" });
  await showEnvironmentMatrix(page);
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);

  // The matrix (#83): the cell in the environment that supplies it.
  await cell.locator(".cm-var", { hasText: "{{baseUrl}}" }).hover();
  await card(page).getByRole("button", { name: "Edit" }).click();
  await expect(modal.getByRole("textbox", { name: "baseUrl in local", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await cell.locator(".cm-var", { hasText: "{{version}}" }).hover();
  await card(page).getByRole("button", { name: "Edit" }).click();
  await expect(modal.getByRole("textbox", { name: "version in Shared", exact: true })).toBeFocused();
});

test("Edit on a File variable opens the request's Settings with its row focused", async ({ page }) => {
  await openSection(page, "Settings");
  // pets.http declares @petId = 1 at the top; a second declaration is the one in use.
  for (const [name, value] of [["host", "example.com"], ["petId", "7"]]) {
    await page.getByPlaceholder("Add variable").click();
    await page.keyboard.type(name);
    await page.keyboard.press("Tab");
    await page.keyboard.type(value);
  }
  const cell = await headerValue(page, "{{petId}}");

  await cell.locator(".cm-var").hover();
  await expect(card(page)).toContainText("from this file");
  await card(page).getByRole("button", { name: "Edit" }).click();
  await expect(page.locator(".subtab.active")).toContainText("Settings");
  await expect.poll(() => focusedRow(page)).toEqual({ name: "petId", value: "7" });
});

test("Edit on a File variable declared in a request shows its line in that request's .http source", async ({ page }) => {
  await openApp(page, "?requestVars=1");
  await openRequest(page, ["api", "pets.http"], "List pets");
  const cell = await headerValue(page, "{{size}} {{kind}}");
  const selection = () => page.evaluate(() => getSelection()?.toString());

  // List pets' own @size.
  await cell.locator(".cm-var", { hasText: "{{size}}" }).hover();
  await expect(card(page)).toContainText("from this request");
  await card(page).getByRole("button", { name: "Edit" }).click();
  await expect(page.locator(".source-code")).toContainText("@size = 10");
  await expect.poll(selection).toBe("@size = 10");

  // Create pet's @kind: its tab comes forward on that line.
  await page.locator(".btn", { hasText: ".http" }).click();
  await cell.locator(".cm-var", { hasText: "{{kind}}" }).hover();
  await expect(card(page)).toContainText("from this file");
  await card(page).getByRole("button", { name: "Edit" }).click();
  await expect(page.locator(".crumbs .name-input")).toHaveValue("Create pet");
  await expect.poll(selection).toBe("@kind = cat");
});

test("an undefined variable, or a dynamic one, has no Edit; only a named one has Find usages", async ({ page }) => {
  await openSection(page, "Headers");
  const cell = await headerValue(page, "{{nope}} {{$uuid}}");
  for (const [name, buttons] of [
    ["{{nope}}", ["Find usages"]],
    ["{{$uuid}}", []],
  ] as const) {
    await cell.locator(".cm-var", { hasText: name }).hover();
    await expect(card(page)).toBeVisible();
    await expect(card(page).getByRole("button")).toHaveText([...buttons]);
    await page.mouse.move(0, 0);
    await expect(card(page)).toHaveCount(0);
  }
});

test("autocomplete shows each name's source and value preview, never a Secret's value, then the dynamic variables", async ({ page }) => {
  await openSection(page, "Headers");
  const cell = page.locator(".kv-row").first().locator(".c-value");
  await cell.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("{{");

  const list = page.locator(".popup-layer .cm-tooltip-autocomplete");
  const option = (name: string) => list.getByRole("option").filter({ has: page.locator(".cm-completionLabel", { hasText: new RegExp(`^${name.replace(/[$.]/g, "\\$&")}$`) }) });
  await expect(option("baseUrl")).toContainText("environment");
  await expect(option("baseUrl")).toContainText("http://127.0.0.1:8765");
  await expect(option("version")).toContainText("shared");
  await expect(option("version")).toContainText("v1");
  await expect(option("token")).toContainText("environment");
  await expect(list).not.toContainText("dev-token-123");

  await page.keyboard.type("$rand");
  await expect(option("$randomInt")).toContainText("dynamic");
  await expect(option("$randomInt")).toContainText("[min max]");
  await expect(option("$randomInt")).toContainText("Random integer");
  await expect(option("$random.integer")).toContainText("(from, to)");
});

test("a dynamic variable that needs an argument leaves the caret for it", async ({ page }) => {
  await openSection(page, "Headers");
  const cell = page.locator(".kv-row").first().locator(".c-value");
  await cell.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("{{$processE");
  const list = page.locator(".popup-layer .cm-tooltip-autocomplete");
  await expect(list).toBeVisible();
  await expect(async () => {
    await page.keyboard.press("Enter");
    await expect(list).toBeHidden({ timeout: 200 });
  }).toPass();
  await page.keyboard.type("HOME");
  await expect(cell).toHaveText("{{$processEnv HOME}}");
});

test("a hover card fits a URL on one line, and only wraps a value too wide for it", async ({ page }) => {
  await openApp(page);
  // local's baseUrl becomes a typical URL, saved, so the request's cards show it.
  await page.getByRole("button", { name: "Manage environments" }).click();
  await showEnvironmentMatrix(page);
  const modal = page.getByRole("dialog", { name: "Environments" });
  await modal.getByRole("textbox", { name: "baseUrl in local", exact: true }).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("https://api.weather.gov");
  await page.keyboard.press("Tab");
  await modal.getByRole("button", { name: "Save" }).click();
  await expect(modal).toHaveCount(0);
  await openRequest(page, ["api", "pets.http"], "List pets");

  /** How many lines a part of the card's text takes (the line boxes' distinct tops). */
  const lines = (part: Locator) =>
    part.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
    });
  const onOneLine = async () => {
    await expect(card(page).locator(".var-card-value")).toHaveText("https://api.weather.gov");
    // In WebKit (the macOS webview) CodeMirror positions its tooltips absolutely in the
    // popup layer, which has no size, so the card gets no width from what contains it.
    // Laid out like that here too, it still has to fit.
    await card(page).evaluate((el) => (el.parentElement!.style.position = "absolute"));
    expect(await lines(card(page).locator(".var-card-value"))).toBe(1);
    await expect(card(page).locator(".var-card-source")).toHaveText('from environment "local"');
    expect(await lines(card(page).locator(".var-card-source"))).toBe(1);
  };

  // The URL bar's card (an editor's).
  await urlBar(page).locator(".cm-var", { hasText: "{{baseUrl}}" }).hover();
  await onOneLine();
  await page.mouse.move(0, 0);
  await expect(card(page)).toHaveCount(0);

  // A grid cell's static rendering has its own.
  const cell = await headerValue(page, "{{baseUrl}}");
  await cell.locator(".cm-var").hover();
  await onOneLine();
  await page.mouse.move(0, 0);
  await expect(card(page)).toHaveCount(0);

  // A value wider than the card can be wraps, and the card stays in the window.
  const long = `https://api.weather.gov/${"gridpoints/".repeat(12)}forecast`;
  await page.locator(".subtab", { hasText: "Settings" }).click();
  await page.getByPlaceholder("Add variable").click();
  await page.keyboard.type("petId");
  await page.keyboard.press("Tab");
  await page.keyboard.type(long);
  const petId = await headerValue(page, "{{petId}}");
  await petId.locator(".cm-var").hover();
  await expect(card(page).locator(".var-card-value")).toHaveText(long);
  expect(await lines(card(page).locator(".var-card-value"))).toBeGreaterThan(1);
  const box = (await card(page).boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(480);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});
