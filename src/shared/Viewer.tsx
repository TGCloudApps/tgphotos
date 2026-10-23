/**
 * TGPhotos viewer: the shared lightbox with the photo actions (favorite,
 * share, download, album, archive, trash) and the media information.
 */
import { currentVault } from "@tgcloud/ui/core/vault";
import { createElement as h, useEffect } from "react";
import { requestThumb } from "@tgcloud/ui/core/thumbs";
import { useIsFetching } from "@tanstack/react-query";
import { Archive, ArchiveRestore, CloudUpload, Download, ExternalLink, FolderInput, FolderOpen, Heart, Image as ImageIcon, ImagePlus, Info as InfoIcon, MoreVertical, Pencil, RotateCcw, Send, Share2, Smartphone, Star, TextCursorInput, Trash2, X, UserSquare, RefreshCw } from "lucide-react";
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
import { fmtDate, fmtTime } from "@tgcloud/ui/i18n";
import { t, tc } from "../i18n";
import { nav, useLayers, useRoute, type Layer } from "../core/nav";
import { wallClock } from "../timeline/layout";
import { Info } from "./Info";

/**
 * Share: from the file on the device when it is here (right away, without the
 * network); otherwise download it from the vault to a temporary copy.
 */
/** Several at once: each takes the same path as the single one (device without a copy, vault with a temporary copy). */
export function shareMany(list: Media[]) {
  if (list.length === 1) return share(list[0]);
  const withUri = list.map((m) => ({ id: m.id, name: m.name, mime: m.mime, uri: m.uri ?? (m.local?.startsWith("content://") ? m.local : undefined) }));
  void transfers.shareMany(withUri);
}

function share(m: Media) {
  const uri = m.uri ?? (m.local?.startsWith("content://") ? m.local : null);
  if (uri && android.shareUri(uri, m.mime)) return;
  void transfers.share(m);
}

/** Open with / edit / set as (Android) — for a local file. */
function openWith(m: Media): LightboxMenuItem[] {
  if (!onAndroid) return [{ label: t("viewer.showInFolder"), icon: <FolderOpen />, run: () => openLocal(m, "reveal") }];
  return [
    { label: t("viewer.openWith"), icon: <ExternalLink />, run: () => openLocal(m, "view") },
    { label: t("viewer.editElsewhere"), icon: <Pencil />, run: () => openLocal(m, "edit") },
    ...(m.mime.startsWith("image/") ? [{ label: t("viewer.setAs"), icon: <ImageIcon />, run: () => openLocal(m, "attach") }] : []),
  ];
}

/** Vault only (Android): the same options, downloading first (dialog with progress). */
function fetchWith(m: Media): LightboxMenuItem[] {
  if (!onAndroid) return [];
  return [
    { label: t("viewer.openWith"), icon: <ExternalLink />, run: () => nav.open({ type: "fetch", id: m.id, how: "view" }) },
    { label: t("viewer.editElsewhere"), icon: <Pencil />, run: () => nav.open({ type: "fetch", id: m.id, how: "edit" }) },
    ...(m.mime.startsWith("image/") ? [{ label: t("viewer.setAs"), icon: <ImageIcon />, run: () => nav.open({ type: "fetch", id: m.id, how: "attach" }) }] : []),
  ];
}

/** ⋮ of media that is only on the device. */
function localMenu(m: Media): LightboxMenuItem[] {
  const src = localOf(m);
  return [
    ...openWith(m),
    ...(onAndroid && src && android.canManage()
      ? [
          { label: t("viewer.moveToFolder"), icon: <FolderInput />, run: () => nav.open({ type: "device-move", uris: [src] }) },
          { label: t("viewer.renameEllipsis"), icon: <TextCursorInput />, run: () => nav.open({ type: "device-rename", uri: src, name: m.name }) },
        ]
      : []),
  ];
}

/** Vault media (positive id) and device media outside the vault (negative). */
/** Device-only video in the trash: the file is out of view; shows the kept thumbnail. */
const asImage = new WeakMap<Media, Media>();
const findAny = (id: number) => {
  const m = id < 0 ? findLocal(id) : findMedia(id);
  if (!m?.device || !m.mime.startsWith("video/")) return m;
  let img = asImage.get(m);
  if (!img) asImage.set(m, (img = { ...m, mime: "image/jpeg" }));
  return img;
};

/** Upload queue for device media picked by hand. */
export async function backupLocal(list: Media[]) {
  const items = list.filter((m) => m.uri).map((m) => ({ uri: m.uri!, name: m.name, size: m.size, mime: m.mime, path: "", modified: Math.floor(m.taken_at) }));
  if (!items.length || !(await confirmBig(items.length))) return;
  try {
    const r = await api.backupEnqueue(items, true);
    notify({ text: t("viewer.queued", { n: r.queued }), tone: "info", action: { label: tc("common.view"), run: () => nav.dest("transfers") } });
    void loadLibrary();
  } catch (e) {
    notifyError(e);
  }
}

/** Delay before generating the thumbnail of the open media. */
const REGEN_AFTER_MS = 2000;

