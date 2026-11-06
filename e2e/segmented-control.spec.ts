import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialog, openApp, openRequest, sentRequests } from "./helpers";

type Sent = { body: { mode: string }; headers: { items: { name: string; value: string }[] } };

function bodyModes(page: Page) {
  return page.getByRole("radiogroup", { name: "Body type" });
}

async function lastSent(page: Page): Promise<Sent> {
  await expect.poll(async () => (await sentRequests(page)).length).toBeGreaterThan(0);
  const sent = (await sentRequests(page)) as unknown as Sent[];
  return sent[sent.length - 1];
}

function contentType(req: Sent): string | undefined {
  return req.headers.items.find((h) => h.name.toLowerCase() === "content-type")?.value;
}

/** Picks `option` in a radiogroup, checks screen readers see exactly that one
 *  checked, and returns how the group and its checked option look. */
async function pick(group: Locator, option: string): Promise<string> {
  await group.getByRole("radio", { name: option, exact: true }).click();
  await expect(group.getByRole("radio", { checked: true })).toHaveCount(1);
  await expect(group.getByRole("radio", { checked: true })).toHaveAccessibleName(option);
  return group.evaluate((el) => {
    // Not the group's size: the body type picker has eight options and wraps in a narrow pane.
    const props = ["padding", "border", "border-radius", "background-color", "font-size", "font-weight", "color", "box-shadow"];
    const look = (e: Element, extra: string[] = []) => [...extra, ...props].map((p) => getComputedStyle(e).getPropertyValue(p)).join(";");
    const option = (checked: boolean) => look(el.querySelector(`[aria-checked="${checked}"]`)!, ["height"]);
    return `${look(el)} | ${option(true)} | ${option(false)}`;
  });
}

test("the body type is picked with the mouse and sent with the request", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.getByRole("button", { name: "Body" }).click();

  const modes = bodyModes(page);
  await modes.getByRole("radio", { name: "XML" }).click();
  await expect(modes.getByRole("radio", { name: "XML" })).toHaveAttribute("aria-checked", "true");
  await expect(modes.getByRole("radio", { checked: true })).toHaveCount(1);

  await page.keyboard.press("ControlOrMeta+Enter");
  const req = await lastSent(page);
  expect(req.body.mode).toBe("xml");
  expect(contentType(req)).toBe("application/xml");
});

test("the arrow keys move between body types, selecting as they go", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.getByRole("button", { name: "Body" }).click();

  const modes = bodyModes(page);
  const radio = (name: string) => modes.getByRole("radio", { name, exact: true });
  await radio("JSON").click();

  await page.keyboard.press("ArrowRight");
  await expect(radio("XML")).toBeFocused();
  await expect(radio("XML")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ArrowRight");
  await expect(radio("Text")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(radio("XML")).toBeFocused();
  await page.keyboard.press("End");
  await expect(radio("Raw")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ArrowRight");
  await expect(radio("none")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(radio("File")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(radio("form-data")).toBeFocused();
  await expect(modes.getByRole("radio", { checked: true })).toHaveCount(1);

  // Only the checked option is a Tab stop.
  await expect(modes.locator('[tabindex="0"]')).toHaveCount(1);
  await expect(radio("form-data")).toHaveAttribute("tabindex", "0");

  await page.keyboard.press("ControlOrMeta+Enter");
  const req = await lastSent(page);
  expect(req.body.mode).toBe("multipart");
  expect(contentType(req)).toMatch(/^multipart\/form-data; boundary=/);
});

test("the response view and Settings switches are the same radiogroup", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.getByRole("button", { name: "Body" }).click();
  const look = await pick(bodyModes(page), "JSON");
  await pick(bodyModes(page), "none");

  await page.keyboard.press("ControlOrMeta+Enter");
  const view = page.getByRole("radiogroup", { name: "Response view" });
  expect(await pick(view, "Raw")).toBe(look);
  await expect(page.locator(".body .cm-content")).toContainText('{"items":[');
  await pick(view, "Pretty");

  await page.keyboard.press("ControlOrMeta+Comma");
  const settings = dialog(page, "Settings");
  expect(await pick(settings.getByRole("radiogroup", { name: "Theme" }), "Light")).toBe(look);
  expect(await pick(settings.getByRole("radiogroup", { name: "Layout" }), "Response below")).toBe(look);
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("separator", { name: "Resize request and response" })).toHaveAttribute(
    "aria-orientation",
    "horizontal",
  );
});

test("the OpenAPI importer's switches are the same radiogroup", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.getByRole("button", { name: "Body" }).click();
  const look = await pick(bodyModes(page), "JSON");

  await page.getByRole("button", { name: "Import OpenAPI" }).first().click();
  const importer = dialog(page, "Import OpenAPI specification");
  const source = importer.getByRole("radiogroup", { name: "Specification source" });
  await pick(source, "URL");
  await expect(importer.getByPlaceholder(/^https:/)).toBeVisible();
  expect(await pick(source, "File")).toBe(look);
  await importer.getByPlaceholder("/path/to/openapi.yaml").fill("/demo/openapi.yaml");
  await page.keyboard.press("Enter");

  const grouping = importer.getByRole("radiogroup", { name: "Organize files by" });
  expect(await pick(grouping, "Single file")).toBe(look);
  await expect(importer.getByText(/→ 1 file$/)).toBeVisible();
});
