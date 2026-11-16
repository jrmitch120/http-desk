// #141: the Scripts editor in a request's Settings. Inline JetBrains scripts are
// edited in CodeMirror with JavaScript highlighting and completion for the API
// HttpDesk implements; adding one writes a `< {% %}` / `> {% %}` block, an edit
// changes only the script's body, and each script carries a portability note.
// The mocked sample `samples/jetbrains.http` "Post with JSON body" has a handler;
// "List pets" has no scripts. `?trusted=1` trusts the demo workspace, and the
// mock reports each `client.test("name", …)` in a sent handler as a test.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockState, openApp, openRequest } from "./helpers";

const JETBRAINS = "/demo/samples/jetbrains.http";
const PETS = "/demo/api/pets.http";
const HANDLER = `> {%
    client.test("Request executed successfully", function() {
        client.assert(response.status === 200, "Response status is not 200");
    });
%}`;
const HANDLER_NOTE = "Runs in Rider; VS Code sends this as body text";
const PRE_REQUEST_NOTE = "Runs in Rider; breaks the request in VS Code";

const scripts = (page: Page) => page.getByRole("group", { name: "Scripts" });
const script = (page: Page, name: string) => scripts(page).getByRole("group", { name });
const editor = (page: Page, name: string) => script(page, name).locator(".cm-content");
const completions = (page: Page) => page.locator(".cm-tooltip-autocomplete li");

async function openSettings(page: Page, file: string[], name: string) {
  await openRequest(page, file, name);
  await page.locator(".subtab", { hasText: "Settings" }).click();
}

async function saved(page: Page, path: string, name: string) {
  await page.keyboard.press("Meta+S");
  await expect.poll(async () => Object.keys(await mockState(page, "files"))).toContain(path);
  const file = (await mockState(page, "files"))[path] as unknown as { requests: { name: string; preScript: string | null; responseHandler: string | null }[] };
  return file.requests.find((r) => r.name === name)!;
}

test("a request's handler shows in the Scripts editor with its note, and editing it changes only its body", async ({ page }) => {
  await openApp(page);
  await openSettings(page, ["samples", "jetbrains.http"], "Post with JSON body");
  const handler = script(page, "Response handler");
  await expect(handler).toHaveCount(1);
  await expect(editor(page, "Response handler")).toContainText('client.assert(response.status === 200, "Response status is not 200");');
  await expect(handler.getByText(HANDLER_NOTE)).toBeVisible();
  // JavaScript highlighting: a string isn't the colour of plain text.
  const colour = (l: Locator) => l.evaluate((el) => getComputedStyle(el).color);
  const text = await colour(editor(page, "Response handler").locator(".cm-line").first());
  await expect.poll(() => colour(editor(page, "Response handler").getByText('"Response status is not 200"'))).not.toBe(text);

  await editor(page, "Response handler").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n    // checked");
  const req = await saved(page, JETBRAINS, "Post with JSON body");
  expect(req.responseHandler).toBe(HANDLER.replace("    });\n%}", "    });\n    // checked\n%}"));
  // The note stays.
  await expect(handler.getByText(HANDLER_NOTE)).toBeVisible();
});

test("adding a pre-request script and a handler writes JetBrains blocks, each with its note, and sending runs the handler", async ({ page }) => {
  await openApp(page, "?trusted=1");
  await openSettings(page, ["api", "pets.http"], "List pets");
  await expect(script(page, "Response handler")).toHaveCount(0);

  await scripts(page).getByRole("button", { name: "Add response handler" }).click();
  await expect(editor(page, "Response handler")).toBeFocused();
  await page.keyboard.insertText('client.test("Listed", function () { client.assert(response.status === 200, "not 200"); });');
  await scripts(page).getByRole("button", { name: "Add pre-request script" }).click();
  await expect(editor(page, "Pre-request script")).toBeFocused();
  await page.keyboard.insertText("const started = Date.now();");

  await expect(script(page, "Response handler").getByText(HANDLER_NOTE)).toBeVisible();
  await expect(script(page, "Pre-request script").getByText(PRE_REQUEST_NOTE)).toBeVisible();

  const req = await saved(page, PETS, "List pets");
  expect(req.responseHandler).toBe('> {%\nclient.test("Listed", function () { client.assert(response.status === 200, "not 200"); });\n%}');
  expect(req.preScript).toBe("< {%\nconst started = Date.now();\n%}");

  await page.getByRole("button", { name: "Send", exact: true }).click();
  const testsTab = page.getByRole("radiogroup", { name: "Response tabs" }).getByRole("radio", { name: /^Tests\b/ });
  await testsTab.click();
  await expect(page.getByTestId("test-result")).toContainText("Listed");
  await expect(page.getByTestId("test-result").getByLabel("Passed")).toBeVisible();
});

test("removing a script takes it out of the request", async ({ page }) => {
  await openApp(page);
  await openSettings(page, ["samples", "jetbrains.http"], "Post with JSON body");
  await script(page, "Response handler").getByRole("button", { name: "Remove response handler" }).click();
  await expect(script(page, "Response handler")).toHaveCount(0);
  expect((await saved(page, JETBRAINS, "Post with JSON body")).responseHandler).toBeNull();
});

test("completion offers the client and response API HttpDesk implements, and nothing it doesn't", async ({ page }) => {
  await openApp(page);
  await openSettings(page, ["api", "pets.http"], "List pets");
  await scripts(page).getByRole("button", { name: "Add response handler" }).click();

  await page.keyboard.type("client.");
  await expect(completions(page).first()).toBeVisible();
  const offered = await completions(page).allTextContents();
  expect(offered.some((o) => o.startsWith("test"))).toBe(true);
  expect(offered.some((o) => o.startsWith("assert"))).toBe(true);
  expect(offered.some((o) => o.startsWith("exit"))).toBe(false);
  await page.keyboard.type("te");
  // Enter picks once the list has caught up with what was typed, and CodeMirror's
  // interactionDelay (75 ms after the list changes) has passed; before that it
  // inserts a line break instead.
  await expect(completions(page)).toHaveText([/^test/]);
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await expect(editor(page, "Response handler")).toHaveText("client.test");

  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("response.headers.v");
  await expect(completions(page)).toHaveText([/^valueOf/, /^valuesOf/]);
  await page.keyboard.press("Escape");

  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("crypto.");
  await page.keyboard.press("Control+Space");
  await expect(completions(page)).toHaveCount(0);
});