const go = (id: number, siblings: number[]) => nav.replaceTop({ type: "viewer", id, siblings });

/** Vault photo from a photo: requires permission to change the channel information. */
const canVaultPhoto = (m: Media) => m.mime.startsWith("image/") && currentVault()?.can_rename !== false;

/** Regenerate the thumbnail (e.g. it came out black): vault media, with write permission on it. */
const canRegen = (m: Media) => m.id > 0 && /^(image|video)\//.test(m.mime) && currentVault()?.can_post !== false;

/** Extra actions for a media (desktop ⋮ menu / mobile sheet). */
export function moreActions(m: Media, album: number, leave: (run: () => Promise<unknown>) => void): MenuEntry[] {
  return [
    { label: tc("common.download"), icon: h(Download), shortcut: "D", run: () => actions.download([m.id]) },
    { label: t("viewer.addToAlbum"), icon: h(ImagePlus), run: () => nav.open({ type: "album-pick", ids: [m.id] }) },
    { label: t("viewer.sendToVault"), icon: h(Send), run: () => nav.open({ type: "send-vault", ids: [m.id] }) },
    ...(album
      ? ([
          { label: t("viewer.albumCover"), icon: h(Star), run: () => void actions.albumCover(album, m.id) },
          { label: t("viewer.removeFromAlbum"), icon: h(X), run: () => leave(() => actions.albumRemove(album, [m.id])) },
        ] as MenuEntry[])
      : []),
    ...(canVaultPhoto(m) ? [{ label: t("viewer.vaultPhoto"), icon: h(UserSquare), run: () => void actions.vaultPhoto(m) } as MenuEntry] : []),
    ...(canRegen(m) ? [{ label: t("viewer.regenThumb"), icon: h(RefreshCw), run: () => void actions.regenThumb(m) } as MenuEntry] : []),
    m.archived
      ? { label: t("viewer.unarchive"), icon: h(ArchiveRestore), run: () => leave(() => actions.archive([m.id], false)) }
      : { label: t("viewer.archive"), icon: h(Archive), run: () => leave(() => actions.archive([m.id], true)) },
  ];
}

