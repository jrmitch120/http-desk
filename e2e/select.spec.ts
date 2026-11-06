// The owned Select (#44): the method, environment, auth type and API-key
// location dropdowns. A combobox trigger opens a listbox in the shared popup
// layer; typing filters it.
import { expect, test, type Page } from "@playwright/test";
import { openApp, openRequest, sentRequests } from "./helpers";

const method = (page: Page) => page.getByRole("combobox", { name: "HTTP method" });
const methodList = (page: Page) => page.getByRole("listbox", { name: "HTTP method" });

async function lastSentMethod(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(async () => (await sentRequests(page)).length).toBeGreaterThan(0);
  const sent = await sentRequests(page);
  return sent[sent.length - 1].method;
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
});

test("the method can be picked with the mouse", async ({ page }) => {
  await expect(method(page)).toHaveText("GET");
  await expect(methodList(page)).toHaveCount(0);

  await method(page).click();
  await expect(method(page)).toHaveAttribute("aria-expanded", "true");
  await methodList(page).getByRole("option", { name: "DELETE" }).click();

  await expect(methodList(page)).toHaveCount(0);
  await expect(method(page)).toHaveText("DELETE");
  expect(await lastSentMethod(page)).toBe("DELETE");
});

test("the method can be picked with the keyboard", async ({ page }) => {
  await method(page).focus();

  // Type-ahead filters; the first match is highlighted and Enter picks it.
  await page.keyboard.type("pa");
  await expect(methodList(page).getByRole("option")).toHaveText(["PATCH"]);
  await expect(methodList(page).getByRole("option", { name: "PATCH" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(methodList(page)).toHaveCount(0);
  await expect(method(page)).toHaveText("PATCH");
  await expect(method(page)).toBeFocused();

  // Arrows move from the current method.
  await page.keyboard.press("ArrowDown");
  await expect(methodList(page).getByRole("option", { name: "PATCH" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  const del = methodList(page).getByRole("option", { name: "DELETE" });
  await expect(del).toHaveAttribute("aria-selected", "true");
  await expect(method(page)).toHaveAttribute("aria-activedescendant", (await del.getAttribute("id"))!);
  await page.keyboard.press("Enter");
  await expect(method(page)).toHaveText("DELETE");

  // Escape closes without changing anything.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Escape");
  await expect(methodList(page)).toHaveCount(0);
  await expect(method(page)).toHaveText("DELETE");
  await expect(method(page)).toBeFocused();
  expect(await lastSentMethod(page)).toBe("DELETE");
});

test("Enter and Space open the list, and Tab closes it without a change", async ({ page }) => {
  await method(page).focus();
  for (const key of ["Enter", "Space"]) {
    await page.keyboard.press(key);
    await expect(methodList(page)).toBeVisible();
    await expect(methodList(page).getByRole("option", { name: "GET" })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Tab");
    await expect(methodList(page)).toHaveCount(0);
    await expect(method(page)).toHaveText("GET");
    await method(page).focus();
  }
});

test("each method is listed in its colour", async ({ page }) => {
  await method(page).click();
  for (const [m, cls] of [["GET", "m-get"], ["POST", "m-post"], ["DELETE", "m-delete"], ["OPTIONS", "m-options"]]) {
    const expected = await page.evaluate((c) => {
      const probe = document.createElement("span");
      probe.className = c;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }, cls);
    await expect(methodList(page).getByRole("option", { name: m })).toHaveCSS("color", expected);
  }
});

test('typing a new method token offers "Use …" and picks it, uppercased', async ({ page }) => {
  await method(page).focus();
  await page.keyboard.type("purge");
  await expect(methodList(page).getByRole("option")).toHaveText(["Use PURGE"]);
  await page.keyboard.press("Enter");
  await expect(method(page)).toHaveText("PURGE");
  expect(await lastSentMethod(page)).toBe("PURGE");

  // A non-standard method in use stays in the list, and there's no "Custom…" item.
  await method(page).click();
  await expect(methodList(page).getByRole("option")).toHaveText(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "PURGE"]);
});

test("the environment picker filters as you type and selects with Enter", async ({ page }) => {
  const env = page.getByRole("combobox", { name: "Active environment" });
  const list = page.getByRole("listbox", { name: "Active environment" });
  await expect(env).toHaveText("local");
  await expect(list).toHaveCount(0);

  await env.focus();
  await page.keyboard.type("st");
  await expect(list.getByRole("option")).toHaveText(["staging"]);
  await page.keyboard.press("Enter");
  await expect(list).toHaveCount(0);
  await expect(env).toHaveText("staging");

  await env.click();
  await expect(list.getByRole("option")).toHaveText(["No environment", "local", "staging"]);
  await list.getByRole("option", { name: "No environment" }).click();
  await expect(env).toHaveText("No environment");
});

test("the environment picker moves with the arrow keys, and Escape closes it without a change", async ({ page }) => {
  const env = page.getByRole("combobox", { name: "Active environment" });
  const list = page.getByRole("listbox", { name: "Active environment" });
  const option = (name: string) => list.getByRole("option", { name, exact: true });
  await env.focus();

  // ArrowDown opens at the current environment, then moves (clamped at the ends).
  await page.keyboard.press("ArrowDown");
  await expect(option("local")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(option("staging")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(option("No environment")).toHaveAttribute("aria-selected", "true");
  await expect(env).toHaveAttribute("aria-activedescendant", (await option("No environment").getAttribute("id"))!);

  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(env).toHaveText("local");
  await expect(env).toBeFocused();

  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(list).toHaveCount(0);
  await expect(env).toHaveText("staging");
});

test("auth type and API-key location use the same Select", async ({ page }) => {
  await page.getByRole("button", { name: "Authorization" }).click();
  const kind = page.getByRole("combobox", { name: "Authorization type" });
  await expect(kind).toHaveText("Bearer Token");

  await kind.focus();
  await page.keyboard.type("api");
  await page.keyboard.press("Enter");
  await expect(kind).toHaveText("API Key");

  const location = page.getByRole("combobox", { name: "Add to" });
  await expect(location).toHaveText("Header");
  await location.click();
  await page.getByRole("listbox", { name: "Add to" }).getByRole("option", { name: "Query params" }).click();
  await expect(location).toHaveText("Query params");
  await expect(page.getByText("?<name>=<value>")).toBeVisible();
});

test('an invalid method token offers no "Use" item', async ({ page }) => {
  await method(page).focus();
  await page.keyboard.type("bad method");
  await expect(methodList(page).getByRole("option")).toHaveCount(0);
  await expect(page.getByText("No matches")).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(method(page)).toHaveText("GET");
});
