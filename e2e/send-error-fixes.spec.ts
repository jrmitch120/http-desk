// A failed send's panel offers the fix for its kind of error, before Retry.
// The mocked backend fails every send with `?sendError=<kind>`.
import { expect, test } from "@playwright/test";
import { openApp, openRequest, sentRequests } from "./helpers";

test("a TLS error opens Settings scrolled to TLS, and offers no way to turn verification off", async ({ page }) => {
  // Short enough that the TLS section starts below the fold of the Settings modal.
  await page.setViewportSize({ width: 1280, height: 480 });
  await openApp(page, "?sendError=tls");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("ControlOrMeta+Enter");

  const panel = page.getByRole("alert").filter({ hasText: "Secure connection failed" });
  await expect(panel.getByRole("button")).toHaveText(["Open Settings → TLS", "Retry"]);
  await panel.getByRole("button", { name: "Open Settings → TLS" }).click();

  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings.getByRole("region", { name: "TLS" })).toBeInViewport();
  await expect(settings.getByRole("switch", { name: "Verify server certificates" })).toBeChecked();
});

for (const kind of ["timeoutIdle", "timeoutConnect"]) {
  test(`a ${kind} error opens the request's Settings, where its timeouts are`, async ({ page }) => {
    await openApp(page, `?sendError=${kind}`);
    await openRequest(page, ["api", "pets.http"], "List pets");
    await expect(page.getByRole("textbox", { name: "Idle timeout" })).toBeHidden();
    await page.keyboard.press("ControlOrMeta+Enter");

    const panel = page.getByRole("alert").filter({ hasText: "Timed out" });
    await expect(panel.getByRole("button")).toHaveText(["Open request Settings", "Retry"]);
    await panel.getByRole("button", { name: "Open request Settings" }).click();

    await expect(page.locator(".subtab.active")).toHaveText("Settings");
    await expect(page.getByRole("textbox", { name: "Idle timeout" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Connection timeout" })).toBeVisible();
  });
}

test("an unresolved-variable error opens the environment picker, and Retry sends with the one picked", async ({ page }) => {
  // The mock fails this way only while no environment is selected.
  await openApp(page, "?sendError=unresolvedVariable");
  await openRequest(page, ["api", "pets.http"], "List pets");
  const picker = page.getByRole("combobox", { name: "Active environment" });
  await picker.click();
  await page.getByRole("option", { name: "No environment" }).click();
  await page.keyboard.press("ControlOrMeta+Enter");

  const panel = page.getByRole("alert").filter({ hasText: "Undefined variables in the URL" });
  await expect(panel.getByRole("button")).toHaveText(["Choose environment", "Retry"]);
  await panel.getByRole("button", { name: "Choose environment" }).click();

  const list = page.getByRole("listbox", { name: "Active environment" });
  await expect(list).toBeVisible();
  await expect(picker).toBeFocused();
  await list.getByRole("option", { name: "local" }).click();
  await expect(picker).toHaveText("local");

  await panel.getByRole("button", { name: "Retry" }).click();
  await expect(panel).toBeHidden();
  await expect(page.locator(".viewer").getByText("200 OK")).toBeVisible();
  expect(await sentRequests(page)).toHaveLength(2);
});
