// The form-urlencoded and multipart bodies are edited in the shared key/value
// grid (#51): ghost row, delete with a tooltip, bulk edit, and an enable column
// (#41). A disabled field is a `#~` line in the body text (ADR-0003).
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openApp, openRequest, sentRequests } from "./helpers";

type Sent = { body: { mode: string; text: string } };

async function bodyOf(page: Page, mode: string): Promise<Locator> {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.getByRole("button", { name: "Body" }).click();
  await page.getByRole("radiogroup", { name: "Body type" }).getByRole("radio", { name: mode, exact: true }).click();
  return page.getByRole("group", { name: mode === "form-data" ? "Form-data parts" : "Form fields" });
}

async function send(page: Page): Promise<Sent["body"]> {
  // The button, not ⌘/Ctrl Enter: the shortcut lives in text fields, and a test may end on a checkbox.
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(async () => (await sentRequests(page)).length).toBeGreaterThan(0);
  const sent = (await sentRequests(page)) as unknown as Sent[];
  return sent[sent.length - 1].body;
}

/** Types a new row into the ghost row. */
async function addRow(grid: Locator, name: string, value: string): Promise<void> {
  await grid.getByPlaceholder("Add key").fill(name);
  await grid.locator(".kv-row:not(.ghost)").last().getByPlaceholder("Value").fill(value);
}

test("form-urlencoded fields are added in the ghost row, deleted and bulk-edited", async ({ page }) => {
  const grid = await bodyOf(page, "x-www-form-urlencoded");
  await addRow(grid, "name", "Rex");
  // Typing into the ghost row keeps focus there, and Tab moves on to its value.
  await grid.getByPlaceholder("Add key").click();
  await page.keyboard.type("tag");
  await expect(grid.locator("input.c-name").nth(1)).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.type("good dog");
  await expect(grid.locator(".kv-row:not(.ghost) input.c-name")).toHaveCount(2);
  await expect(grid.locator("input.c-value").nth(1)).toHaveValue("good dog");

  const del = grid.getByRole("button", { name: "Delete" }).first();
  await grid.locator(".kv-row").first().hover();
  await del.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Delete");
  await del.click();
  await expect(grid.locator(".kv-row:not(.ghost) input.c-name")).toHaveCount(1);
  await expect(grid.locator("input.c-name").first()).toHaveValue("tag");

  await grid.getByRole("button", { name: "Bulk edit" }).click();
  const text = grid.locator("textarea.bulk-text");
  await expect(text).toHaveValue("tag=good dog");
  await text.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\nage=3");
  await grid.getByRole("button", { name: "Key-value edit" }).click();
  await expect(grid.locator(".kv-row:not(.ghost) input.c-name")).toHaveCount(2);
  await expect(grid.locator("input.c-name").nth(1)).toHaveValue("age");

  const body = await send(page);
  expect(body.mode).toBe("formUrlEncoded");
  expect(body.text).toBe("tag=good%20dog\n&age=3");
});

test("multipart parts switch between text and file with the Select and take a content type", async ({ page }) => {
  const grid = await bodyOf(page, "form-data");
  await expect(grid.locator("select")).toHaveCount(0);

  await addRow(grid, "note", "hello");
  await grid.getByPlaceholder("Add key").fill("avatar");

  const kind = grid.getByRole("combobox", { name: "Type of avatar" });
  await expect(kind).toHaveText("Text");
  await kind.click();
  await page.getByRole("listbox", { name: "Type of avatar" }).getByRole("option", { name: "File" }).click();
  await expect(kind).toHaveText("File");

  const row = grid.locator(".kv-row").nth(1);
  await row.getByPlaceholder("./path/to/file").fill("./cat.png");
  await row.getByPlaceholder("auto").fill("image/png");

  // Back to text by keyboard, then to file again: the path is kept as the value.
  await kind.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(kind).toHaveText("Text");
  await expect(row.getByPlaceholder("./path/to/file")).toHaveCount(0);
  await kind.click();
  await page.getByRole("listbox", { name: "Type of avatar" }).getByRole("option", { name: "File" }).click();

  const body = await send(page);
  expect(body.mode).toBe("multipart");
  expect(body.text).toBe(
    [
      "--HttpDeskBoundary",
      'Content-Disposition: form-data; name="note"',
      "",
      "hello",
      "--HttpDeskBoundary",
      'Content-Disposition: form-data; name="avatar"; filename="cat.png"',
      "Content-Type: image/png",
      "",
      "< ./cat.png",
      "--HttpDeskBoundary--",
    ].join("\n"),
  );
});

