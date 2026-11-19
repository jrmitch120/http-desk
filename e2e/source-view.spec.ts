// The .http button shows a request's source in place of its sections. Like the
// Resolved toggle, it's an app setting: it stays on across tabs, sends and restarts.
import { expect, test, type Page } from "@playwright/test";
import { mockState, openApp, openRequest, tab } from "./helpers";

const toggle = (page: Page) => page.getByRole("button", { name: ".http", exact: true });
const source = (page: Page) => page.locator(".source-code");

test("the .http source stays shown across tabs, sends and a reload, and is remembered", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");

  await toggle(page).click();
  await expect(source(page)).toContainText("### List pets");
  expect((await mockState(page, "settings")).showSource).toBe(true);

  // Another request, then back to the first tab.
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(source(page)).toContainText("### Create pet");
  await tab(page, "List pets").click();
  await expect(source(page)).toContainText("### List pets");

  // A send keeps it.
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".statusbar .metric").first()).toBeVisible();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");

  await page.reload();
  await openRequest(page, ["api", "pets.http"], "List pets");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(source(page)).toContainText("### List pets");

  await toggle(page).click();
  await expect(source(page)).toHaveCount(0);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  expect((await mockState(page, "settings")).showSource).toBe(false);
});

test("the .http source is highlighted: the method, a header name, a variable by its state and a JSON key", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await toggle(page).click();
  await expect(source(page)).toContainText('"name": "Rex"');

  // Read in one go in the page and retried, as a re-rendered mark reads as missing for a moment.
  const colours = () =>
    page.evaluate(() => {
      const content = document.querySelector(".source-code .cm-content")!;
      /** The colour the text `text` is drawn in: that of the innermost element holding exactly it. */
      const colour = (text: string) => {
        const els = [...content.querySelectorAll("span")].filter((s) => s.textContent === text);
        const inner = els.find((s) => !els.some((o) => o !== s && s.contains(o)));
        return inner ? getComputedStyle(inner).color : null;
      };
      const varOk = getComputedStyle(document.documentElement).getPropertyValue("--var-ok").trim();
      const probe = document.createElement("span");
      probe.style.color = varOk;
      document.body.append(probe);
      const defined = getComputedStyle(probe).color;
      probe.remove();
      return {
        plain: getComputedStyle(content).color,
        method: colour("POST"),
        header: colour("Content-Type"),
        key: colour('"name"'),
        variable: colour("{{baseUrl}}"),
        defined,
      };
    });
  await expect
    .poll(async () => {
      const c = await colours();
      const problems = [];
      if (!c.method || c.method === c.plain) problems.push("method plain");
      if (!c.header || c.header === c.plain || c.header === c.method) problems.push("header name not highlighted as one");
      if (!c.key || c.key === c.plain) problems.push("JSON key plain");
      if (c.variable !== c.defined) problems.push(`variable ${c.variable}, not the defined colour ${c.defined}`);
      return problems.join("; ") || "highlighted";
    })
    .toBe("highlighted");
  await expect(source(page).locator(".cm-var-ok", { hasText: "{{baseUrl}}" })).toBeVisible();
});
