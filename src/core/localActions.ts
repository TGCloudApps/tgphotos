/**
 * Gerenciar fotos locais como uma galeria: excluir, mover de pasta, renomear,
 * abrir com outro app. Vale para o que está só no aparelho e para o original
 * local de uma mídia do vault.
 *
 * Android: pelo MediaStore, com a confirmação do sistema. Desktop: lixeira do
 * sistema operacional e o app padrão.
 */
import { android, available as onAndroid } from "@tgcloud/ui/core/android";
import { notify, notifyError } from "@tgcloud/ui/core/notices";
import { api, type Media } from "./api";
import { freeSpace, trashItems } from "./deviceTrash";
import { loadLibrary } from "./library";

/** O que as ações precisam de um item (mídia da linha do tempo ou da pasta do aparelho). */
type Local = Pick<Media, "mime"> & { uri?: string; local?: string | null };

/** Arquivo local da mídia (só no aparelho, ou original enviado daqui). */
export const localOf = (m: Local) => m.uri ?? m.local ?? null;

/** Avisa as telas abertas (pasta do aparelho) que o conteúdo local mudou. */
const changed = () => window.dispatchEvent(new Event("tg-local-changed"));

const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

/**
 * Excluir pela galeria: lixeira unificada (vault e aparelho juntos; restaurar
 * devolve aos dois — ver deviceTrash.ts). Devolve se foi.
 */
export const deleteLocal = (list: Media[]) => trashItems(list);

/** "Excluir do dispositivo" de mídias do vault: só a cópia daqui sai (como liberar espaço). */
export const freeLocal = (list: Media[]) => freeSpace(list.flatMap((m) => (m.local ? [{ src: m.local, size: m.size }] : [])));

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