test("multipart bulk edit keeps each part's type and content type", async ({ page }) => {
  const grid = await bodyOf(page, "form-data");
  await grid.getByPlaceholder("Add key").fill("avatar");
  await grid.getByRole("combobox", { name: "Type of avatar" }).click();
  await page.getByRole("listbox", { name: "Type of avatar" }).getByRole("option", { name: "File" }).click();
  await grid.getByPlaceholder("./path/to/file").fill("./cat.png");

  await grid.getByRole("button", { name: "Bulk edit" }).click();
  const text = grid.locator("textarea.bulk-text");
  await expect(text).toHaveValue("avatar: ./cat.png");
  await text.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\nnote: hi");
  await grid.getByRole("button", { name: "Key-value edit" }).click();

  await expect(grid.getByRole("combobox", { name: "Type of avatar" })).toHaveText("File");
  await expect(grid.getByRole("combobox", { name: "Type of note" })).toHaveText("Text");
  const body = await send(page);
  expect(body.text).toContain('name="avatar"; filename="cat.png"');
  expect(body.text).toContain('name="note"\n\nhi');
});

test("form fields can be disabled one at a time and stay in the body as #~ lines", async ({ page }) => {
  const grid = await bodyOf(page, "x-www-form-urlencoded");
  await addRow(grid, "a", "1");
  await addRow(grid, "b", "2");
  await addRow(grid, "c", "3");

  await grid.getByRole("checkbox", { name: "Enable a", exact: true }).click();
  await expect(grid.locator(".kv-row").first()).toHaveClass(/\boff\b/);
  await grid.getByRole("checkbox", { name: "Enable c" }).click();

  // The first field sent loses its `&`: JetBrains sends an empty body otherwise.
  const body = await send(page);
  expect(body.text).toBe("#~ a=1\nb=2\n#~ &c=3");

  await grid.getByRole("button", { name: "Bulk edit" }).click();
  await expect(grid.locator("textarea.bulk-text")).toHaveValue("//a=1\nb=2\n//c=3");
});

test("a multipart part can be disabled and is held as #~ lines", async ({ page }) => {
  const grid = await bodyOf(page, "form-data");
  await addRow(grid, "note", "hello");
  await addRow(grid, "debug", "true");

  await grid.getByRole("checkbox", { name: "Enable debug" }).click();
  await expect(grid.locator(".kv-row").nth(1)).toHaveClass(/\boff\b/);

  const body = await send(page);
  expect(body.text).toBe(
    [
      "--HttpDeskBoundary",
      'Content-Disposition: form-data; name="note"',
      "",
      "hello",
      "#~ --HttpDeskBoundary",
      '#~ Content-Disposition: form-data; name="debug"',
      "#~",
      "#~ true",
      "--HttpDeskBoundary--",
    ].join("\n"),
  );

  // Turning the whole body off and on keeps the part's own state.
  const bodySwitch = page.locator(".section-bar").filter({ hasText: "Body" }).getByRole("switch");
  await bodySwitch.click();
  await expect(bodySwitch).toHaveAttribute("aria-checked", "false");
  await bodySwitch.click();
  await expect(grid.getByRole("checkbox", { name: "Enable debug" })).not.toBeChecked();
  await expect(grid.getByRole("checkbox", { name: "Enable note" })).toBeChecked();
});
