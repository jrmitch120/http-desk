// Keeps the shell's native menu bar (src-tauri/src/menu.rs) in step with the
// app: sends the layout (src/lib/menuLayout.ts) at startup and again when Open
// Recent changes, pushes greyed-out and ticked state as it changes, and runs
// the commands of the items clicked.
import { untrack } from "svelte";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { app } from "./store.svelte";
import { canRun, command, isCommandId, runCommand } from "./commands";
import { modalOpen } from "./modal.svelte";
import { menuLayout, nativeMenu, RECENT_PREFIX, type ItemState, type NativeEntry } from "./menuLayout";
import { currentOS } from "./platform";

/** How many recent workspaces Open Recent lists (the top bar's workspace menu lists as many). */
const RECENTS = 8;

/** An item's state now. Reactive: reads the store through the commands. */
function itemState(id: string): ItemState {
  if (id.startsWith(RECENT_PREFIX)) return { enabled: !modalOpen(), checked: null };
  if (!isCommandId(id)) return { enabled: false, checked: null };
  return { enabled: canRun(id), checked: command(id).checked?.() ?? null };
}

/** What a click on item `id` does: runs its command if it can run now. */
function clicked(id: string) {
  if (id.startsWith(RECENT_PREFIX)) {
    if (!modalOpen()) void app.openWorkspace(id.slice(RECENT_PREFIX.length));
  } else if (isCommandId(id)) {
    runCommand(id);
  }
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
    // The layout: sent again only when Open Recent changes.
    $effect(() => {
      const recents = (app.settings?.recentWorkspaces ?? []).filter((w) => w !== app.root).slice(0, RECENTS);
      const key = JSON.stringify(recents);
      if (key === lastRecents) return;
      lastRecents = key;
      untrack(() => {
        const menus = nativeMenu(layout, { os, recents, state: itemState });
        shown = new Map(itemIds(menus.flatMap((m) => m.items)).map((id) => [id, itemState(id)]));
        invoke("set_menu", { layout: menus }).catch((e) => console.warn("set_menu failed", e));
        version++;
      });
    });
    // Item state: one batch of the values that changed.
    $effect(() => {
      void version;
      const changes: ({ id: string } & Partial<ItemState>)[] = [];
      for (const [id, before] of shown) {
        const now = itemState(id);
        if (now.enabled === before.enabled && now.checked === before.checked) continue;
        changes.push({ id, ...(now.enabled !== before.enabled ? { enabled: now.enabled } : {}), ...(now.checked !== before.checked ? { checked: now.checked ?? false } : {}) });
        shown.set(id, now);
      }
      if (changes.length) invoke("set_menu_state", { changes }).catch((e) => console.warn("set_menu_state failed", e));
    });
  });
}
