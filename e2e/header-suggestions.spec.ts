// Header-name suggestions (#45): an owned combobox whose list renders in the
// shared popup layer and behaves like {{variable}} autocomplete.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openApp, openRequest, sentRequests, urlBar } from "./helpers";

// List pets has two headers (Accept, X-Debug), so the ghost row is the third.
async function newHeaderCell(page: Page): Promise<Locator> {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.locator(".subtab", { hasText: "Headers" }).click();
  await page.getByPlaceholder("Add header").click();
  return page.locator(".kv-row input.c-name").nth(2);
}

const suggestions = (page: Page) => page.getByRole("listbox", { name: "Header suggestions" });

test("typing part of a header name suggests matching names, and arrows plus Enter accept one", async ({ page }) => {
  const cell = await newHeaderCell(page);
  await page.keyboard.type("Cont");

  const list = suggestions(page);
  await expect(list).toBeVisible();
  // Names starting with the text first, then names containing it.
  await expect(list.getByRole("option")).toHaveText(["Content-Type", "Content-Length", "Cache-Control"]);
  await expect(cell).toHaveAttribute("aria-expanded", "true");
  await expect(list.getByRole("option", { name: "Content-Type" })).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("ArrowDown");
  await expect(list.getByRole("option", { name: "Content-Length" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");

  await expect(cell).toHaveValue("Content-Type");
  await expect(list).toBeHidden();
  await expect(cell).toBeFocused();
});

test("Escape dismisses the suggestions without changing the cell", async ({ page }) => {
  const cell = await newHeaderCell(page);
  await page.keyboard.type("Cont");
  await expect(suggestions(page)).toBeVisible();
  await page.keyboard.press("ArrowDown");

  await page.keyboard.press("Escape");
  await expect(suggestions(page)).toBeHidden();
  await expect(cell).toHaveValue("Cont");
  await expect(cell).toHaveAttribute("aria-expanded", "false");
  await expect(cell).toBeFocused();

  // Enter now leaves the text alone, and typing more opens the list again.
  await page.keyboard.press("Enter");
  await expect(cell).toHaveValue("Cont");
  await page.keyboard.type("ent-L");
  await expect(suggestions(page).getByRole("option")).toHaveText(["Content-Length"]);
});

test("Tab accepts the selected suggestion and moves on to the value", async ({ page }) => {
  const cell = await newHeaderCell(page);
  await page.keyboard.type("user");
  await page.keyboard.press("Tab");
  await expect(cell).toHaveValue("User-Agent");
  await expect(suggestions(page)).toBeHidden();
  await expect(page.locator(".kv-row input.c-value").nth(2)).toBeFocused();
});

test("clicking a suggestion accepts it, and the header is sent", async ({ page }) => {
  const cell = await newHeaderCell(page);
  await page.keyboard.type("x-req");
  await suggestions(page).getByRole("option", { name: "X-Request-Id" }).click();
  await expect(cell).toHaveValue("X-Request-Id");
  await expect(cell).toBeFocused();
  await expect(suggestions(page)).toBeHidden();

  await page.keyboard.press("Tab");
  await page.keyboard.type("abc");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("200 OK")).toBeVisible();
  const sent = (await sentRequests(page)) as unknown as { headers: { items: { name: string; value: string }[] } }[];
  expect(sent.at(-1)!.headers.items.at(-1)).toMatchObject({ name: "X-Request-Id", value: "abc" });
});

test("Ctrl+Space lists every suggestion in an empty cell", async ({ page }) => {
  await newHeaderCell(page);
  await page.keyboard.press("Control+Space");
  await expect(suggestions(page).getByRole("option").first()).toHaveText("Accept");
  expect(await suggestions(page).getByRole("option").count()).toBeGreaterThan(10);
});

test("the suggestion list looks identical to {{variable}} autocomplete and renders in the popup layer", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  const look = (surface: Locator) =>
    surface.evaluate((el) => {
      const pick = (e: Element | null, keys: string[]) => {
        const s = getComputedStyle(e!) as unknown as Record<string, string>;
        return Object.fromEntries(keys.map((k) => [k, s[k]]));
      };
      return {
        inLayer: !!el.closest(".popup-layer"),
        surface: pick(el, ["backgroundColor", "borderTopWidth", "borderTopStyle", "borderTopColor", "borderTopLeftRadius", "boxShadow", "color", "overflow"]),
        list: pick(el.querySelector("ul"), ["fontFamily", "fontSize", "paddingTop", "paddingLeft", "minWidth", "maxHeight", "whiteSpace"]),
        selected: pick(el.querySelector('li[aria-selected="true"]'), [
          "backgroundColor",
          "color",
          "paddingTop",
          "paddingLeft",
          "borderTopLeftRadius",
          "lineHeight",
          "cursor",
        ]),
        matched: pick(el.querySelector('li[aria-selected="true"] .cm-completionMatchedText, li[aria-selected="true"] .matched'), ["textDecorationLine"]),
      };
    });

  await urlBar(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type("?q={{ba");
  const variables = await look(page.locator(".cm-tooltip-autocomplete"));
  await page.keyboard.press("Escape");

  await page.locator(".subtab", { hasText: "Headers" }).click();
  await page.getByPlaceholder("Add header").click();
  await page.keyboard.type("Acc");
  const headers = await look(page.locator(".popup-surface", { has: suggestions(page) }));

  expect(headers).toEqual(variables);
  expect(headers.inLayer).toBe(true);
});

test("names without suggestions stay plain text fields", async ({ page }) => {
  await newHeaderCell(page);
  await page.locator(".subtab", { hasText: "Params" }).click();
  await page.getByPlaceholder("Add key").click();
  await page.keyboard.type("Cont");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(page.locator(".kv-row input.c-name").first()).not.toHaveAttribute("role", "combobox");
});
