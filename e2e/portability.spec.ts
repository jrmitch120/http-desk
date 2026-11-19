// #170: lines that behave differently in VS Code or Rider. The .http source marks
// each in its gutter, and hovering the marker says what each editor does with it;
// the check strip notes how many lines differ in each editor. The classification
// is the core's portability table (crates/httpdesk-text/src/portability.rs), which
// the mock runs too (WASM).
import { expect, test, type Page } from "@playwright/test";
import { dialog, mockState, openApp, openRequest } from "./helpers";

const source = (page: Page) => page.locator(".source-code");
const strip = (page: Page) => page.getByRole("region", { name: "Pre-send checks" });

/** Shows the .http source in place of the sections. */
async function showSource(page: Page) {
  await page.getByRole("button", { name: ".http", exact: true }).click();
}

/** The gutter marker beside the source line that is exactly `text`, once there is one. */
async function markerOf(page: Page, text: string) {
  await expect(source(page).locator(".cm-line", { hasText: text })).toBeVisible();
  // A marker is beside its line: the one whose middle is within the line's height.
  const marker = async () => {
    const line = await source(page).locator(".cm-line").filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).boundingBox();
    const markers = source(page).locator(".cm-line-mark");
    for (let i = 0; i < (await markers.count()); i++) {
      const box = await markers.nth(i).boundingBox();
      if (line && box && box.y + box.height / 2 > line.y && box.y + box.height / 2 < line.y + line.height) return markers.nth(i);
    }
    return null;
  };
  await expect.poll(async () => !!(await marker())).toBe(true);
  return (await marker())!;
}

/** Hovers the gutter marker beside the source line that is exactly `text`, from off the editor. */
async function hoverMarkerOf(page: Page, text: string) {
  const marker = await markerOf(page, text);
  await page.mouse.move(0, 0);
  await marker.hover();
}

test("a response handler is marked: Rider runs it, VS Code ignores it, and the strip notes the lines", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["samples", "jetbrains.http"], "Post with JSON body");
  await showSource(page);

  await hoverMarkerOf(page, "> {%");
  await expect(page.getByRole("tooltip")).toHaveText("Rider runs this response handler; VS Code ignores the script and sends its lines as body text");

  // `# @timeout` is Rider's too; `# @no-redirect` works in both, so it isn't marked.
  await hoverMarkerOf(page, "# @timeout 30");
  await expect(page.getByRole("tooltip")).toHaveText("Rider uses this read timeout; VS Code ignores @timeout");
  await expect(source(page).locator(".cm-line-mark")).toHaveCount(2);

  await expect(strip(page).getByRole("note")).toHaveText("2 lines behave differently in VS Code: lines 3 and 13 of the .http source");
  // A note, not a problem: it doesn't block sending.
  await expect(strip(page).locator("li.note")).toHaveCount(1);
});

test("HttpDesk's own lines are marked as ignored by both editors, and the strip doesn't note them", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  // Turning Headers off writes `# @httpdesk-disabled headers` above the request line.
  await page.locator(".subtab", { hasText: "Headers" }).click();
  await page.locator(".section-bar", { hasText: "Headers" }).getByRole("switch").click();
  await showSource(page);

  await hoverMarkerOf(page, "# @httpdesk-disabled headers");
  await expect(page.getByRole("tooltip")).toHaveText("HttpDesk's own line (sections turned off): VS Code and Rider both ignore it");
  await hoverMarkerOf(page, "#~ &status=sold");
  await expect(page.getByRole("tooltip")).toHaveText("Turned off in HttpDesk: VS Code and Rider both ignore this line");

  // Both editors ignore them alike, so the request doesn't behave differently in either.
  await expect(strip(page)).toHaveCount(0);
});

test("the marks follow text typed in the source, even while it doesn't read as a request", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await showSource(page);

  // A Rider-only directive typed above the request line is marked, on the line typed.
  await source(page).locator(".cm-line", { hasText: "GET {{baseUrl}}/pets" }).click();
  await page.keyboard.press("Home");
  await page.keyboard.type("# @timeout 5\n");
  await hoverMarkerOf(page, "# @timeout 5");
  await expect(page.getByRole("tooltip")).toHaveText("Rider uses this read timeout; VS Code ignores @timeout");
  await expect(strip(page).getByRole("note")).toHaveText("1 line behaves differently in VS Code: line 6 of the .http source");

  // Text that doesn't parse leaves the request as it was; the marks stay on the text shown.
  await page.keyboard.type("# @no-log\n");
  await page.keyboard.press("End");
  await page.keyboard.type(" and more");
  await hoverMarkerOf(page, "# @no-log");
  await expect(page.getByRole("tooltip")).toHaveText("Rider keeps this request out of its history; VS Code ignores @no-log");
  await expect(strip(page).getByRole("note")).toHaveText("2 lines behave differently in VS Code: lines 6 and 7 of the .http source");
});

test("turning on portability warnings makes a handler line's marker and the strip's note warnings, at once", async ({ page }) => {
  await openApp(page);
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
