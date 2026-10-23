/** Collections: shortcuts (Favorites, Recently sent, Videos, Archive, Trash) and the album grid. */
import { useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Archive, HardDriveDownload, Clock, Heart, Images, MessagesSquare, Plus, Trash2, Video } from "lucide-react";
import { thumbUrl } from "@tgcloud/ui/core/thumbs";
import { fileUrl, mocked } from "@tgcloud/ui/core/server";
import { EmptyState, ErrorState } from "@tgcloud/ui/ui/States";
import type { Album } from "../core/api";
import { findMedia, useAlbums } from "../core/data";
import { nav, type Dest } from "../core/nav";
import { android, available as onAndroid } from "@tgcloud/ui/core/android";
import { DeviceFolders } from "../mobile/Device";
import { FreeSpaceEntry } from "./DeviceSync";
import { fmtDate } from "@tgcloud/ui/i18n";
import { t, tc } from "../i18n";

const shortcuts: { dest: Dest; label: () => string; icon: typeof Heart }[] = [
  { dest: "favorites", label: () => t("collections.favorites"), icon: Heart },
  { dest: "recent", label: () => t("collections.recent"), icon: Clock },
  { dest: "videos", label: () => t("collections.videos"), icon: Video },
  { dest: "archive", label: () => t("collections.archive"), icon: Archive },
  { dest: "trash", label: () => tc("common.trash"), icon: Trash2 },
];

export function Collections({ touch }: { touch: boolean }) {
  const q = useAlbums();
  const hasAlbums = (q.data?.length ?? 0) > 0;
  const showDevice = touch && onAndroid && android.hasMedia();
  return (
    <div className={touch ? "px-3 pt-1 pb-28" : "px-6 pt-2 pb-10"}>
      <div className={`grid gap-2 ${touch ? "grid-cols-2" : "grid-cols-[repeat(auto-fill,minmax(200px,1fr))]"}`}>
        {shortcuts.map(({ dest, label, icon: Icon }, i) => (
          <button
            key={dest}
            onClick={() => nav.dest(dest)}
            className={`surface flex items-center gap-3 rounded-xl bg-s1 px-3.5 text-left font-semibold text-fg ${touch ? `${i === shortcuts.length - 1 && shortcuts.length % 2 ? "col-span-2 " : ""}h-14 text-[15px] active:bg-s3` : "h-12 text-[14px] hover:bg-s3"}`}
          >
            <Icon size={20} className="text-brand" />
            {label()}
          </button>
        ))}
        <button
          onClick={() => nav.open({ type: "import" })}
          className={`surface flex items-center gap-3 rounded-xl bg-s1 px-3.5 text-left font-semibold text-fg ${touch ? "col-span-2 h-14 text-[15px] active:bg-s3" : "h-12 text-[14px] hover:bg-s3"}`}
        >
          <HardDriveDownload size={20} className="text-brand" />
          {t("collections.importDrive")}
        </button>
        {(isTauri() || mocked()) && (
          <button
            onClick={() => nav.open({ type: "import-google" })}
            className={`surface flex items-center gap-3 rounded-xl bg-s1 px-3.5 text-left font-semibold text-fg ${touch ? "col-span-2 h-14 text-[15px] active:bg-s3" : "h-12 text-[14px] hover:bg-s3"}`}
          >
            <Images size={20} className="text-brand" />
            {t("collections.importGoogle")}
          </button>
        )}
        <button
          onClick={() => nav.dest("chats")}
          className={`surface flex items-center gap-3 rounded-xl bg-s1 px-3.5 text-left font-semibold text-fg ${touch ? "col-span-2 h-14 text-[15px] active:bg-s3" : "h-12 text-[14px] hover:bg-s3"}`}
        >
          <MessagesSquare size={20} className="text-brand" />
          {t("collections.importChats")}
        </button>
        <FreeSpaceEntry touch={touch} />
      </div>

      {/* With albums, they come first; without albums, the device folders. */}
      {showDevice && !hasAlbums && <DeviceFolders />}

      <div className="mt-6 mb-3 flex items-center justify-between">
        <h2 className={`font-semibold ${touch ? "pl-1 text-[17px]" : "text-[15px]"}`}>{t("collections.albums")}</h2>
        <button
          onClick={() => nav.open({ type: "name", mode: "album-new", ids: [] })}
          className={`flex items-center gap-1.5 rounded-lg px-3 font-semibold text-accent ${touch ? "h-10 text-[15px] active:bg-s3" : "h-8 text-[13px] hover:bg-s3"}`}
        >
          <Plus size={18} /> {t("collections.newAlbum")}
        </button>
      </div>

      {q.error ? (
        <ErrorState touch={touch} error={q.error} retry={q.refetch} />
      ) : q.data && !q.data.length ? (
        <EmptyState touch={touch} icon={Images} title={t("collections.emptyTitle")} text={t("collections.emptyText")} />
      ) : (
        <div className={`grid gap-x-3 gap-y-4 ${touch ? "grid-cols-2" : "grid-cols-[repeat(auto-fill,minmax(180px,1fr))]"}`}>
          {(q.data ?? []).map((a) => (
            <AlbumCard key={a.id} album={a} touch={touch} />
          ))}
        </div>
      )}

      {showDevice && hasAlbums && <DeviceFolders />}
    </div>
  );
}

function coverSrc(a: Album) {
  if (!a.cover) return null;
  const m = findMedia(a.cover);
  // The cover may not be in any loaded list: the thumbnail exists in most cases.
  if (!m || m.thumb) return thumbUrl(a.cover);
  return m.mime.startsWith("image/") && m.size < 2 * 1024 * 1024 ? fileUrl(a.cover) : null;
}

export function albumPeriod(a: Pick<Album, "first" | "last">) {
  if (!a.first || !a.last) return "";
  const f = new Date(a.first * 1000);
  const l = new Date(a.last * 1000);
  const fmt = (d: Date, year: boolean) => fmtDate(d, { month: "short", year: year ? "numeric" : undefined });
  if (f.getFullYear() === l.getFullYear() && f.getMonth() === l.getMonth()) return fmt(f, true);
  return `${fmt(f, f.getFullYear() !== l.getFullYear())} – ${fmt(l, true)}`;
}

/** Album cover; without a cover (or thumbnail not generated yet), the icon. */
export function AlbumCover({ album, icon = 32, className = "" }: { album: Album; icon?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const src = failed ? null : coverSrc(album);
  if (!src)
    return (
      <div className="grid size-full place-items-center text-fg-3">
        <Images size={icon} />
      </div>
    );
  return <img src={src} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} className={`size-full object-cover ${className}`} />;
}

function AlbumCard({ album: a, touch }: { album: Album; touch: boolean }) {
  return (
    <button onClick={() => nav.album(a.id)} className="group text-left">
      <div className="surface aspect-square overflow-hidden rounded-xl bg-s2">
        <AlbumCover key={a.cover ?? 0} album={a} className={`transition-transform duration-300 ${touch ? "" : "group-hover:scale-[1.03]"}`} />
      </div>
      <p className={`mt-2 truncate font-semibold text-fg ${touch ? "text-[15px]" : "text-[14px]"}`}>{a.name}</p>
      <p className="truncate text-[12px] text-fg-3 tabular">
        {a.count} {a.count === 1 ? "item" : "itens"}
        {albumPeriod(a) && ` · ${albumPeriod(a)}`}
      </p>
    </button>
  );
}
