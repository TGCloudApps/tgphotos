/** Comandos do TGPhotos: os comuns (`base`) mais a biblioteca de mídias. */
import { base } from "@tgcloud/ui/core/base";
import { invoke } from "@tgcloud/ui/core/server";

export { errText, fileUrl, getPort, setPort } from "@tgcloud/ui/core/server";
export type { Transfer, TransferState, Status, SyncReport, Vault } from "@tgcloud/ui/core/base";

/** Mídia (tempos em segundos; `taken_at` é UTC). */
/** Inteligência de mídia (docs/inteligencia-de-midia.md). */
export type IntelSettings = {
  mode: "auto" | "charging" | "paused";
  min_battery: number;
  budget: number;
  search: boolean;
  people: boolean;
  text: boolean;
  places: boolean;
  duplicates: boolean;
  /** Miniaturas que faltam (fotos e vídeos) e tiras de quadros dos vídeos. */
  thumbs: boolean;
  /** Envia o que foi analisado aqui para os outros aparelhos. */
  share: boolean;
  /** Inclui dados de rosto nos pacotes. */
  share_faces: boolean;
};
export type IntelHold = "paused" | "not-charging" | "low-battery" | "saver" | "hot" | "in-use";
export type IntelStatus = {
  settings: IntelSettings;
  running: string | null;
  hold: IntelHold | null;
  rush: boolean;
  /** Há bateria (celular, notebook): mostra as opções de bateria. */
  battery: boolean;
  stages: { stage: string; done: number; total: number }[];
  /** Modelo de cada recurso ligado. */
  models: (ModelState & { stage: string })[];
  /** Rede medida: downloads esperam o Wi-Fi. */
  metered: boolean;
  /** Vault cifrado (os pacotes de análise vão cifrados). */
  encrypted: boolean;
  /** Pacotes de outros aparelhos ainda por importar. */
  packs_waiting: number;
};
export type ModelState = { name: string; state: "absent" | "downloading" | "ready" | "failed"; done: number; size: number; error: string | null };
/** Por que a busca por descrição ainda não cobre tudo. */
export type SemanticState = { state: "off" | "model" | "partial" | "error"; done: number; total: number; model: ModelState | null; error?: string | null };
/** `text` = o pedaço da busca que virou este filtro (o ✕ tira ele). */
export type IntelChip = { kind: "date" | "place" | "kind" | "album" | "person"; label: string; text: string };
/** Pessoa (rostos agrupados); `cover` = rosto do avatar. */
export type Person = { uid: string; name: string; hidden: boolean; cover: number | null; count: number };
/** Rosto numa foto: caixa relativa (0–1). */
export type MediaFace = { id: number; x: number; y: number; w: number; h: number; person: string | null; name: string | null; frame?: number | null };
/** Pergunta da revisão de pessoas. */
export type Review =
  | { kind: "face"; face: number; media: number; person: string; name: string; cover: number | null; score: number }
  | { kind: "loose"; a: number; b: number; score: number }
  | { kind: "pair"; a: string; b: string; a_name: string; b_name: string; a_cover: number | null; b_cover: number | null; score: number };
export type IntelResult = { items: Media[]; chips: IntelChip[]; semantic: boolean; semantic_state: SemanticState | null };

/** Mídia no feed dos Curtas: visualizações (todos os aparelhos) e curtida (não é favorito). */
export type Short = Media & { views: number; liked: boolean };

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
  /** Mídia do aparelho: 0 = sem backup, 1 = na fila / enviando, 2 = já no vault (pasta do aparelho). */
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

/** Conversa da conta (importar de chats). `key`: como o Rust a reconhece. */
export type ChatInfo = {
  key: string;
  title: string;
  kind: "saved" | "user" | "bot" | "group" | "forum" | "channel";
  /** Id da foto (texto: passa de 2^53). */
  photo: string | null;
  /** "Restringir salvamento": não dá para importar. */
  protected: boolean;
  /** Última mensagem (s). */
  date: number;
};
export type ChatPage = { chats: ChatInfo[]; next: string | null };
export type Topic = { id: number; title: string; color: number; closed: boolean };
/** Foto ou vídeo de um chat (id = mensagem; date = envio ao Telegram, s). */
export type ChatMedia = {
  id: number;
  date: number;
  video: boolean;
  mime: string;
  name: string;
  size: number;
  width: number;
  height: number;
  duration: number | null;
  thumb: boolean;
  protected: boolean;
  group: string | null;
};
export type MediaPage = { items: ChatMedia[]; next: number | null };
export type ChatImport = { chat: string; msg: number; name: string; mime: string; size: number; date: number };

