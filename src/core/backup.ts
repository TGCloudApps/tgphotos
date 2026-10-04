/**
 * Backup automático. Desktop: o Rust varre as pastas observadas (também a
 * cada 5 min sozinho). Android: as mídias das pastas escolhidas vêm do
 * MediaStore pela ponte e vão para o Rust, que enfileira só o que é novo.
 *
 * Roda ao abrir, ao voltar ao primeiro plano e (Android) quando o sistema
 * avisa que entrou foto/vídeo novo.
 */
import { create } from "zustand";
import { android, available as onAndroid } from "@tgcloud/ui/core/android";
import { notify } from "@tgcloud/ui/core/notices";
import { refreshSoon } from "@tgcloud/ui/core/refresh";
import { api } from "./api";
import { loadLibrary } from "./library";

type State = {
  /** Pastas com backup automático (sempre aparecem em Fotos). */
  folders: string[];
  /** Pastas só mostradas em Fotos, sem backup. */
  shown: string[];
  running: boolean;
  last: number | null;
};

export const useBackup = create<State>(() => ({ folders: [], shown: [], running: false, last: null }));

const CONFIGURED = "backup-configured";

/** O usuário já passou pela tela de backup (para não insistir no convite). */
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
    /* sem armazenamento: o convite volta na próxima sessão */
  }
}

export async function loadFolders() {
  const [folders, shown] = await Promise.all([api.backupFolders(), api.showFolders().catch(() => [] as string[])]);
  useBackup.setState({ folders, shown });
  return folders;
}

/** Mostrar (ou não) uma pasta em Fotos sem fazer backup dela. */
export async function setShown(path: string, on: boolean) {
  await api.showSetFolder(path, on);
  await loadFolders();
  void loadLibrary();
}

export async function setFolder(path: string, on: boolean) {
  markConfigured();
  await api.backupSetFolder(path, on);
  await loadFolders();
  // A pasta entra (ou sai) da linha do tempo na hora, antes de qualquer envio.
  void loadLibrary();
  if (on) void runBackup(true);
}

let pending: Promise<void> | null = null;

/** Uma rodada (não sobrepõe). `loud` avisa mesmo quando não há nada novo. */
export function runBackup(loud = false): Promise<void> {
  pending ??= (async () => {
    useBackup.setState({ running: true });
    try {
      const folders = await loadFolders();
      if (!folders.length) {
        if (loud) notify({ text: "Nenhuma pasta no backup automático", tone: "neutral" });
        return;
      }
      let queued = 0;
      if (onAndroid) {
        if (!android.hasMedia()) return;
        const access = android.mediaAccess();
        if (!access.full && !access.partial) return;
        // A listagem do MediaStore é síncrona na ponte: sai do caminho do primeiro quadro.
        await new Promise((r) => setTimeout(r, 0));
        const items = android.mediaScan(folders);
        if (items.length) queued = (await api.backupEnqueue(items)).queued;
      } else {
        queued = (await api.backupScan()).queued;
      }
      useBackup.setState({ last: Date.now() });
      if (queued) {
        refreshSoon();
        notify({ text: `Backup: ${queued} ${queued === 1 ? "item novo" : "itens novos"} na fila de envio`, tone: "info" });
      } else if (loud) notify({ text: "Backup em dia", tone: "success" });
    } catch (e) {
      if (loud) notify({ text: `Backup falhou: ${e instanceof Error ? e.message : String(e)}`, tone: "danger" });
      else console.warn("[tgphotos] backup", e);
    } finally {
      useBackup.setState({ running: false });
      pending = null;
    }
  })();
  return pending;
}

/** Liga os gatilhos (uma vez por sessão do app). */
let started = false;
export function startBackup() {
  if (started) return;
  started = true;
  void runBackup();
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void runBackup());
  window.addEventListener("tg-media-changed", () => void runBackup());
}
