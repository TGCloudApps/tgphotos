/**
 * Gerenciar fotos locais como uma galeria: excluir, mover de pasta, renomear,
 * abrir com outro app. Vale para o que está só no aparelho e para o original
 * local de uma mídia do vault (excluir aqui libera espaço; o vault continua).
 *
 * Android: pelo MediaStore, com a confirmação do sistema (Android 11+ manda
 * para a lixeira do sistema, recuperável por 30 dias). Desktop: lixeira do
 * sistema operacional e o app padrão.
 */
import { android, available as onAndroid } from "@tgcloud/ui/core/android";
import { notify, notifyError } from "@tgcloud/ui/core/notices";
import { api, type Media } from "./api";
import { refresh } from "./data";
import { loadLibrary } from "./library";
import { nav } from "./nav";

/** O que as ações precisam de um item (mídia da linha do tempo ou da pasta do aparelho). */
type Local = Pick<Media, "mime"> & { uri?: string; local?: string | null };

/** Arquivo local da mídia (só no aparelho, ou original enviado daqui). */
export const localOf = (m: Local) => m.uri ?? m.local ?? null;

/** Avisa as telas abertas (pasta do aparelho) que o conteúdo local mudou. */
const changed = () => window.dispatchEvent(new Event("tg-local-changed"));

const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

async function after(srcs: string[]) {
  await api.localForget(srcs).catch(() => {});
  void loadLibrary();
  void refresh();
  changed();
}

/**
 * Exclui do aparelho. Android: o sistema confirma. Desktop: pede confirmação
 * aqui (camada) e manda para a lixeira do sistema. Devolve se excluiu.
 */
export async function deleteLocal(list: Local[]): Promise<boolean> {
  const srcs = list.map(localOf).filter((s): s is string => !!s);
  if (!srcs.length) return false;
  if (!onAndroid) {
    nav.open({ type: "local-trash", paths: srcs });
    return false;
  }
  try {
    const r = await android.deviceTrash(srcs);
    if (!r.ok) {
      if (r.error) notify({ text: r.error, tone: "danger" });
      return false;
    }
    await after(srcs);
    notify({ text: `${plural(srcs.length, "Item excluído", "itens excluídos")} do aparelho`, tone: "neutral" });
    return true;
  } catch (e) {
    notifyError(e);
    return false;
  }
}

/** Desktop: depois da confirmação, lixeira do sistema operacional. */
export async function trashLocalPaths(paths: string[]) {
  try {
    const n = await api.localTrash(paths);
    void loadLibrary();
    void refresh();
    changed();
    notify({ text: `${plural(n, "Arquivo movido", "arquivos movidos")} para a lixeira do sistema`, tone: "neutral" });
  } catch (e) {
    notifyError(e);
  }
}

export async function moveLocal(srcs: string[], folder: string) {
  try {
    const r = await android.deviceMove(srcs, folder);
    if (!r.ok) {
      if (r.error) notify({ text: r.error, tone: "danger" });
      return;
    }
    // Mesmo item do MediaStore em outra pasta: só a listagem muda.
    void loadLibrary();
    changed();
    notify({ text: `${plural(srcs.length, "Item movido", "itens movidos")} para ${folder.split("/").pop()}`, tone: "neutral" });
  } catch (e) {
    notifyError(e);
  }
}

export async function renameLocal(src: string, name: string) {
  try {
    const r = await android.deviceRename(src, name);
    if (!r.ok) {
      if (r.error) notify({ text: r.error, tone: "danger" });
      return;
    }
    void loadLibrary();
    changed();
  } catch (e) {
    notifyError(e);
  }
}

/** Abrir com outro app / editar / definir como (Android); app padrão ou pasta (desktop). */
export function openLocal(m: Local, how: "view" | "edit" | "attach" | "reveal") {
  const src = localOf(m);
  if (!src) return;
  if (onAndroid) {
    if (!android.deviceIntent(src, m.mime, how === "reveal" ? "view" : how)) notify({ text: "Nenhum app aceitou", tone: "danger" });
    return;
  }
  void api.localOpen(src, how === "reveal").catch(notifyError);
}
