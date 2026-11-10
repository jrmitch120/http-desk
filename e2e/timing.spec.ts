// The Timing tab (#68): a waterfall of the final request's phases, from the
// mocked `timings` (`?timing=reused` gives a reused connection after redirects).
import { expect, test, type Page } from "@playwright/test";
import { openApp, openRequest } from "./helpers";

async function sendListPets(page: Page, query = ""): Promise<void> {
  await openApp(page, query);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByRole("radiogroup", { name: "Response tabs" })).toBeVisible();
}

function viewerTab(page: Page, name: string) {
  return page.getByRole("radiogroup", { name: "Response tabs" }).getByRole("radio", { name: new RegExp(`^${name}\\b`) });
}

const waterfall = (page: Page) => page.getByRole("list", { name: "Timing phases" });

test("the Timing tab draws each phase of a new connection as a bar", async ({ page }) => {
  await sendListPets(page);
  await viewerTab(page, "Timing").click();

  const rows = waterfall(page).getByRole("listitem");
  // Plain http, so the connect phase has no TLS in its name.
  await expect(rows).toHaveText([/DNS lookup\s*1\.4 ms/, /Connect\s*3\.6 ms/, /Waiting \(TTFB\)\s*25 ms/, /Content download\s*7\.0 ms/]);
  await expect(page.getByText("New connection")).toBeVisible();
  await expect(page.locator(".timing .total")).toHaveText(/Total\s*38 ms/);

  // The bars run one after another, in order.
  const boxes = await waterfall(page).locator(".bar").evaluateAll((bars) => bars.map((b) => b.getBoundingClientRect()));
  expect(boxes).toHaveLength(4);
  for (let i = 1; i < boxes.length; i++) expect(boxes[i].left).toBeGreaterThanOrEqual(boxes[i - 1].left + boxes[i - 1].width - 1);
});

test("a reused connection hides the DNS and connect phases and says so", async ({ page }) => {
  await sendListPets(page, "?timing=reused");
  await viewerTab(page, "Timing").click();

  const rows = waterfall(page).getByRole("listitem");
  await expect(rows).toHaveText([/Waiting \(TTFB\)/, /Content download/]);
  await expect(waterfall(page)).not.toContainText("DNS");
  await expect(waterfall(page)).not.toContainText("Connect");
  await expect(page.getByText("Reused connection")).toBeVisible();
  await expect(page.locator(".timing")).toContainText("including 2 redirects");
});

test("the Request tab shows the timing and says it is a reconstruction", async ({ page }) => {
  await sendListPets(page);
  await viewerTab(page, "Request").click();

  await expect(page.locator(".sent-timing")).toHaveText(/DNS lookup 1\.4 ms · Connect 3\.6 ms · Waiting \(TTFB\) 25 ms · Content download 7\.0 ms/);
  await expect(page.getByText("A reconstruction of the final request")).toBeVisible();
  await expect(page.getByText("This is exactly what was sent")).toHaveCount(0);
});
