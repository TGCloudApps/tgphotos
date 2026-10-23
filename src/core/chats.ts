/**
 * Import from chats: account conversations, topics and photos/videos from a chat
 * (Rust: tg_core::chats). Whatever is chosen goes into the upload queue — the app
 * downloads and re-uploads it to the vault (it does not forward: the vault only
 * stores opaque documents, encrypted if it is encrypted). Date: the upload time to
 * Telegram, when the file has none of its own.
 */
import { create } from "zustand";
import { getPort } from "@tgcloud/ui/core/server";
import { notify, notifyError } from "@tgcloud/ui/core/notices";
import { api, type ChatInfo, type ChatMedia } from "./api";
import { nav } from "./nav";
import { t, tc } from "../i18n";

let token: Promise<string> | null = null;
let tokenValue = "";
/** Token for the `/chat/*` routes (photo and thumbnails). */
export const chatToken = () =>
  (token ??= api
    .chatToken()
    .then((t) => (tokenValue = t))
    .catch(() => ""));
export const chatTokenNow = () => tokenValue;

const base = () => `http://127.0.0.1:${getPort()}/chat`;
export const chatPhotoUrl = (t: string, c: ChatInfo) => (c.photo ? `${base()}/photo?${new URLSearchParams({ t, c: c.key, p: c.photo })}` : null);
/** Chat video for the preview (Range: the player seeks). */
export const chatFileUrl = (t: string, chat: string, msg: number) => `${base()}/file?${new URLSearchParams({ t, c: chat, m: String(msg) })}`;
export const chatThumbUrl = (t: string, chat: string, msg: number, big = false) =>
  `${base()}/thumb?${new URLSearchParams({ t, c: chat, m: String(msg), big: big ? "1" : "0" })}`;

/** Conversations already seen (title and kind for the chat screen). */
export const useChatInfo = create<Record<string, ChatInfo>>(() => ({}));
export const rememberChats = (list: ChatInfo[]) => useChatInfo.setState(Object.fromEntries(list.map((c) => [c.key, c])));

/** Topics already seen (title in the bar). */
export const useTopicTitles = create<Record<string, string>>(() => ({}));
export const topicKey = (chat: string, topic: number) => `${chat}#${topic}`;

/** Conversation kind name in the active language (getters: read on the fly). */
export const kindLabel: Record<ChatInfo["kind"], string> = {
  get saved() { return t("chatKind.saved"); },
  get user() { return t("chatKind.user"); },
  get bot() { return t("chatKind.bot"); },
  get group() { return t("chatKind.group"); },
  get forum() { return t("chatKind.forum"); },
  get channel() { return t("chatKind.channel"); },
};

/** Origin of the item in the upload queue (the same text Rust stores, without the date). */
export const chatSrc = (chat: string, msg: number) => `tg:${chat}:${msg}`;

/** Video duration ("0:42", "1:02:03"). */
export function duration(s: number | null): string {
  if (!s || !isFinite(s)) return "";
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Puts the chosen ones in the upload queue. Returns how many were added. */
export async function importMedia(chat: { key: string; title: string }, items: ChatMedia[]): Promise<number> {
  try {
    const n = await api.chatImport(
      items.map((m) => ({ chat: chat.key, msg: m.id, name: m.name, mime: m.mime, size: m.size, date: m.date })),
      chat.title,
    );
    notify({
      text: t("core.chatQueued", { n }),
      tone: "info",
      action: { label: tc("common.view"), run: () => nav.dest("transfers") },
    });
    return n;
  } catch (e) {
    notifyError(e);
    return 0;
  }
}
