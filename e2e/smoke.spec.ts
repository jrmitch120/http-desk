import { expect, test } from "@playwright/test";
import { openApp, openRequest, urlBar } from "./helpers";

test("opening a request from the mocked workspace shows its URL in the URL bar", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await expect(urlBar(page)).toHaveText("{{baseUrl}}/pets?limit=20");
});
