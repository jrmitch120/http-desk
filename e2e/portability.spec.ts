// #170: lines that behave differently in VS Code or Rider. The .http source marks
// each in its gutter, and hovering the marker says what the editor it differs in does;
// the check strip notes how many lines differ in each editor. The classification
// is the core's portability table (crates/httpdesk-text/src/portability.rs), which
// the mock runs too (WASM).
import { expect, test, type Page } from "@playwright/test";
import { dialog, menuClick, mockState, openApp, openRequest, treeItem, treeMenu } from "./helpers";

/** Both editors turned on in Settings → Portability: their notes show. */
const BOTH = "?portability=vscode,rider";
const source = (page: Page) => page.locator(".source-code");
const strip = (page: Page) => page.getByRole("region", { name: "Pre-send checks" });

/** Shows the .http source in place of the sections. */
async function showSource(page: Page) {
  await page.getByRole("button", { name: ".http", exact: true }).click();
}

/** The gutter marker beside the line of `editor` (the source, by default) that is exactly `text`, once there is one. */
async function markerOf(page: Page, text: string, editor = source(page)) {
  await expect(editor.locator(".cm-line", { hasText: text })).toBeVisible();
  // A marker is beside its line: the one whose middle is within the line's height.
  const marker = async () => {
    const line = await editor.locator(".cm-line").filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).boundingBox();
    const markers = editor.locator(".cm-line-mark");
    for (let i = 0; i < (await markers.count()); i++) {
      const box = await markers.nth(i).boundingBox();
      if (line && box && box.y + box.height / 2 > line.y && box.y + box.height / 2 < line.y + line.height) return markers.nth(i);
    }
    return null;
  };
  await expect.poll(async () => !!(await marker())).toBe(true);
  return (await marker())!;
}

/** Hovers the gutter marker beside the line of `editor` that is exactly `text`, from off the editor. */
async function hoverMarkerOf(page: Page, text: string, editor = source(page)) {
  const marker = await markerOf(page, text, editor);
  await page.mouse.move(0, 0);
  await marker.hover();
}

test("a response handler is marked: Rider runs it, VS Code ignores it, and the strip notes the lines", async ({ page }) => {
  await openApp(page, BOTH);
  await openRequest(page, ["samples", "jetbrains.http"], "Post with JSON body");
  await showSource(page);

  await hoverMarkerOf(page, "> {%");
  await expect(page.getByRole("tooltip")).toHaveText("VS Code ignores this response handler and sends its lines as body text");

  // `# @timeout` is Rider's too; `# @no-redirect` works in both, so it isn't marked.
  await hoverMarkerOf(page, "# @timeout 30");
  await expect(page.getByRole("tooltip")).toHaveText("VS Code ignores @timeout");
  await expect(source(page).locator(".cm-line-mark")).toHaveCount(2);

  await expect(strip(page).getByRole("note")).toHaveText("2 lines behave differently in VS Code: lines 3 and 13 of the .http source");
  // A note, not a problem: it doesn't block sending.
  await expect(strip(page).locator("li.note")).toHaveCount(1);
});

test("HttpDesk-only lines are shaded as read only by HttpDesk, and the strip doesn't note them", async ({ page }) => {
  await openApp(page, BOTH);
  await openRequest(page, ["api", "pets.http"], "List pets");
  // Turning Headers off writes `# @httpdesk-disabled headers` above the request line.
  await page.locator(".subtab", { hasText: "Headers" }).click();
  await page.locator(".section-bar", { hasText: "Headers" }).getByRole("switch").click();
  await showSource(page);

  await hoverMarkerOf(page, "# @httpdesk-disabled headers");
  await expect(page.getByRole("tooltip")).toHaveText("Only HttpDesk reads this line (sections turned off)");
  await hoverMarkerOf(page, "#~ &status=sold");
  await expect(page.getByRole("tooltip")).toHaveText("Turned off in HttpDesk; other editors ignore this line too");

  // Both editors ignore them alike, so the request doesn't behave differently in either.
  await expect(strip(page)).toHaveCount(0);
});

test("the marks follow text typed in the source, even while it doesn't read as a request", async ({ page }) => {
  await openApp(page, BOTH);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await showSource(page);

  // A Rider-only directive typed above the request line is marked, on the line typed.
  await source(page).locator(".cm-line", { hasText: "GET {{baseUrl}}/pets" }).click();
  await page.keyboard.press("Home");
  await page.keyboard.type("# @timeout 5\n");
  // The note first: it's there once the typed text is read, so the marks are the ones
  // for it, not for a line half typed (`# @no-l` reads as a description; CI hovered that).
  await expect(strip(page).getByRole("note")).toHaveText("1 line behaves differently in VS Code: line 6 of the .http source");
  await hoverMarkerOf(page, "# @timeout 5");
  await expect(page.getByRole("tooltip")).toHaveText("VS Code ignores @timeout");

  // Text that doesn't parse leaves the request as it was; the marks stay on the text shown.
  await page.keyboard.type("# @no-log\n");
  await page.keyboard.press("End");
  await page.keyboard.type(" and more");
  await expect(strip(page).getByRole("note")).toHaveText("2 lines behave differently in VS Code: lines 6 and 7 of the .http source");
  await hoverMarkerOf(page, "# @no-log");
  await expect(page.getByRole("tooltip")).toHaveText("VS Code ignores @no-log and keeps this request in its history");
});

