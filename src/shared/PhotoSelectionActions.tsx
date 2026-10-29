import { useCurrentVault } from "@tgcloud/ui/core/vault";
/** Complete selection actions, shared by the desktop and controller shells. */
import { Button, IconButton } from "@tgcloud/ui/desktop/ui";
import {
  Archive,
  ArchiveRestore,
  CloudUpload,
  Download,
  Heart,
  HeartOff,
  ImagePlus,
  RotateCcw,
  Send,
  Trash2,
  X
} from "lucide-react";
import { type Media } from "../core/api";
import { actions, findMedia } from "../core/data";
import { findLocal } from "../core/library";
import { nav, useRoute } from "../core/nav";
import { useSelection } from "../core/select";
import { t, tc } from "../i18n";
import { backupLocal } from "../shared/Viewer";

export function PhotoSelectionActions({ ids: all, controller = false }: { ids: number[]; controller?: boolean }) {
  // Files from the backup folders that have not uploaded yet (ids < 0): backup and trash apply to them.
  const ids = all.filter((id) => id > 0);
  const local = all.filter((id) => id < 0).map(findLocal).filter((m): m is Media => !!m);
  const allowedTrash = useCurrentVault(s => s.vault?.can_trash !== false) || ids.length === 0;
  const route = useRoute();
  const clear = () => useSelection.getState().clear();
  const inTrash = route.dest === "trash";
  const album = route.dest === "album" ? route.album : 0;
  const items = ids.map(findMedia).filter((m): m is Media => !!m);
  const allFav = items.length > 0 && items.every((m) => m.favorite);
  const archived = route.dest === "archive";
  if (controller) return (
    <div className="tv-selection-actions">
      {local.length > 0 && <Button variant="ghost" onClick={() => { void backupLocal(local); clear(); }}><CloudUpload /><span>{t("desktop.backupN", { n: local.length })}</span></Button>}
      {inTrash ? <>
        <Button capability={ids.length ? "write" : undefined} variant="ghost" onClick={() => void actions.restore(all)}><RotateCcw /><span>{tc("common.restore")}</span></Button>
        <Button capability={ids.length ? "trash" : undefined} disabled={!allowedTrash} variant="ghost" onClick={() => nav.open({ type: "confirm", action: "purge", ids: all })}><Trash2 /><span>{t("desktop.purge")}</span></Button>
      </> : <>
        {ids.length > 0 && <>
          <Button capability="write" variant="ghost" onClick={() => void actions.favorite(ids, !allFav)}>{allFav ? <HeartOff /> : <Heart />}<span>{allFav ? tc("common.unfavorite") : tc("common.favorite")}</span></Button>
          <Button variant="ghost" onClick={() => nav.open({ type: "send-vault", ids, chooseApp: true })}><Send /><span>{tc("common.send")}</span></Button>
          <Button capability="write" variant="ghost" onClick={() => nav.open({ type: "album-pick", ids })}><ImagePlus /><span>{t("desktop.addToAlbum")}</span></Button>
          <Button variant="ghost" onClick={() => actions.download(ids)}><Download /><span>{tc("common.download")}</span></Button>
          {album > 0 && <Button capability="write" variant="ghost" onClick={() => void actions.albumRemove(album, ids)}><X /><span>{t("desktop.removeFromAlbum")}</span></Button>}
          <Button capability="write" variant="ghost" onClick={() => void actions.archive(ids, !archived)}>{archived ? <ArchiveRestore /> : <Archive />}<span>{archived ? t("desktop.unarchive") : t("desktop.archive")}</span></Button>
        </>}
        <Button capability={ids.length ? "trash" : undefined} disabled={!allowedTrash} variant="ghost" onClick={() => void actions.trash(all)}><Trash2 /><span>{t("selection.moveToTrash")}</span></Button>
      </>}
      <Button variant="ghost" onClick={clear}><X /><span>{t("selection.clear")}</span></Button>
    </div>
  );
  return (
    <header className="flex h-14 shrink-0 items-center gap-1 border-b border-hairline bg-s2 px-4">
      <IconButton label={t("desktop.clearSelection")} onClick={clear}>
        <X />
      </IconButton>
      {local.length > 0 && (
        <Button
          variant="ghost"
          onClick={() => {
            void backupLocal(local);
            clear();
          }}
        >
          <CloudUpload /> {t("desktop.backupN", { n: local.length })}
        </Button>
      )}
      {local.length > 0 && ids.length === 0 && !inTrash && (
        <IconButton capability={ids.length ? "trash" : undefined} disabled={!allowedTrash} label={t("desktop.trashShortcut")} onClick={() => void actions.trash(all)}>
          <Trash2 />
        </IconButton>
      )}
      <p className="ml-1 flex-1 text-[15px] font-semibold tabular">
        {t("desktop.selected", { n: all.length })}
      </p>
      {inTrash ? (
        <>
          <Button capability={ids.length ? "write" : undefined} variant="ghost" onClick={() => void actions.restore(all)}>
            <RotateCcw /> {tc("common.restore")}
          </Button>
          <Button capability={ids.length ? "trash" : undefined} disabled={!allowedTrash} variant="ghost" onClick={() => nav.open({ type: "confirm", action: "purge", ids: all })}>
            <Trash2 /> {t("desktop.purge")}
          </Button>
        </>
      ) : ids.length > 0 && (
        <>
          <IconButton capability="write" label={allFav ? tc("common.unfavorite") : tc("common.favorite")} onClick={() => void actions.favorite(ids, !allFav)}>
            {allFav ? <HeartOff /> : <Heart />}
          </IconButton>
          <Button variant="ghost" onClick={() => nav.open({ type: "send-vault", ids, chooseApp: true })}>
            <Send /> {tc("common.send")}
          </Button>
          <IconButton capability="write" label={t("desktop.addToAlbum")} onClick={() => nav.open({ type: "album-pick", ids })}>
            <ImagePlus />
          </IconButton>
          <IconButton label={t("desktop.downloadShortcut")} onClick={() => actions.download(ids)}>
            <Download />
          </IconButton>
          {album > 0 && (
            <IconButton capability="write" label={t("desktop.removeFromAlbum")} onClick={() => void actions.albumRemove(album, ids)}>
              <X />
            </IconButton>
          )}
          <IconButton capability="write" label={archived ? t("desktop.unarchive") : t("desktop.archive")} onClick={() => void actions.archive(ids, !archived)}>
            {archived ? <ArchiveRestore /> : <Archive />}
          </IconButton>
          <IconButton capability={ids.length ? "trash" : undefined} disabled={!allowedTrash} label={t("desktop.trashShortcut")} onClick={() => void actions.trash(all)}>
            <Trash2 />
          </IconButton>
        </>
      )}
    </header>
  );
}

