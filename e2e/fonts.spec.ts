import { expect, test, type Page } from "@playwright/test";
import { bodyEditor, openApp, openRequest } from "./helpers";

/** Families of the font faces that have finished loading, once the document's fonts are ready. */
function loadedFamilies(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/^"|"$/g, ""));
  });
}

test("body text uses the bundled Inter and the code editor the bundled JetBrains Mono", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await page.getByRole("button", { name: "Body" }).click();
  await expect(bodyEditor(page)).toBeVisible();

  const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  const editorFont = await bodyEditor(page).evaluate((el) => getComputedStyle(el).fontFamily);
  expect(bodyFont).toMatch(/^"?Inter"?,/);
  expect(editorFont).toMatch(/^"?JetBrains Mono"?,/);

  await expect.poll(() => loadedFamilies(page)).toEqual(expect.arrayContaining(["Inter", "JetBrains Mono"]));
});

test("fonts are served from the app itself, never fetched from the network", async ({ page, baseURL }) => {
  const fontRequests: string[] = [];
  page.on("request", (req) => {
    if (req.resourceType() === "font") fontRequests.push(req.url());
  });
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await page.getByRole("button", { name: "Body" }).click();
  await expect.poll(() => loadedFamilies(page)).toEqual(expect.arrayContaining(["Inter", "JetBrains Mono"]));

  expect(fontRequests.length).toBeGreaterThan(0);
  for (const url of fontRequests) expect(new URL(url).origin).toBe(new URL(baseURL!).origin);
});
