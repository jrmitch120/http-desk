// About HttpDesk and the Help menu's links. The links open in the browser
// through the opener plugin, whose capability allows only the project's GitHub
// pages (src-tauri/capabilities/default.json).
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage } from "./api";
import { app } from "./store.svelte";
import type { AppInfo } from "./types";

const REPO = "https://github.com/jrmitch120/http-desk";
export const DOCUMENTATION_URL = `${REPO}#readme`;
export const RELEASE_NOTES_URL = `${REPO}/releases`;

let info: Promise<AppInfo> | null = null;

/** This HttpDesk's version, OS and architecture (asked of the shell once). */
export function appInfo(): Promise<AppInfo> {
  info ??= api.appInfo().catch((e) => {
    info = null;
    throw e;
  });
  return info;
}

/** "HttpDesk 0.1.3 (macos aarch64)": what About's Copy button copies, for a bug report. */
export function versionLine(i: AppInfo): string {
  return `HttpDesk ${i.version} (${i.os} ${i.arch})`;
}

/** A new GitHub issue with the version, OS and architecture filled in. */
export function reportIssueUrl(i: AppInfo): string {
  const body = `**Version:** ${versionLine(i)}\n\n**What happened?**\n\n\n**What did you expect?**\n\n\n**Steps to reproduce**\n\n`;
  return `${REPO}/issues/new?body=${encodeURIComponent(body)}`;
}

/** Opens `url` in the browser, saying so in a toast if it can't. */
export function openLink(url: string): Promise<void> {
  return openUrl(url).catch((e) => app.toast("error", `Couldn't open ${url}: ${errorMessage(e)}`));
}

export async function reportIssue(): Promise<void> {
  try {
    await openLink(reportIssueUrl(await appInfo()));
  } catch (e) {
    app.toast("error", errorMessage(e));
  }
}
