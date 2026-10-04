/**
 * Importar de chats: conversas da conta, tópicos e fotos/vídeos de um chat
 * (Rust: tg_core::chats). O que for escolhido entra na fila de envios — o app
 * baixa e reenvia ao vault (não encaminha: o vault só guarda documentos
 * opacos, cifrados se ele for cifrado). Data: a de envio ao Telegram, quando o
 * arquivo não tem a própria.
 */
import { create } from "zustand";
import { getPort } from "@tgcloud/ui/core/server";
import { notify, notifyError } from "@tgcloud/ui/core/notices";
import { api, type ChatInfo, type ChatMedia } from "./api";
import { nav } from "./nav";

let token: Promise<string> | null = null;
let tokenValue = "";
/** Token das rotas `/chat/*` (foto e miniaturas). */
export const chatToken = () =>
  (token ??= api
    .chatToken()
    .then((t) => (tokenValue = t))
    .catch(() => ""));
export const chatTokenNow = () => tokenValue;

const base = () => `http://127.0.0.1:${getPort()}/chat`;
export const chatPhotoUrl = (t: string, c: ChatInfo) => (c.photo ? `${base()}/photo?${new URLSearchParams({ t, c: c.key, p: c.photo })}` : null);
export const chatThumbUrl = (t: string, chat: string, msg: number, big = false) =>
  `${base()}/thumb?${new URLSearchParams({ t, c: chat, m: String(msg), big: big ? "1" : "0" })}`;

/** Conversas já vistas (título e tipo para a tela do chat). */
export const useChatInfo = create<Record<string, ChatInfo>>(() => ({}));
export const rememberChats = (list: ChatInfo[]) => useChatInfo.setState(Object.fromEntries(list.map((c) => [c.key, c])));

/** Tópicos já vistos (título na barra). */
export const useTopicTitles = create<Record<string, string>>(() => ({}));
export const topicKey = (chat: string, topic: number) => `${chat}#${topic}`;

export const kindLabel: Record<ChatInfo["kind"], string> = {
  saved: "Mensagens salvas",
  user: "Conversa",
  bot: "Bot",
  group: "Grupo",
  forum: "Grupo com tópicos",
  channel: "Canal",
};

/** Origem do item na fila de envios (o mesmo texto que o Rust guarda, sem a data). */
export const chatSrc = (chat: string, msg: number) => `tg:${chat}:${msg}`;

/** Duração do vídeo ("0:42", "1:02:03"). */
export function duration(s: number | null): string {
  if (!s || !isFinite(s)) return "";
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Põe as escolhidas na fila de envios. Devolve quantas entraram. */
export async function importMedia(chat: { key: string; title: string }, items: ChatMedia[]): Promise<number> {
  try {
    const n = await api.chatImport(
      items.map((m) => ({ chat: chat.key, msg: m.id, name: m.name, mime: m.mime, size: m.size, date: m.date })),
      chat.title,
    );
    notify({
      text: `${n} ${n === 1 ? "item entrou" : "itens entraram"} na fila de envios`,
      tone: "info",
      action: { label: "Ver", run: () => nav.dest("transfers") },
    });
    return n;
  } catch (e) {
    notifyError(e);
    return 0;
  }
}
