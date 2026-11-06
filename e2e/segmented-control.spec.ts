import { expect, test, type Page } from "@playwright/test";
import { openApp, openRequest, sentRequests } from "./helpers";

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
