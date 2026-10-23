/**
 * Automatic backup. Desktop: Rust scans the watched folders (also every
 * 5 min on its own). Android: the media in the chosen folders comes from
 * MediaStore through the bridge and goes to Rust, which queues only what is new.
 *
 * Runs on open, when returning to the foreground and (Android) when the system
 * reports a new photo/video.
 */
import { create } from "zustand";
import { android, available as onAndroid } from "@tgcloud/ui/core/android";
import { notify } from "@tgcloud/ui/core/notices";
import { refreshSoon } from "@tgcloud/ui/core/refresh";
import { confirmAction } from "@tgcloud/ui/ui/Confirm";
import { currentVault } from "@tgcloud/ui/core/vault";
import { api } from "./api";
import { loadLibrary } from "./library";
import { errText } from "@tgcloud/ui/core/server";
import { t } from "../i18n";

type State = {
  /** Folders with automatic backup (always appear in Photos). */
  folders: string[];
  /** Folders only shown in Photos, without backup. */
  shown: string[];
  running: boolean;
  last: number | null;
};

export const useBackup = create<State>(() => ({ folders: [], shown: [], running: false, last: null }));

const CONFIGURED = "backup-configured";

/** The user already went through the backup screen (so the invite is not repeated). */
export function backupConfigured() {
  try {
    return localStorage.getItem(CONFIGURED) === "1";
  } catch {
    return true;
  }
}

export function markConfigured() {
  try {
    localStorage.setItem(CONFIGURED, "1");
  } catch {
    /* no storage: the invite returns in the next session */
  }
}

export async function loadFolders() {
  const [folders, shown] = await Promise.all([api.backupFolders(), api.showFolders().catch(() => [] as string[])]);
  useBackup.setState({ folders, shown });
  return folders;
}

/** Show (or not) a folder in Photos without backing it up. */
export async function setShown(path: string, on: boolean) {
  await api.showSetFolder(path, on);
  await loadFolders();
  void loadLibrary();
}

/**
 * Turns the backup of a folder on/off. Turning it on asks for confirmation
 * (responsibility gate: everything in the folder goes to the open vault); turning
 * it off removes from the queue what came from it and has not uploaded yet.
 * Returns whether it changed.
 */
export async function setFolder(path: string, on: boolean): Promise<boolean> {
  if (on) {
    const name = path.split(/[\\/]/).filter(Boolean).pop() || path || t("backup.root");
    const count = onAndroid ? android.mediaFolders().find((f) => f.path === path)?.count : undefined;
    const vault = currentVault()?.name ?? t("backup.thisVault");
    const ok = await confirmAction({
      title: t("backup.enableTitle"),
      body:
        (count !== undefined ? t("backup.enableBodyCount", { n: count, name, vault }) : t("backup.enableBodyAll", { name, vault })) +
        (count !== undefined && count > 500 ? " " + t("backup.enableBodyMany") : ""),
      cta: t("backup.enableCta"),
    });
    if (!ok) return false;
  }
  markConfigured();
  const canceled = await api.backupSetFolder(path, on);
  if (!on && canceled > 0) notify({ text: t("backup.disabled", { n: canceled }), tone: "neutral" });
  await loadFolders();
  // The folder enters (or leaves) the timeline right away, before any upload.
  void loadLibrary();
  if (on) void runBackup(true);
  return true;
}

let pending: Promise<void> | null = null;

/** One round (no overlap). `loud` notifies even when there is nothing new. */
export function runBackup(loud = false): Promise<void> {
  pending ??= (async () => {
    useBackup.setState({ running: true });
    try {
      const folders = await loadFolders();
      if (!folders.length) {
        if (loud) notify({ text: t("backup.noFolders"), tone: "neutral" });
        return;
      }
      let queued = 0;
      if (onAndroid) {
        if (!android.hasMedia()) return;
        const access = android.mediaAccess();
        if (!access.full && !access.partial) return;
        // The MediaStore listing is synchronous on the bridge: get it off the first-frame path.
        await new Promise((r) => setTimeout(r, 0));
        const items = android.mediaScan(folders);
        if (items.length) queued = (await api.backupEnqueue(items)).queued;
      } else {
        queued = (await api.backupScan()).queued;
      }
      useBackup.setState({ last: Date.now() });
      if (queued) {
        refreshSoon();
        notify({ text: t("backup.queued", { n: queued }), tone: "info" });
      } else if (loud) notify({ text: t("backup.upToDate"), tone: "success" });
    } catch (e) {
      if (loud) notify({ text: t("backup.failed", { error: errText(e) }), tone: "danger" });
      else console.warn("[tgphotos] backup", e);
    } finally {
      useBackup.setState({ running: false });
      pending = null;
    }
  })();
  return pending;
}

/** Wires the triggers (once per app session). */
let started = false;
export function startBackup() {
  if (started) return;
  started = true;
  void runBackup();
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void runBackup());
  window.addEventListener("tg-media-changed", () => void runBackup());
}