// #182: notes show only for the editors turned on in Settings → Portability, both off by default.
test("nothing is marked until an editor is turned on; turning on VS Code marks what it reads differently at once", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["samples", "jetbrains.http"], "Post with JSON body");
  await showSource(page);
  await menuClick(page, "toggle-problems");
  const problems = page.getByRole("region", { name: "Problems" });
  await expect(source(page).locator(".cm-line", { hasText: "> {%" })).toBeVisible();
  await expect(source(page).locator(".cm-line-mark")).toHaveCount(0);
  await expect(strip(page)).toHaveCount(0);
  await expect(problems).not.toContainText("behave differently");

  await page.keyboard.press("Meta+Comma");
  const settings = dialog(page, "Settings");
  const [vscode, rider] = [settings.getByRole("switch", { name: "VS Code" }), settings.getByRole("switch", { name: "Rider" })];
  const warnings = settings.getByRole("switch", { name: "Show portability notes as warnings" });
  await expect(vscode).toHaveAttribute("aria-checked", "false");
  await expect(rider).toHaveAttribute("aria-checked", "false");
  // No notes to raise: the warnings switch waits for an editor.
  await expect(warnings).toBeDisabled();
  await expect(settings.getByText("Turn on an editor above")).toBeVisible();

  await vscode.click();
  await expect.poll(async () => (await mockState(page, "settings")).portabilityEditors).toEqual({ vscode: true, rider: false });
  await expect(warnings).toBeEnabled();
  await settings.getByRole("button", { name: "Done" }).click();

  // The open request and the Problems panel follow without being reopened: VS Code's notes only.
  await expect(await markerOf(page, "> {%")).toHaveClass(/cm-line-mark-jetbrains-only/);
  await expect(strip(page).getByRole("note")).toHaveText("2 lines behave differently in VS Code: lines 3 and 13 of the .http source");
  await expect(problems.getByRole("group", { name: "samples/jetbrains.http" })).toContainText(/lines? behaves? differently in VS Code/);
  await expect(problems).not.toContainText("differently in Rider");

  // Rider in its place: the handler, which only Rider runs, isn't Rider's to note.
  await page.keyboard.press("Meta+Comma");
  await rider.click();
  await vscode.click();
  await expect.poll(async () => (await mockState(page, "settings")).portabilityEditors).toEqual({ vscode: false, rider: true });
  await settings.getByRole("button", { name: "Done" }).click();
  await expect(strip(page)).toHaveCount(0);
  await expect(problems).not.toContainText("differently in VS Code");

  // Turned off too, every mark goes, and the warnings switch waits again.
  await page.keyboard.press("Meta+Comma");
  await rider.click();
  await expect(warnings).toBeDisabled();
  await settings.getByRole("button", { name: "Done" }).click();
  await expect(source(page).locator(".cm-line-mark")).toHaveCount(0);
  await expect(strip(page)).toHaveCount(0);
  await expect(problems).not.toContainText("behave differently");
});

test("turning on portability warnings makes a handler line's marker and the strip's note warnings, at once", async ({ page }) => {
  await openApp(page, BOTH);
  await openRequest(page, ["samples", "jetbrains.http"], "Post with JSON body");
  await showSource(page);
  await expect(await markerOf(page, "> {%")).toHaveClass(/cm-line-mark-jetbrains-only/);
  await expect(strip(page).locator("li.note")).toHaveCount(1);

  await page.keyboard.press("Meta+Comma");
  const settings = dialog(page, "Settings");
  const warnings = settings.getByRole("switch", { name: "Show portability notes as warnings" });
  await expect(warnings).toHaveAttribute("aria-checked", "false");
  await warnings.click();
  await expect.poll(async () => (await mockState(page, "settings")).portabilityWarnings).toBe(true);
  await settings.getByRole("button", { name: "Done" }).click();

  // The open request follows without being reopened: the same lines, now warnings.
  await expect(await markerOf(page, "> {%")).toHaveClass(/cm-line-mark-warning/);
  await expect(strip(page).locator("li.note")).toHaveCount(0);
  await expect(strip(page).getByRole("note")).toHaveText("2 lines behave differently in VS Code: lines 3 and 13 of the .http source");
});

test("the file view marks the lines that behave differently too, each with what its editor does", async ({ page }) => {
  await openApp(page, BOTH);
  await treeItem(page, "samples").click();
  await treeMenu(page, "jetbrains.http", "View file as text");
  const fileView = page.locator(".file-view .file-code");
  await hoverMarkerOf(page, "> {%", fileView);
  await expect(page.getByRole("tooltip")).toHaveText("VS Code ignores this response handler and sends its lines as body text");

  // A sign-in token only VS Code fetches, and the example server only Rider has.
  await fileView.locator(".cm-line", { hasText: "> {%" }).first().click();
  await page.keyboard.press("Home");
  await page.keyboard.type("X-Token: {{$aadToken}}\nX-Server: {{$exampleServer}}\n");
  await hoverMarkerOf(page, "X-Token: {{$aadToken}}", fileView);
  await expect(page.getByRole("tooltip")).toHaveText("Rider doesn't know this sign-in variable and sends it as written");
  await hoverMarkerOf(page, "X-Server: {{$exampleServer}}", fileView);
  await expect(page.getByRole("tooltip")).toHaveText("VS Code doesn't know this variable and sends it as written");
});

test("Settings → Portability is a section of its own, holding the editor switches", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  // A named region, so a link can open Settings at it (#226; the bottom bar's Portability item, #230).
  const section = dialog(page, "Settings").getByRole("region", { name: "Portability" });
  await expect(section.getByRole("switch", { name: "VS Code" })).toBeVisible();
  await expect(section.getByRole("switch", { name: "Rider" })).toBeVisible();
  await expect(section.getByRole("switch", { name: "Show portability notes as warnings" })).toBeVisible();
});
