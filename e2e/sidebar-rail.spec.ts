// #218: the sidebar collapses from its own header to a rail of Explorer and History.
// The rail is a `nav` named "Sidebar": a button per view, the one the sidebar was last
// on marked. Clicking either opens the sidebar on that view, and dragging the
// sidebar's edge well past its minimum width snaps it to the rail.
import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./helpers";

const aside = (page: Page) => page.locator("aside");
const rail = (page: Page) => page.getByRole("navigation", { name: "Sidebar" });
const railButton = (page: Page, name: "Explorer" | "History") => rail(page).getByRole("button", { name, exact: true });
const collapseButton = (page: Page) => aside(page).getByRole("button", { name: "Collapse sidebar", exact: true });
const separator = (page: Page) => page.getByRole("separator", { name: "Resize sidebar" });

async function width(page: Page, selector: string): Promise<number> {
  return Math.round((await page.locator(selector).boundingBox())!.width);
}

async function expectRail(page: Page) {
  await expect(aside(page)).toBeHidden();
  await expect(separator(page)).toHaveCount(0);
  await expect(rail(page)).toBeVisible();
  const railWidth = await width(page, "nav.rail");
  expect(railWidth).toBeGreaterThanOrEqual(36);
  expect(railWidth).toBeLessThanOrEqual(44);
}

test("the Collapse sidebar button ends the sidebar header and collapses it to a rail of Explorer and History", async ({ page }) => {
  await openApp(page);
  await expect(rail(page)).toHaveCount(0);

  await collapseButton(page).click();
  await expectRail(page);
  await expect(rail(page).getByRole("button")).toHaveText(["", ""]);
  expect(await rail(page).getByRole("button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).toEqual(["Explorer", "History"]);
});

test("the collapse button follows a divider, and its tooltip shows the shortcut", async ({ page }) => {
  await openApp(page);
  const head = aside(page).locator(".head");
  // The last control in the header, after the divider.
  const last = head.locator("button").last();
  await expect(last).toHaveAccessibleName("Collapse sidebar");
  await expect(head.locator(".divider")).toBeVisible();
  const divider = (await head.locator(".divider").boundingBox())!;
  const button = (await last.boundingBox())!;
  expect(divider.x).toBeLessThan(button.x);

  await collapseButton(page).hover();
  await expect(page.getByRole("tooltip")).toHaveText("Collapse sidebar (⌘B)");
});

test("the collapse button's tooltip shows Ctrl+B on Windows and Linux", async ({ page }) => {
  await openApp(page, "?platform=linux");
  await collapseButton(page).hover();
  await expect(page.getByRole("tooltip")).toHaveText("Collapse sidebar (Ctrl+B)");
});

for (const view of ["Explorer", "History"] as const) {
  test(`the header fits at the minimum width on the ${view} view, the collapse button on its first row`, async ({ page }) => {
    await openApp(page);
    if (view === "History") await aside(page).getByRole("radio", { name: "History" }).click();
    await separator(page).focus();
    await page.keyboard.press("Home");
    await expect(separator(page)).toHaveAttribute("aria-valuenow", "200");

    const sidebar = (await aside(page).boundingBox())!;
    const collapse = (await collapseButton(page).boundingBox())!;
    const views = (await aside(page).getByRole("radiogroup", { name: "Sidebar" }).boundingBox())!;
    expect(collapse.x + collapse.width).toBeLessThanOrEqual(sidebar.x + sidebar.width);
    // On the view switch's row.
    expect(Math.abs(collapse.y + collapse.height / 2 - (views.y + views.height / 2))).toBeLessThanOrEqual(2);
    // Every header control inside the sidebar.
    for (const box of await aside(page).locator(".head button").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()))) {
      expect(box.right).toBeLessThanOrEqual(sidebar.x + sidebar.width);
    }
  });
}

test("a rail button opens the sidebar on its view with focus in it, and the mark follows the last-used view", async ({ page }) => {
  await openApp(page);
  await collapseButton(page).click();
  await expect(railButton(page, "Explorer")).toHaveAttribute("aria-current", "true");
  await expect(railButton(page, "History")).not.toHaveAttribute("aria-current", /.+/);

  await railButton(page, "History").click();
  await expect(aside(page)).toBeVisible();
  await expect(rail(page)).toHaveCount(0);
  await expect(aside(page).getByRole("radio", { name: "History" })).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("aside"))).toBe(true);

  await collapseButton(page).click();
  await expect(railButton(page, "History")).toHaveAttribute("aria-current", "true");
  await expect(railButton(page, "Explorer")).not.toHaveAttribute("aria-current", /.+/);

  // ⌘B reopens it on the marked view.
  await page.keyboard.press("Meta+B");
  await expect(aside(page).getByRole("radio", { name: "History" })).toHaveAttribute("aria-checked", "true");

  await collapseButton(page).click();
  await railButton(page, "Explorer").click();
  await expect(aside(page).getByRole("radio", { name: "Explorer" })).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("treeitem");
});

