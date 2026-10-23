/** TGPhotos commands: the common ones (`base`) plus the media library. */
import { base } from "@tgcloud/ui/core/base";
import { invoke } from "@tgcloud/ui/core/server";

export { errText, fileUrl, getPort, setPort } from "@tgcloud/ui/core/server";
export type { Transfer, TransferState, Status, SyncReport, Vault } from "@tgcloud/ui/core/base";

/** Media in the Shorts feed: views (all devices) and like (not a favorite). */
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
  /** Capture timezone in minutes, when the file says it. */
  tz: number | null;
  favorite: boolean;
  archived: boolean;
  trashed_at: number | null;
  added_at: number;
  /** Motion photo: video bytes at the end of the file (0 = checked, ordinary; absent = unchecked). */
  motion?: number | null;
  lat: number | null;
  lon: number | null;
  /** Original on this device (path or URI), when it was uploaded from here. */
  local: string | null;
  /** URL of the bytes instead of `/f/<id>` (local original or device media). */
  src?: string;
  /** Device media outside the vault (negative id): MediaStore URI or path. */
  uri?: string;
  /** Device media: 0 = no backup, 1 = queued / uploading, 2 = already in the vault (device folder). */
  pending?: number;
  /** Thumbnail ready (device-only item in the trash: the file went out of sight). */
  cover?: string;
  /** In the device trash, with no copy in the vault (negative id). */
  device?: boolean;
};

/** Item in the device trash (recorded by the app). */
export type DeviceTrash = {
  src: string;
  media_id: number | null;
  /** The linked vault media item is also in the trash. */
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
/** Original from this device linked to a vault media item. */
export type DeviceLink = { src: string; media_id: number; trashed: boolean; size: number; name: string; mime: string };

/** File from the backup folders still outside the vault (desktop). */
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

export type View = "timeline" | "favorites" | "videos" | "recent" | "archive" | "trash";

export type BackupReport = { queued: number; scanned: number };

/** Account conversation (import from chats). `key`: how Rust recognizes it. */
export type ChatInfo = {
  key: string;
  title: string;
  kind: "saved" | "user" | "bot" | "group" | "forum" | "channel";
  /** Photo id (text: exceeds 2^53). */
  photo: string | null;
  /** "Restrict saving": cannot import. */
  protected: boolean;
  /** Last message (s). */
  date: number;
};
export type ChatPage = { chats: ChatInfo[]; next: string | null };
export type Topic = { id: number; title: string; color: number; closed: boolean };
/** Photo or video from a chat (id = message; date = send time to Telegram, s). */
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
  usage: () => invoke<Usage>("usage"),

  /** Motion photo checked when opening (video bytes; 0 = ordinary). */
  setMotion: (id: number, length: number) => invoke<void>("media_set_motion", { id, length }),
  setFavorite: (ids: number[], on: boolean) => invoke<void>("set_favorite", { ids, on }),
  /** Shorts: next in the feed (least viewed, shuffled), without the ones in `skip`. */
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
  /** Folders shown on the timeline without backup. */
  showFolders: () => invoke<string[]>("show_folders"),
  showSetFolder: (path: string, on: boolean) => invoke<void>("show_set_folder", { path, on }),
  /** Returns how many left the queue (when turning it off). */
  backupSetFolder: (path: string, on: boolean) => invoke<number>("backup_set_folder", { path, on }),
  backupScan: () => invoke<BackupReport>("backup_scan"),
  backupEnqueue: (items: { uri: string; name: string; size: number; mime: string; path: string; modified: number }[], force = false) =>
    invoke<BackupReport>("backup_enqueue", { items, force }),
  /** 0 = outside the vault, 1 = queued, 2 = in the vault. */
  backupStatus: (srcs: string[]) => invoke<number[]>("backup_status", { srcs }),
  backupLocal: () => invoke<LocalItem[]>("backup_local"),
  localForget: (srcs: string[]) => invoke<void>("local_forget", { srcs }),
  /** Download finished: `src` (downloaded file) becomes the local original of media `uid`. */
  localLink: (uid: string, src: string) => invoke<void>("local_link", { uid, src }),
  /** Removes from the vault (its trash) and keeps it on the device, outside automatic backup. */
  excludeFromVault: (srcs: string[]) => invoke<number>("exclude_from_vault", { srcs }),
  localRelink: (items: { uri: string; name: string; size: number; mime: string; path: string; modified: number }[]) => invoke<number>("local_relink", { items }),
  localTrash: (paths: string[]) => invoke<number>("local_trash", { paths }),
  localFree: (paths: string[]) => invoke<number>("local_free", { paths }),
  localRestore: (paths: string[]) => invoke<number>("local_restore", { paths }),
  localPurge: (paths: string[]) => invoke<number>("local_purge", { paths }),
  /** Desktop: 1 = the file exists, 0 = gone. */
  localStates: (paths: string[]) => invoke<number[]>("local_states", { paths }),

  /** Device trash: records; returns the linked vault media items. */
  deviceTrashAdd: (entries: DeviceTrashIn[]) => invoke<number[]>("device_trash_add", { entries }),
  deviceTrashList: () => invoke<DeviceTrash[]>("device_trash_list"),
  deviceTrashRemove: (srcs: string[], moved: [string, string][] = []) => invoke<void>("device_trash_remove", { srcs, moved }),
  deviceLinks: () => invoke<DeviceLink[]>("device_links"),
  localOpen: (path: string, reveal: boolean) => invoke<void>("local_open", { path, reveal }),

  chatToken: () => invoke<string>("chat_token"),
  chats: (cursor: string | null) => invoke<ChatPage>("chats", { cursor }),
  chatsSearch: (q: string) => invoke<ChatInfo[]>("chats_search", { q }),
  chatTopics: (chat: string) => invoke<Topic[]>("chat_topics", { chat }),
  /** Below message `before` (0 = from the start). */
  chatMedia: (chat: string, topic: number | null, before: number) => invoke<MediaPage>("chat_media", { chat, topic, before }),
  chatImport: (items: ChatImport[], title: string) => invoke<number>("chat_import", { items, title }),
};
