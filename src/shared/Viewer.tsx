/**
 * Visualizador do TGPhotos: o lightbox comum com as ações de foto (favoritar,
 * compartilhar, baixar, álbum, arquivar, lixeira) e as informações da mídia.
 */
import { createElement as h } from "react";
import { useIsFetching } from "@tanstack/react-query";
import { Archive, ArchiveRestore, CloudUpload, Download, ExternalLink, FolderInput, FolderOpen, Heart, Image as ImageIcon, ImagePlus, Info as InfoIcon, MoreVertical, Pencil, RotateCcw, Send, Share2, Smartphone, Star, TextCursorInput, Trash2, X } from "lucide-react";
import { android, available as onAndroid } from "@tgcloud/ui/core/android";
import { jumpTo } from "../timeline/Timeline";
import { deleteLocal, freeLocal, localOf, openLocal } from "../core/localActions";
import { useTransfers, confirmBig } from "@tgcloud/ui/core/transfers";
import { uploadStates } from "../core/library";
import { transfers } from "@tgcloud/ui/core/transfers";
import { openMenu, type MenuEntry } from "@tgcloud/ui/desktop/Menu";
import { HudButton, Lightbox, type LightboxMenuItem } from "@tgcloud/ui/media/Lightbox";
import type { Media } from "../core/api";
import { actions, findMedia } from "../core/data";
import { findLocal, loadLibrary } from "../core/library";
import { api } from "../core/api";
import { notify, notifyError } from "@tgcloud/ui/core/notices";
import { nav, useLayers, useRoute, type Layer } from "../core/nav";
import { wallClock } from "../timeline/layout";
import { Info } from "./Info";

/**
 * Compartilhar: do arquivo no aparelho quando ele está aqui (na hora, sem
 * rede); senão baixa do vault para uma cópia temporária.
 */
function share(m: Media) {
  const uri = m.uri ?? (m.local?.startsWith("content://") ? m.local : null);
  if (uri && android.shareUri(uri, m.mime)) return;
  void transfers.share(m);
}

/** Abrir com / editar / definir como (Android) — para arquivo local. */
function openWith(m: Media): LightboxMenuItem[] {
  if (!onAndroid) return [{ label: "Mostrar na pasta", icon: <FolderOpen />, run: () => openLocal(m, "reveal") }];
  return [
    { label: "Abrir com…", icon: <ExternalLink />, run: () => openLocal(m, "view") },
    { label: "Editar em outro app…", icon: <Pencil />, run: () => openLocal(m, "edit") },
    ...(m.mime.startsWith("image/") ? [{ label: "Definir como…", icon: <ImageIcon />, run: () => openLocal(m, "attach") }] : []),
  ];
}

/** Só no vault (Android): as mesmas opções, baixando antes (diálogo com andamento). */
function fetchWith(m: Media): LightboxMenuItem[] {
  if (!onAndroid) return [];
  return [
    { label: "Abrir com…", icon: <ExternalLink />, run: () => nav.open({ type: "fetch", id: m.id, how: "view" }) },
    { label: "Editar em outro app…", icon: <Pencil />, run: () => nav.open({ type: "fetch", id: m.id, how: "edit" }) },
    ...(m.mime.startsWith("image/") ? [{ label: "Definir como…", icon: <ImageIcon />, run: () => nav.open({ type: "fetch", id: m.id, how: "attach" }) }] : []),
  ];
}

/** ⋮ de uma mídia que está só no aparelho. */
function localMenu(m: Media): LightboxMenuItem[] {
  const src = localOf(m);
  return [
    ...openWith(m),
    ...(onAndroid && src && android.canManage()
      ? [
          { label: "Mover para pasta…", icon: <FolderInput />, run: () => nav.open({ type: "device-move", uris: [src] }) },
          { label: "Renomear…", icon: <TextCursorInput />, run: () => nav.open({ type: "device-rename", uri: src, name: m.name }) },
        ]
      : []),
  ];
}

/** Mídias do vault (id positivo) e do aparelho fora do vault (negativo). */
/** Vídeo só do aparelho na lixeira: o arquivo saiu de vista; mostra a miniatura guardada. */
const asImage = new WeakMap<Media, Media>();
const findAny = (id: number) => {
  const m = id < 0 ? findLocal(id) : findMedia(id);
  if (!m?.device || !m.mime.startsWith("video/")) return m;
  let img = asImage.get(m);
  if (!img) asImage.set(m, (img = { ...m, mime: "image/jpeg" }));
  return img;
};

/** Fila de envio para mídias do aparelho escolhidas à mão. */
export async function backupLocal(list: Media[]) {
  const items = list.filter((m) => m.uri).map((m) => ({ uri: m.uri!, name: m.name, size: m.size, mime: m.mime, path: "", modified: Math.floor(m.taken_at) }));
  if (!items.length || !(await confirmBig(items.length))) return;
  try {
    const r = await api.backupEnqueue(items, true);
    notify({ text: `${r.queued} ${r.queued === 1 ? "item" : "itens"} na fila de envio`, tone: "info", action: { label: "Ver", run: () => nav.dest("transfers") } });
    void loadLibrary();
  } catch (e) {
    notifyError(e);
  }
}

