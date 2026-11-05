// In-app updates via tauri-plugin-updater. Releases publish a signed
// `latest.json` (see .github/workflows/release.yml); the app checks it on
// startup (if enabled) and from Settings → Check now.
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { app } from "./store.svelte";
import { errorMessage } from "./api";

class Updates {
  checking = $state(false);
  /** Download progress 0..1 while installing, otherwise null. */
  progress = $state<number | null>(null);

  /** `manual` reports "up to date" and errors; the startup check stays quiet. */
  async check(manual: boolean) {
    if (this.checking || this.progress !== null) return;
    this.checking = true;
    let update: Update | null = null;
    try {
      update = await check();
    } catch (e) {
      if (manual) app.toast("error", `Couldn't check for updates: ${errorMessage(e)}`);
      else console.warn("update check failed", e);
      return;
    } finally {
      this.checking = false;
    }
    if (!update) {
      if (manual) app.toast("success", "HttpDesk is up to date.");
      return;
    }
    await this.offer(update);
  }

  private async offer(update: Update) {
    const dirty = app.dirtyDocs().length;
    const notes = update.body?.trim() ? `\n\n${update.body.trim()}` : "";
    const saveNote = dirty ? `\n\nYour unsaved changes will be saved first.` : "";
    const r = await app.choose(
      `HttpDesk ${update.version} is available`,
      `You have version ${update.currentVersion}. HttpDesk will restart to finish the update.${saveNote}${notes}`,
      [
        { label: "Later", value: "later" },
        { label: dirty ? "Save, install and restart" : "Install and restart", value: "install", primary: true },
      ],
    );
    if (r.button !== "install") return;

    if (dirty) {
      await app.saveAll();
      if (app.dirtyDocs().length) {
        app.toast("error", "Update cancelled because some files couldn't be saved.");
        return;
      }
    }

    let total = 0;
    let done = 0;
    this.progress = 0;
    try {
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") {
          done += e.data.chunkLength;
          this.progress = total ? Math.min(1, done / total) : 0;
        } else if (e.event === "Finished") this.progress = 1;
      });
      // Windows exits during install; macOS and Linux need an explicit restart.
      await relaunch();
    } catch (e) {
      app.toast("error", `Update failed: ${errorMessage(e)}`);
    } finally {
      this.progress = null;
    }
  }
}

export const updates = new Updates();