test("the rail's tooltips name the view, and the marked one shows the shortcut that reopens it", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+B");
  await railButton(page, "Explorer").hover();
  await expect(page.getByRole("tooltip")).toHaveText("Explorer (⌘B)");
  await page.mouse.move(600, 400);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await railButton(page, "History").hover();
  await expect(page.getByRole("tooltip")).toHaveText("History");
});

test("collapsing with focus in the sidebar moves it to the rail's marked button, and the keyboard reaches both", async ({ page }) => {
  await openApp(page);
  await aside(page).getByRole("radio", { name: "History" }).click();
  await collapseButton(page).focus();
  await page.keyboard.press("Enter");
  await expect(railButton(page, "History")).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  await expect(railButton(page, "Explorer")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(aside(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("treeitem");

  // ⌘B from the rail's button opens the sidebar with focus in the view.
  await page.keyboard.press("Meta+B");
  await expect(railButton(page, "Explorer")).toBeFocused();
  await page.keyboard.press("Meta+B");
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("treeitem");
});

for (const theme of ["dark", "light"] as const) {
  test(`the rail has the sidebar's colours in the ${theme} theme`, async ({ page }) => {
    await openApp(page, `?theme=${theme}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const sidebarBg = await aside(page).evaluate((el) => getComputedStyle(el).backgroundColor);
    await page.keyboard.press("Meta+B");
    expect(await rail(page).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(sidebarBg);
    // No bar beside the marked view: its colour marks it (topbar-toggles.spec.ts).
    for (const name of ["Explorer", "History"] as const) {
      expect(await railButton(page, name).evaluate((el) => getComputedStyle(el, "::before").content)).toBe("none");
    }
  });
}

/** Drags the sidebar's separator `dx` px (negative: narrower), releasing at the end. */
async function dragSeparator(page: Page, dx: number) {
  const box = (await separator(page).boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 8 });
  await page.mouse.up();
}

test.describe("drag to snap", () => {
  test("dragging the edge to the minimum width stops there; well past it, the sidebar snaps to the rail", async ({ page }) => {
    await openApp(page);
    // To 200 px and a little past: held at the minimum.
    await dragSeparator(page, -120);
    await expect(separator(page)).toHaveAttribute("aria-valuenow", "200");
    expect(await width(page, "aside")).toBe(200);

    // Half the minimum further: the rail.
    await dragSeparator(page, -130);
    await expectRail(page);
  });

  test("the rail shows while the drag is still under way, and stays on release", async ({ page }) => {
    await openApp(page);
    const box = (await separator(page).boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x, y);
    await page.mouse.down();
    await page.mouse.move(box.x - 200, y, { steps: 8 });
    await expectRail(page);
    await page.mouse.up();
    await expectRail(page);
  });

  test("a snap saves no width: the sidebar reopens at the width it had, after a reload too", async ({ page }) => {
    await openApp(page);
    await separator(page).focus();
    await page.keyboard.press("ArrowRight");
    await expect(separator(page)).toHaveAttribute("aria-valuenow", "296");
    await dragSeparator(page, -260);
    await expectRail(page);

    await page.keyboard.press("Meta+B");
    await expect(separator(page)).toHaveAttribute("aria-valuenow", "296");
    expect(await width(page, "aside")).toBe(296);

    await dragSeparator(page, -280);
    await expectRail(page);
    await page.reload();
    await expect(rail(page)).toBeVisible();
    await expectRail(page);
    await railButton(page, "Explorer").click();
    await expect(separator(page)).toHaveAttribute("aria-valuenow", "296");
  });

  test("dragging the rail's edge outward opens the sidebar at its saved width", async ({ page }) => {
    await openApp(page);
    await page.keyboard.press("Meta+B");
    await expectRail(page);
    const box = (await rail(page).boundingBox())!;
    const [x, y] = [box.x + box.width, box.y + box.height / 2];
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 60, y, { steps: 6 });
    await page.mouse.up();
    await expect(aside(page)).toBeVisible();
    await expect(rail(page)).toHaveCount(0);
    await expect(separator(page)).toHaveAttribute("aria-valuenow", "280");
    expect(await width(page, "aside")).toBe(280);
  });

  test("the keyboard keeps the split's limits: Home stops at the minimum, no snap", async ({ page }) => {
    await openApp(page);
    await separator(page).focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(separator(page)).toHaveAttribute("aria-valuenow", "200");
    await expect(aside(page)).toBeVisible();
    await expect(rail(page)).toHaveCount(0);
  });
});