export function Viewer({ layer, touch }: { layer: Extract<Layer, { type: "viewer" }>; touch: boolean }) {
  // Upload state of local media (redraws when the queue moves).
  const uploads = useTransfers((s) => uploadStates(s.list));
  /** Outside the vault: uploading, queued or nothing (no backup yet). */
  const backupState = (m: Media) => {
    const st = m.uri ? uploads.get(m.uri.split("?")[0]) : undefined;
    if (st === "active") return "active" as const;
    if (st === "queued" || st === "waiting" || st === "paused" || (m.pending && st !== "error")) return "queued" as const;
    return null;
  };
  const layers = useLayers();
  const route = useRoute();
  const inTrash = route.dest === "trash";
  const album = route.dest === "album" ? route.album : 0;
  const top = layers[layers.length - 1]?.type;
  // The item comes from the query cache: reloading (favoriting…) redraws.
  useIsFetching();

  const purge = (m: Media) => nav.open({ type: "confirm", action: "purge", ids: [m.id] });

  // Media without a thumbnail opened here: generate it now, reusing the parts the
  // viewer just downloaded (they stay in the core in-memory cache). Waits a
  // little so it does not compete with the display's own download; moving to
  // another media before that cancels it.
  useEffect(() => {
    const m = layer.id > 0 ? findMedia(layer.id) : undefined;
    if (!m || m.thumb) return;
    const t = setTimeout(() => requestThumb(m), REGEN_AFTER_MS);
    return () => clearTimeout(t);
  }, [layer.id]);

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
          title: fmtDate(d, { day: "numeric", month: "short", year: sameYear ? undefined : "numeric" }),
          subtitle: [
            fmtTime(d),
            m.device ? t("viewer.deviceOnly") : m.id < 0 ? (backupState(m) === "active" ? t("viewer.backupActive") : backupState(m) ? t("viewer.backupQueued") : t("viewer.noBackup")) : null,
          ]
            .filter(Boolean)
            .join(" · "),
          // Jumps to the date in the timeline (Photos).
          onClick: () =>
            nav.closeThen(() => {
              if (nav.route().dest !== "photos") nav.dest("photos");
              jumpTo(m.id);
            }, 0),
        };
      }}
      topTouch={(m) =>
        m.id > 0 && !inTrash ? (
          <HudButton touch label={m.favorite ? tc("common.unfavorite") : tc("common.favorite")} onClick={() => void actions.favorite([m.id], !m.favorite)} active={m.favorite}>
            <Heart className={m.favorite ? "fill-current" : undefined} />
          </HudButton>
        ) : null
      }
      quick={(m, { leave }): LightboxMenuItem[] => {
        const info = { label: tc("common.info"), icon: <InfoIcon />, run: () => nav.open({ type: "details", id: m.id }) };
        // Trash (vault or device-only): restore brings it back to both.
        if (inTrash)
          return [
            { label: tc("common.restore"), icon: <RotateCcw />, run: () => leave(() => actions.restore([m.id])) },
            { label: t("viewer.purge"), icon: <Trash2 />, run: () => purge(m) },
            ...(m.device ? [] : [info]),
          ];
        if (m.id < 0)
          return [
            ...(onAndroid ? [{ label: tc("common.share"), icon: <Share2 />, run: () => share(m) }] : []),
            // Queued or uploading: the button makes no sense (the title shows the state).
            ...(backupState(m) ? [] : [{ label: t("viewer.backup"), icon: <CloudUpload />, run: () => void backupLocal([m]) }]),
            { label: tc("common.trash"), icon: <Trash2 />, run: () => void deleteLocal([m]).then((ok) => ok && leave(async () => {})) },
            info,
          ];
        return [
          ...(onAndroid ? [{ label: tc("common.share"), icon: <Share2 />, run: () => share(m) }] : []),
          { label: t("viewer.addTo"), icon: <ImagePlus />, run: () => nav.open({ type: "album-pick", ids: [m.id] }) },
          { label: tc("common.trash"), icon: <Trash2 />, run: () => leave(() => actions.trash([m.id])) },
          info,
        ];
      }}
      menu={(m, { leave }): LightboxMenuItem[] =>
        inTrash
          ? []
          : m.id < 0
          ? localMenu(m)
          : [
              // Already on the device (downloaded or uploaded from here): nothing to download.
              ...(onAndroid && m.local ? [] : [{ label: tc("common.download"), icon: <Download />, run: () => actions.download([m.id], () => nav.closeThen(() => nav.dest("transfers"))) }]),
              { label: t("viewer.sendToVault"), icon: <Send />, run: () => nav.open({ type: "send-vault", ids: [m.id] }) },
              ...(album
                ? [
                    { label: t("viewer.albumCover"), icon: <Star />, run: () => void actions.albumCover(album, m.id) },
                    { label: t("viewer.removeFromAlbum"), icon: <X />, run: () => leave(() => actions.albumRemove(album, [m.id])) },
                  ]
                : []),
              ...(canVaultPhoto(m) ? [{ label: t("viewer.vaultPhoto"), icon: <UserSquare />, run: () => void actions.vaultPhoto(m) }] : []),
              ...(canRegen(m) ? [{ label: t("viewer.regenThumb"), icon: <RefreshCw />, run: () => void actions.regenThumb(m) }] : []),
              m.archived
                ? { label: t("viewer.unarchive"), icon: <ArchiveRestore />, run: () => leave(() => actions.archive([m.id], false)) }
                : { label: t("viewer.archive"), icon: <Archive />, run: () => leave(() => actions.archive([m.id], true)) },
              // Original on this device: can be opened in another app and free up space (the vault remains).
              ...(m.local ? [...openWith(m), { label: t("viewer.deleteFromDevice"), hint: t("viewer.staysInVault"), icon: <Smartphone />, run: () => void freeLocal([m]) }] : fetchWith(m)),
            ]
      }
      openInfoTouch={() => nav.open({ type: "details", id: layer.id })}
      onSave={(m) => actions.download([m.id])}
      subtitle={(m) => {
        const d = wallClock(m);
        return t("viewer.dateTime", { date: fmtDate(d, { day: "numeric", month: "short", year: "numeric" }), time: fmtTime(d) });
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
            <HudButton touch={touch} label={tc("common.restore")} onClick={() => leave(() => actions.restore([m.id]))}>
              <RotateCcw />
            </HudButton>
            <HudButton touch={touch} label={t("viewer.purgeKey")} onClick={() => purge(m)} danger>
              <Trash2 />
            </HudButton>
          </>
        ) : m.id < 0 ? (
          <>
            {!backupState(m) && (
              <HudButton touch={touch} label={t("viewer.doBackup")} onClick={() => void backupLocal([m])}>
                <CloudUpload />
              </HudButton>
            )}
            <HudButton touch={touch} label={t("viewer.showInFolder")} onClick={() => openLocal(m, "reveal")}>
              <FolderOpen />
            </HudButton>
            <HudButton touch={touch} label={t("viewer.trashKey")} onClick={() => void deleteLocal([m]).then((ok) => ok && leave(async () => {}))}>
              <Trash2 />
            </HudButton>
          </>
        ) : (
          <>
            {touch && onAndroid && (
              <HudButton touch={touch} label={tc("common.share")} onClick={() => void transfers.share(m)}>
                <Share2 />
              </HudButton>
            )}
            <HudButton touch={touch} label={m.favorite ? t("viewer.unfavoriteKey") : t("viewer.favoriteKey")} onClick={() => void actions.favorite([m.id], !m.favorite)} active={m.favorite}>
              <Heart className={m.favorite ? "fill-current" : undefined} />
            </HudButton>
            {!touch && (
              <HudButton touch={touch} label={t("viewer.downloadKey")} onClick={() => actions.download([m.id])}>
                <Download />
              </HudButton>
            )}
            <HudButton touch={touch} label={t("viewer.trashKey")} onClick={() => leave(() => actions.trash([m.id]))}>
              <Trash2 />
            </HudButton>
            <HudButton
              touch={touch}
              label={tc("common.more")}
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
