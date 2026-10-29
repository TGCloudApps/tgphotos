import { canUseVault } from "@tgcloud/ui/core/vaultPermissions";
import { useRef } from "react";
import { ImagePlus, Pencil, Trash2 } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { uploads } from "@tgcloud/ui/core/uploads";
import { TVOptions } from "@tgcloud/ui/tv/TVShell";
import type { Album } from "../core/api";
import { nav } from "../core/nav";
import { pickNative } from "../shared/pickMedia";
import { t } from "../i18n";

export function AlbumOptions({ album, onClose }: { album: Album; onClose: () => void }) {
  return <TVOptions title={album.name} onClose={onClose}><AlbumActions album={album} onClose={onClose} /></TVOptions>;
}

export function AlbumActions({ album, onClose }: { album: Album; onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const add = () => {
    if (isTauri()) { onClose(); void pickNative(false, album.id); }
    else input.current?.click();
  };
  return <>
    <input ref={input} type="file" accept="image/*,video/*" multiple hidden onChange={e => { if (e.target.files?.length) uploads.add(e.target.files, album.id); e.target.value = ""; onClose(); }} />
    <div className="tv-library-tools">
      <button onClick={add}><ImagePlus />{t("desktop.addPhotos")}</button>
      <button disabled={!canUseVault("write")} onClick={() => { onClose(); nav.open({ type: "name", mode: "album-rename", id: album.id }); }}><Pencil />{t("desktop.renameAlbum")}</button>
      <button disabled={!canUseVault("write")} className="text-danger" onClick={() => { onClose(); nav.open({ type: "confirm", action: "album-delete", ids: [album.id] }); }}><Trash2 />{t("desktop.deleteAlbum")}</button>
    </div>
  </>;
}