export const api = {
  ...base,
  list: (view: View) => invoke<Media[]>("media_list", { view }),
  details: (id: number) => invoke<Details | null>("media_details", { id }),
  search: (text: string) => invoke<Media[]>("search", { text }),
  /** Busca da caixa única: filtros do texto, álbum e descrição. */
  peopleList: () => invoke<Person[]>("people_list"),
  personMedia: (uid: string) => invoke<Media[]>("person_media", { uid }),
  personFaces: (uid: string) => invoke<number[]>("person_faces", { uid }),
  personRename: (uid: string, name: string) => invoke<void>("person_rename", { uid, name }),
  personHide: (uid: string, on: boolean) => invoke<void>("person_hide", { uid, on }),
  personCover: (uid: string, face: number) => invoke<void>("person_cover", { uid, face }),
  personMerge: (into: string, from: string[]) => invoke<void>("person_merge", { into, from }),
  faceReject: (face: number) => invoke<void>("face_reject", { face }),
  facePut: (face: number, person: string | null, name: string | null) => invoke<string>("face_put", { face, person, name }),
  mediaFaces: (id: number) => invoke<MediaFace[]>("media_faces", { id }),
  dupGroups: () => invoke<{ key: string; kind: "exact" | "similar" | "burst"; best: number; items: Media[] }[]>("dup_groups"),
  dupKeep: (key: string) => invoke<void>("dup_keep", { key }),
  mapPoints: () => invoke<[number, number, number][]>("map_points"),
  mediaIntel: (id: number) => invoke<{ place: string | null; text: string | null; faces: MediaFace[] }>("media_intel", { id }),
  intelQuery: (text: string, album: number | null, semantic = true) => invoke<IntelResult>("intel_query", { text, album, semantic }),
  placesList: () => invoke<{ city: string; state: string; country: string; count: number; cover: number }[]>("places_list"),
  intelStatus: () => invoke<IntelStatus>("intel_status"),
  intelSet: (settings: IntelSettings) => invoke<void>("intel_set", { settings }),
  intelPower: (power: Record<string, unknown>) => invoke<void>("intel_power", { power }),
  intelTouch: () => invoke<void>("intel_touch"),
  intelBoost: (ids: number[]) => invoke<void>("intel_boost", { ids }),
  intelRush: (on: boolean) => invoke<void>("intel_rush", { on }),
  intelRetry: () => invoke<void>("intel_retry"),
  intelUsage: () => invoke<{ models: number; data: number }>("intel_usage"),
  intelReset: () => invoke<void>("intel_reset"),
  peopleReview: () => invoke<Review[]>("people_review"),
  reviewNo: (face: number | null, a: string, b: string) => invoke<void>("review_no", { face, a, b }),
  usage: () => invoke<Usage>("usage"),

  setFavorite: (ids: number[], on: boolean) => invoke<void>("set_favorite", { ids, on }),
  /** Curtas: próximas do feed (menos vistas, sorteadas), sem as de `skip`. */
  shortsNext: (skip: number[], limit: number) => invoke<Short[]>("shorts_next", { skip, limit }),
  shortsLiked: () => invoke<Short[]>("shorts_liked"),
  shortLike: (id: number, on: boolean) => invoke<void>("short_like", { id, on }),
  shortView: (id: number) => invoke<number>("short_view", { id }),
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
  /** Devolve quantos saíram da fila (ao desligar). */
  backupSetFolder: (path: string, on: boolean) => invoke<number>("backup_set_folder", { path, on }),
  backupScan: () => invoke<BackupReport>("backup_scan"),
  backupEnqueue: (items: { uri: string; name: string; size: number; mime: string; path: string; modified: number }[], force = false) =>
    invoke<BackupReport>("backup_enqueue", { items, force }),
  /** 0 = fora do vault, 1 = na fila, 2 = no vault. */
  backupStatus: (srcs: string[]) => invoke<number[]>("backup_status", { srcs }),
  backupLocal: () => invoke<LocalItem[]>("backup_local"),
  localForget: (srcs: string[]) => invoke<void>("local_forget", { srcs }),
  /** Download terminado: `src` (arquivo baixado) vira o original local da mídia `uid`. */
  localLink: (uid: string, src: string) => invoke<void>("local_link", { uid, src }),
  /** Tira do vault (lixeira dele) e mantém no aparelho, fora do backup automático. */
  excludeFromVault: (srcs: string[]) => invoke<number>("exclude_from_vault", { srcs }),
  localRelink: (items: { uri: string; name: string; size: number; mime: string; path: string; modified: number }[]) => invoke<number>("local_relink", { items }),
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

  chatToken: () => invoke<string>("chat_token"),
  chats: (cursor: string | null) => invoke<ChatPage>("chats", { cursor }),
  chatsSearch: (q: string) => invoke<ChatInfo[]>("chats_search", { q }),
  chatTopics: (chat: string) => invoke<Topic[]>("chat_topics", { chat }),
  /** Abaixo da mensagem `before` (0 = do começo). */
  chatMedia: (chat: string, topic: number | null, before: number) => invoke<MediaPage>("chat_media", { chat, topic, before }),
  chatImport: (items: ChatImport[], title: string) => invoke<number>("chat_import", { items, title }),
};