const go = (id: number, siblings: number[]) => nav.replaceTop({ type: "viewer", id, siblings });

/** Ações extras de uma mídia (menu ⋮ do desktop / folha do celular). */
export function moreActions(m: Media, album: number, leave: (run: () => Promise<unknown>) => void): MenuEntry[] {
  return [
    { label: "Baixar", icon: h(Download), shortcut: "D", run: () => actions.download([m.id]) },
    { label: "Adicionar a um álbum…", icon: h(ImagePlus), run: () => nav.open({ type: "album-pick", ids: [m.id] }) },
    { label: "Enviar para outro vault…", icon: h(Send), run: () => nav.open({ type: "send-vault", ids: [m.id] }) },
    ...(album
      ? ([
          { label: "Usar como capa do álbum", icon: h(Star), run: () => void actions.albumCover(album, m.id) },
          { label: "Remover do álbum", icon: h(X), run: () => leave(() => actions.albumRemove(album, [m.id])) },
        ] as MenuEntry[])
      : []),
    m.archived
      ? { label: "Desarquivar", icon: h(ArchiveRestore), run: () => leave(() => actions.archive([m.id], false)) }
      : { label: "Arquivar", icon: h(Archive), run: () => leave(() => actions.archive([m.id], true)) },
  ];
}

