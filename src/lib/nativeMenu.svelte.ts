// Keeps the shell's native menu bar (src-tauri/src/menu.rs) in step with the
// app: sends the layout (src/lib/menuLayout.ts) at startup and again when Open
// Recent changes, pushes greyed-out and ticked state as it changes, and runs
// the commands of the items clicked.
import { untrack } from "svelte";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { app } from "./store.svelte";
import { canRun, command, runCommand } from "./commands";
import { modalOpen } from "./modal.svelte";
import { menuAction, menuLayout, nativeMenu, type ItemState, type MenuItemChange, type NativeEntry } from "./menuLayout";
import { currentOS } from "./platform";

/** An item's state now. Reactive: reads the store through the commands. */
function itemState(id: string): ItemState {
  const action = menuAction(id);
  switch (action?.kind) {
    case "command":
      return { enabled: canRun(action.id), checked: command(action.id).checked?.() ?? null };
    case "recent":
      return { enabled: !modalOpen(), checked: null };
    default:
      return { enabled: false, checked: null };
  }
}

/** What a click on item `id` does: runs its command if it can run now. */
function clicked(id: string) {
  const action = menuAction(id);
  if (action?.kind === "command") runCommand(action.id);
  else if (action?.kind === "recent" && !modalOpen()) void app.openWorkspace(action.path);
}

function itemIds(entries: NativeEntry[]): string[] {
  return entries.flatMap((e) => (e.kind === "item" ? [e.id] : e.kind === "submenu" ? itemIds(e.items) : []));
}

/** Starts keeping the native menu bar up to date, for the life of the page. */
export async function startNativeMenu(): Promise<void> {
  const os = currentOS();
  const layout = menuLayout(os);
  /** Each item's state as the shell has it. */
  let shown = new Map<string, ItemState>();
  /** Bumped when a new layout is sent, so the state pushes follow its items. */
  let version = $state(0);
  let lastRecents: string | null = null;

  await listen<{ id: string }>("menu", (e) => clicked(e.payload.id));

  $effect.root(() => {
    // The layout: sent at once, then again only when Open Recent changes (the
    // recents settle once the app has started and reopened the last workspace).
    $effect(() => {
      const recents = app.starting ? [] : app.otherRecentWorkspaces;
      const key = JSON.stringify(recents);
      if (key === lastRecents) return;
      lastRecents = key;
      untrack(() => {
        const menus = nativeMenu(layout, { os, recents, state: itemState });
        shown = new Map(itemIds(menus.flatMap((m) => m.items)).map((id) => [id, itemState(id)]));
        api.setMenu(menus).catch((e) => console.warn("set_menu failed", e));
        version++;
      });
    });
    // Item state: one batch of the values that changed.
    $effect(() => {
      void version;
      const changes: MenuItemChange[] = [];
      for (const [id, before] of shown) {
        const now = itemState(id);
        if (now.enabled === before.enabled && now.checked === before.checked) continue;
        changes.push({ id, ...(now.enabled !== before.enabled ? { enabled: now.enabled } : {}), ...(now.checked !== before.checked ? { checked: now.checked ?? false } : {}) });
        shown.set(id, now);
      }
      if (changes.length) api.setMenuState(changes).catch((e) => console.warn("set_menu_state failed", e));
    });
  });
}
