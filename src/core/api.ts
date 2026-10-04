/** Comandos do TGPhotos: os comuns (`base`) mais a biblioteca de mídias. */
import { base } from "@tgcloud/ui/core/base";
import { invoke } from "@tgcloud/ui/core/server";

export { errText, fileUrl, getPort, setPort } from "@tgcloud/ui/core/server";
export type { Transfer, TransferState, Status, SyncReport, Vault } from "@tgcloud/ui/core/base";

/** Mídia (tempos em segundos; `taken_at` é UTC). */
export type Media = {
  id: number;
  name: string;
  mime: string;
  size: number;
  thumb: boolean;
  duration: number | null;
  width: number | null;
  height: number | null;
  taken_at: number;
  /** Fuso da captura em minutos, quando o arquivo diz. */
  tz: number | null;
  favorite: boolean;
  archived: boolean;
  trashed_at: number | null;
  added_at: number;
  lat: number | null;
  lon: number | null;
  /** Original neste aparelho (caminho ou URI), quando foi enviado daqui. */
  local: string | null;
  /** URL dos bytes no lugar de `/f/<id>` (original local ou mídia do aparelho). */
  src?: string;
  /** Mídia do aparelho fora do vault (id negativo): URI do MediaStore ou caminho. */
  uri?: string;
  /** Fora do vault: 0 = ainda não entrou na fila, 1 = na fila / enviando. */
  pending?: number;
  /** Miniatura pronta (item só do aparelho que está na lixeira: o arquivo saiu de vista). */
  cover?: string;
  /** Na lixeira do aparelho, sem cópia no vault (id negativo). */
  device?: boolean;
};

/** Item na lixeira do aparelho (registrado pelo app). */
export type DeviceTrash = {
  src: string;
  media_id: number | null;
  /** A mídia do vault ligada também está na lixeira. */
  media_trashed: boolean;
  name: string;
  mime: string;
  size: number;
  /** ms */
  taken: number;
  folder: string;
  stash: string | null;
  /** ms */
  trashed_at: number;
};
export type DeviceTrashIn = { src: string; name: string; mime: string; size: number; taken: number; folder?: string; stash?: string | null };
/** Original deste aparelho ligado a uma mídia do vault. */
export type DeviceLink = { src: string; media_id: number; trashed: boolean; size: number; name: string; mime: string };

/** Arquivo das pastas de backup ainda fora do vault (desktop). */
export type LocalItem = { uri: string; name: string; size: number; mime: string; path: string; taken: number; status: number };

export type Camera = {
  make?: string;
  model?: string;
  lens?: string;
  f?: number;
  exposure?: number;
  iso?: number;
  focal?: number;
};

export type Details = Media & {
  camera: Camera | null;
  origin: string | null;
  sha256: string | null;
  albums: { id: number; name: string }[];
};

export type Album = {
  id: number;
  name: string;
  count: number;
  cover: number | null;
  created_at: number;
  modified_at: number;
  first: number | null;
  last: number | null;
};

export type Usage = { photos: number; videos: number; bytes: number };

export type View = "timeline" | "favorites" | "videos" | "archive" | "trash";

export type BackupReport = { queued: number; scanned: number };

export const api = {
  ...base,
  list: (view: View) => invoke<Media[]>("media_list", { view }),
  details: (id: number) => invoke<Details | null>("media_details", { id }),
  search: (text: string) => invoke<Media[]>("search", { text }),
  usage: () => invoke<Usage>("usage"),

  setFavorite: (ids: number[], on: boolean) => invoke<void>("set_favorite", { ids, on }),
  setArchived: (ids: number[], on: boolean) => invoke<void>("set_archived", { ids, on }),
  trash: (ids: number[]) => invoke<void>("trash", { ids }),
  restore: (ids: number[]) => invoke<void>("restore", { ids }),
  setTaken: (id: number, taken: number, tz: number | null) => invoke<void>("set_taken", { id, taken, tz }),
  purge: (ids: number[]) => invoke<void>("purge", { ids }),
  emptyTrash: () => invoke<void>("empty_trash"),
  housekeep: () => invoke<number>("housekeep"),

  albums: () => invoke<Album[]>("albums"),
  albumMedia: (id: number) => invoke<Media[]>("album_media", { id }),
  albumCreate: (name: string, ids: number[]) => invoke<number>("album_create", { name, ids }),
  albumRename: (id: number, name: string) => invoke<void>("album_rename", { id, name }),
  albumDelete: (id: number) => invoke<void>("album_delete", { id }),
  albumAdd: (id: number, ids: number[]) => invoke<number>("album_add", { id, ids }),
  albumRemove: (id: number, ids: number[]) => invoke<void>("album_remove", { id, ids }),
  albumSetCover: (id: number, media: number) => invoke<void>("album_set_cover", { id, media }),

  backupFolders: () => invoke<string[]>("backup_folders"),
  /** Pastas mostradas na linha do tempo sem backup. */
  showFolders: () => invoke<string[]>("show_folders"),
  showSetFolder: (path: string, on: boolean) => invoke<void>("show_set_folder", { path, on }),
  backupSetFolder: (path: string, on: boolean) => invoke<void>("backup_set_folder", { path, on }),
  backupScan: () => invoke<BackupReport>("backup_scan"),
  backupEnqueue: (items: { uri: string; name: string; size: number; mime: string; path: string; modified: number }[], force = false) =>
    invoke<BackupReport>("backup_enqueue", { items, force }),
  /** 0 = fora do vault, 1 = na fila, 2 = no vault. */
  backupStatus: (srcs: string[]) => invoke<number[]>("backup_status", { srcs }),
  backupLocal: () => invoke<LocalItem[]>("backup_local"),
  localForget: (srcs: string[]) => invoke<void>("local_forget", { srcs }),
  localTrash: (paths: string[]) => invoke<number>("local_trash", { paths }),
  localFree: (paths: string[]) => invoke<number>("local_free", { paths }),
  localRestore: (paths: string[]) => invoke<number>("local_restore", { paths }),
  localPurge: (paths: string[]) => invoke<number>("local_purge", { paths }),
  /** Desktop: 1 = o arquivo existe, 0 = sumiu. */
  localStates: (paths: string[]) => invoke<number[]>("local_states", { paths }),

  /** Lixeira do aparelho: registra; devolve as mídias do vault ligadas. */
  deviceTrashAdd: (entries: DeviceTrashIn[]) => invoke<number[]>("device_trash_add", { entries }),
  deviceTrashList: () => invoke<DeviceTrash[]>("device_trash_list"),
  deviceTrashRemove: (srcs: string[], moved: [string, string][] = []) => invoke<void>("device_trash_remove", { srcs, moved }),
  deviceLinks: () => invoke<DeviceLink[]>("device_links"),
  localOpen: (path: string, reveal: boolean) => invoke<void>("local_open", { path, reveal }),
};