export function Viewer({ layer, touch }: { layer: Extract<Layer, { type: "viewer" }>; touch: boolean }) {
  // Estado de envio das mídias locais (redesenha quando a fila anda).
  const uploads = useTransfers((s) => uploadStates(s.list));
  /** Fora do vault: "enviando", "na fila" ou nada (ainda sem backup). */
  const backupState = (m: Media) => {
    const st = m.uri ? uploads.get(m.uri.split("?")[0]) : undefined;
    if (st === "active") return "enviando";
    if (st === "queued" || st === "waiting" || st === "paused" || (m.pending && st !== "error")) return "na fila";
    return null;
  };
  const layers = useLayers();
  const route = useRoute();
  const inTrash = route.dest === "trash";
  const album = route.dest === "album" ? route.album : 0;
  const top = layers[layers.length - 1]?.type;
  // O item vem do cache das consultas: recarregar (favoritar…) redesenha.
  useIsFetching();

  const purge = (m: Media) => nav.open({ type: "confirm", action: "purge", ids: [m.id] });

  return (
    <Lightbox<Media>
      id={layer.id}
      siblings={layer.siblings}
      find={findAny}
      touch={touch}
      active={top === "viewer"}
      onGo={go}
      reveal={(id) => jumpTo(id)}
      onClose={nav.close}
      infoTouch={touch && top === "details"}
      menuTouch={top === "viewer-menu"}
      openMenuTouch={() => nav.open({ type: "viewer-menu" })}
      heading={(m) => {
        const d = wallClock(m);
        const sameYear = d.getFullYear() === new Date().getFullYear();
        return {
          title: d.toLocaleDateString("pt-BR", { day: "numeric", month: "short", year: sameYear ? undefined : "numeric" }).replace(/ de /g, " "),
          subtitle: [
            d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
            m.device ? "só no aparelho" : m.id < 0 ? (backupState(m) ? `backup ${backupState(m)}` : "sem backup") : null,
          ]
            .filter(Boolean)
            .join(" · "),
          // Viaja para a data na linha do tempo (Fotos).
          onClick: () =>
            nav.closeThen(() => {
              if (nav.route().dest !== "photos") nav.dest("photos");
              jumpTo(m.id);
            }, 0),
        };
      }}
      topTouch={(m) =>
        m.id > 0 && !inTrash ? (
          <HudButton touch label={m.favorite ? "Tirar dos favoritos" : "Favoritar"} onClick={() => void actions.favorite([m.id], !m.favorite)} active={m.favorite}>
            <Heart className={m.favorite ? "fill-current" : undefined} />
          </HudButton>
        ) : null
      }
      quick={(m, { leave }): LightboxMenuItem[] => {
        const info = { label: "Info", icon: <InfoIcon />, run: () => nav.open({ type: "details", id: m.id }) };
        // Lixeira (do vault ou só do aparelho): restaurar devolve aos dois.
        if (inTrash)
          return [
            { label: "Restaurar", icon: <RotateCcw />, run: () => leave(() => actions.restore([m.id])) },
            { label: "Apagar", icon: <Trash2 />, run: () => purge(m) },
            ...(m.device ? [] : [info]),
          ];
        if (m.id < 0)
          return [
            ...(onAndroid ? [{ label: "Compartilhar", icon: <Share2 />, run: () => share(m) }] : []),
            // Na fila ou subindo: o botão não faz sentido (o título diz o estado).
            ...(backupState(m) ? [] : [{ label: "Backup", icon: <CloudUpload />, run: () => void backupLocal([m]) }]),
            { label: "Lixeira", icon: <Trash2 />, run: () => void deleteLocal([m]).then((ok) => ok && leave(async () => {})) },
            info,
          ];
        return [
          ...(onAndroid ? [{ label: "Compartilhar", icon: <Share2 />, run: () => share(m) }] : []),
          { label: "Adicionar a", icon: <ImagePlus />, run: () => nav.open({ type: "album-pick", ids: [m.id] }) },
          { label: "Lixeira", icon: <Trash2 />, run: () => leave(() => actions.trash([m.id])) },
          info,
        ];
      }}
      menu={(m, { leave }): LightboxMenuItem[] =>
        inTrash
          ? []
          : m.id < 0
          ? localMenu(m)
          : [
              // Já está no aparelho (baixada ou enviada daqui): nada a baixar.
              ...(onAndroid && m.local ? [] : [{ label: "Baixar", icon: <Download />, run: () => actions.download([m.id], () => nav.closeThen(() => nav.dest("transfers"))) }]),
              { label: "Enviar para outro vault…", icon: <Send />, run: () => nav.open({ type: "send-vault", ids: [m.id] }) },
              ...(album
                ? [
                    { label: "Usar como capa do álbum", icon: <Star />, run: () => void actions.albumCover(album, m.id) },
                    { label: "Remover do álbum", icon: <X />, run: () => leave(() => actions.albumRemove(album, [m.id])) },
                  ]
                : []),
              m.archived
                ? { label: "Desarquivar", icon: <ArchiveRestore />, run: () => leave(() => actions.archive([m.id], false)) }
                : { label: "Arquivar", icon: <Archive />, run: () => leave(() => actions.archive([m.id], true)) },
              // Original neste aparelho: dá para abrir em outro app e liberar espaço (o vault continua).
              ...(m.local ? [...openWith(m), { label: "Excluir do dispositivo", hint: "fica no vault", icon: <Smartphone />, run: () => void freeLocal([m]) }] : fetchWith(m)),
            ]
      }
      openInfoTouch={() => nav.open({ type: "details", id: layer.id })}
      onSave={(m) => actions.download([m.id])}
      subtitle={(m) => {
        const d = wallClock(m);
        return `${d.toLocaleDateString("pt-BR", { day: "numeric", month: "short", year: "numeric" }).replace(/\./g, "")}, ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
      }}
      info={(m, t) => <Info media={m} touch={t} />}
      keys={(m, { leave }): Record<string, () => void> =>
        inTrash
          ? { Delete: () => purge(m) }
          : m.id < 0
          ? { Delete: () => void deleteLocal([m]).then((ok) => ok && leave(async () => {})) }
          : {
              d: () => actions.download([m.id]),
              D: () => actions.download([m.id]),
              f: () => void actions.favorite([m.id], !m.favorite),
              F: () => void actions.favorite([m.id], !m.favorite),
              Delete: () => leave(() => actions.trash([m.id])),
            }
      }
      actions={(m, { leave }) =>
        inTrash ? (
          <>
            <HudButton touch={touch} label="Restaurar" onClick={() => leave(() => actions.restore([m.id]))}>
              <RotateCcw />
            </HudButton>
            <HudButton touch={touch} label="Apagar para sempre (Delete)" onClick={() => purge(m)} danger>
              <Trash2 />
            </HudButton>
          </>
        ) : m.id < 0 ? (
          <>
            {!backupState(m) && (
              <HudButton touch={touch} label="Fazer backup" onClick={() => void backupLocal([m])}>
                <CloudUpload />
              </HudButton>
            )}
            <HudButton touch={touch} label="Mostrar na pasta" onClick={() => openLocal(m, "reveal")}>
              <FolderOpen />
            </HudButton>
            <HudButton touch={touch} label="Mover para a lixeira (Delete)" onClick={() => void deleteLocal([m]).then((ok) => ok && leave(async () => {}))}>
              <Trash2 />
            </HudButton>
          </>
        ) : (
          <>
            {touch && onAndroid && (
              <HudButton touch={touch} label="Compartilhar" onClick={() => void transfers.share(m)}>
                <Share2 />
              </HudButton>
            )}
            <HudButton touch={touch} label={m.favorite ? "Desfavoritar (f)" : "Favoritar (f)"} onClick={() => void actions.favorite([m.id], !m.favorite)} active={m.favorite}>
              <Heart className={m.favorite ? "fill-current" : undefined} />
            </HudButton>
            {!touch && (
              <HudButton touch={touch} label="Baixar (d)" onClick={() => actions.download([m.id])}>
                <Download />
              </HudButton>
            )}
            <HudButton touch={touch} label="Mover para a lixeira (Delete)" onClick={() => leave(() => actions.trash([m.id]))}>
              <Trash2 />
            </HudButton>
            <HudButton
              touch={touch}
              label="Mais"
              onClick={() => {
                if (touch) return nav.open({ type: "actions", ids: [m.id] });
                const btn = document.activeElement as HTMLElement | null;
                const r = btn?.getBoundingClientRect();
                openMenu(r ? r.right - 220 : window.innerWidth - 240, r ? r.bottom + 4 : 64, moreActions(m, album, leave));
              }}
            >
              <MoreVertical />
            </HudButton>
          </>
        )
      }
    />
  );
}
