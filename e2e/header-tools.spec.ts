// Headers tab tools (#70): filter by name, click a value to copy it, Copy all,
// and hover explanations of well-known caching, CORS and rate-limit headers.
// `?manyHeaders=1` makes the mocked response carry caching, CORS and rate-limit headers.
import { expect, test, type Page } from "@playwright/test";
import { openApp, openRequest } from "./helpers";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

/**
 * The mocked JSON response's headers with `?manyHeaders=1`, in response order.
 * Content-Length follows the mocked body, so it's compared as `N` (see `anyLength`).
 */
const HEADERS = [
  ["content-type", "application/json"],
  ["content-length", "N"],
  ["x-powered-by", "echo"],
  ["date", "Wed, 04 Nov 2026 07:00:00 GMT"],
  ["cache-control", "public, max-age=60"],
  ["etag", '"pets-v1"'],
  ["x-cache", "HIT"],
  ["access-control-allow-origin", "*"],
  ["ratelimit-remaining", "42"],
];

async function openHeaders(page: Page) {
  await openApp(page, "?manyHeaders=1");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+Enter");
  await page.getByRole("radiogroup", { name: "Response tabs" }).getByRole("radio", { name: /^Headers\b/ }).click();
}

const rows = (page: Page) => page.getByRole("table", { name: "Response headers" }).getByRole("row");
const names = (page: Page) => rows(page).locator(".k").allInnerTexts();
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
/** `text` with the Content-Length value written as `N`. */
const anyLength = (text: string) => text.replace(/^content-length: \d+$/m, "content-length: N");

test("typing in the filter shows only headers whose name matches; clearing it restores all", async ({ page }) => {
  await openHeaders(page);
  await expect(rows(page)).toHaveCount(HEADERS.length);

  const filter = page.getByRole("textbox", { name: "Filter headers" });
  await filter.fill("cache");
  await expect(rows(page)).toHaveCount(2);
  expect(await names(page)).toEqual(["cache-control", "x-cache"]);

  await filter.fill("CONTENT");
  expect(await names(page)).toEqual(["content-type", "content-length"]);

  await filter.fill("nothing-like-this");
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByText("No headers match")).toBeVisible();

  await filter.fill("");
  await expect(rows(page)).toHaveCount(HEADERS.length);
  expect(await names(page)).toEqual(HEADERS.map(([k]) => k));
});

test("clicking a value copies exactly that value, with a toast", async ({ page }) => {
  await openHeaders(page);
  await page.getByRole("button", { name: '"pets-v1"', exact: true }).click();
  expect(await clipboard(page)).toBe('"pets-v1"');
  await expect(page.getByText("Header value copied")).toBeVisible();

  await page.getByRole("button", { name: "public, max-age=60", exact: true }).click();
  expect(await clipboard(page)).toBe("public, max-age=60");
});

test("Copy all copies every header as Name: value lines in response order, even while filtering", async ({ page }) => {
  await openHeaders(page);
  await page.getByRole("textbox", { name: "Filter headers" }).fill("cache");
  await page.getByRole("button", { name: "Copy all headers" }).click();
  expect(anyLength(await clipboard(page))).toBe(HEADERS.map(([k, v]) => `${k}: ${v}`).join("\n"));
  await expect(page.getByText("Headers copied")).toBeVisible();
});

test("well-known headers are highlighted, and hovering Cache-Control explains it", async ({ page }) => {
  await openHeaders(page);
  const cacheControl = rows(page).locator(".k", { hasText: /^cache-control$/ });
  await expect(cacheControl.locator(".known")).toBeVisible();
  await expect(rows(page).locator(".k", { hasText: /^x-powered-by$/ }).locator(".known")).toHaveCount(0);

  await cacheControl.locator(".known").hover();
  await expect(page.getByRole("tooltip")).toContainText("Caching");
  await expect(page.getByRole("tooltip")).toContainText("max-age");
});
