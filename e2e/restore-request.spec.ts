// Restore request (#157): a History entry's source text (the request as written in its
// file at send time) comes back into the request's tab as unsaved edits, its
// `{{variables}}` as written. A request no longer in its file comes back as a new
// unsaved request there. Nothing is written to the file until the user saves.
import { expect, test, type Page } from "@playwright/test";
import { activeTab, bodyEditor, mockState, openApp, openRequest, tab, urlBar } from "./helpers";

const PETS = "/demo/api/pets.http";
const status = (page: Page) => page.locator(".statusbar").first();
const entries = (page: Page) => page.getByRole("list", { name: "History entries" }).getByRole("listitem");
const restoreButton = (page: Page) => page.getByRole("button", { name: "Restore request" });

type DiskRequest = { name: string; url: string; headers: { items: { name: string; value: string }[] }; body: { text: string } };
/** pets.http's requests as last written "on disk" (the mock's saved file models). */
async function onDisk(page: Page): Promise<DiskRequest[]> {
  const files = (await mockState(page, "files")) as unknown as Record<string, { requests: DiskRequest[] }>;
  return files[PETS].requests;
}

async function send(page: Page) {
  await page.keyboard.press("Meta+Enter");
  await expect(status(page).locator(".metric", { hasText: "Size" })).toBeVisible({ timeout: 5000 });
}

async function setHeaders(page: Page, text: string) {
  await page.locator(".subtab", { hasText: "Headers" }).click();
  await page.getByRole("button", { name: "Bulk edit" }).click();
  await page.locator("textarea.bulk-text").fill(text);
  await page.getByRole("button", { name: "Key-value edit" }).click();
}

async function openHistoryEntry(page: Page, nth: number) {
  await page.getByRole("radiogroup", { name: "Response pane" }).getByRole("radio", { name: "History" }).click();
  await entries(page).nth(nth).getByRole("button").click();
}

test("restoring an older entry brings back its URL, headers and body as unsaved edits, variables as written", async ({ page }) => {
  // Create pet is `# @name createPet`, so its History follows it through a URL edit.
  await openApp(page, "?chain=1");
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await setHeaders(page, "Content-Type: application/json\nAuthorization: Bearer {{token}}");
  await page.keyboard.press("Meta+S");
  await send(page);

  // A later version: another URL and body, without the Authorization header.
  await urlBar(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type("/v2");
  await setHeaders(page, "Content-Type: application/json");
  await page.locator(".subtab", { hasText: "Body" }).click();
  await bodyEditor(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText('{"name": "Max"}');
  await page.keyboard.press("Meta+S");
  await expect(activeTab(page).locator(".dot")).toHaveCount(0);
  await send(page);

  await openHistoryEntry(page, 1);
  await restoreButton(page).click();

  await expect(urlBar(page)).toHaveText("{{baseUrl}}/pets");
  await expect(activeTab(page).locator(".dot")).toBeVisible();
  await page.locator(".subtab", { hasText: "Body" }).click();
  await expect(bodyEditor(page)).toContainText('"name": "Rex"');
  await page.locator(".subtab", { hasText: "Headers" }).click();
  const names = page.locator(".kv-row:not(.ghost) input.c-name");
  await expect(names).toHaveCount(2);
  await expect(names.last()).toHaveValue("Authorization");
  await expect(page.locator(".kv-row:not(.ghost) .c-value").last()).toHaveText("Bearer {{token}}");

  // The file keeps the later version until the user saves.
  let pet = (await onDisk(page))[1];
  expect([pet.url, pet.body.text]).toEqual(["{{baseUrl}}/pets/v2", '{"name": "Max"}']);
  await page.keyboard.press("Meta+S");
  await expect.poll(async () => (await onDisk(page))[1].url).toBe("{{baseUrl}}/pets");
  pet = (await onDisk(page))[1];
  expect(pet.headers.items.map((h) => `${h.name}: ${h.value}`)).toEqual(["Content-Type: application/json", "Authorization: Bearer {{token}}"]);
  expect(pet.body.text).toContain('"name": "Rex"');
});

test("restoring an entry whose request was deleted opens it as a new unsaved request in its file", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);

  // Another editor deletes List pets: its tab is left Orphaned.
  await page.evaluate((path) => {
    const mock = (window as unknown as { __mock: MockFiles }).__mock;
    const file = mock.files[path];
    mock.changeFile(path, { ...file, requests: file.requests.slice(1) });
  }, PETS);
  await expect(activeTab(page)).toHaveClass(/\borphaned\b/);

  await openHistoryEntry(page, 0);
  await restoreButton(page).click();

  await expect(tab(page, "List pets")).toHaveCount(2);
  await expect(activeTab(page)).not.toHaveClass(/\borphaned\b/);
  await expect(activeTab(page).locator(".dot")).toBeVisible();
  await expect(urlBar(page)).toHaveText("{{baseUrl}}/pets?limit=20");
  expect((await onDisk(page)).map((r) => r.name)).toEqual(["Create pet", "Get pet image"]);

  await page.keyboard.press("Meta+S");
  await expect.poll(async () => (await onDisk(page)).map((r) => r.name)).toEqual(["Create pet", "Get pet image", "List pets"]);
});

interface MockFiles {
  files: Record<string, { requests: unknown[] }>;
  changeFile: (path: string, file: unknown) => Promise<void>;
}
