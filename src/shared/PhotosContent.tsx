import { DeviceFolderScreen } from "../mobile/Device";
/** Photo destinations and timeline engine, shared by the desktop and controller shells. */
import { useCurrentVault } from "@tgcloud/ui/core/vault";
import { Button } from "@tgcloud/ui/desktop/ui";
import { EmptyState, ErrorState } from "@tgcloud/ui/ui/States";
import { TransfersView } from "@tgcloud/ui/ui/Transfers";
import {
  Archive,
  Clock,
  Heart,
  ImagePlus,
  Images,
  Search,
  Trash2,
  Upload,
  Video
} from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { type Media } from "../core/api";
import { useAlbumMedia, useList, useSearch } from "../core/data";
import { useDevice } from "../core/deviceStore";
import { merge, mergeTrash, useLibrary } from "../core/library";
import { useRoute } from "../core/nav";
import { t } from "../i18n";
import { ChatList, ChatScreen } from "../shared/Chats";
import { Collections } from "../shared/Collections";
import { ScrollPane } from "../shared/Scroll";
import { Liked, Shorts } from "../shared/Shorts";
import { Timeline } from "../timeline/Timeline";

// ---- content ----------------------------------------------------------------------------

export function PhotosContent({ pick, over = false }: { pick: (folder: boolean) => void; over?: boolean }) {
  const route = useRoute();
  const vault = useCurrentVault((s) => s.vault?.id);
  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {route.dest === "device" && <DeviceFolderScreen path={route.device ?? ""} />}
      {route.dest === "photos" && <ListPane view="timeline" pick={pick} />}
      {route.dest === "shorts" && <Shorts key={vault} touch={false} />}
      {route.dest === "liked" && <Liked key={vault} touch={false} />}
      {route.dest === "favorites" && <ListPane view="favorites" pick={pick} />}
      {route.dest === "videos" && <ListPane view="videos" pick={pick} />}
      {route.dest === "recent" && <ListPane view="recent" pick={pick} />}
      {route.dest === "archive" && <ListPane view="archive" pick={pick} />}
      {route.dest === "trash" && <ListPane view="trash" pick={pick} />}
      {route.dest === "album" && <AlbumPane id={route.album} pick={pick} />}
      {route.dest === "search" && <SearchPane text={route.query} />}
      {route.dest === "collections" && (
        <ScrollPane>
          <Collections touch={false} />
        </ScrollPane>
      )}
      {route.dest === "chats" && (
        <ScrollPane>
          <ChatList touch={false} />
        </ScrollPane>
      )}
      {route.dest === "chat" && (
        <ScrollPane>
          <ChatScreen touch={false} />
        </ScrollPane>
      )}
      {route.dest === "transfers" && (
        <div className="flex-1 overflow-y-auto px-4">
          <TransfersView touch={false} />
        </div>
      )}
      {over && (
        <div className="pointer-events-none absolute inset-3 grid place-items-center rounded-2xl border-2 border-dashed border-brand bg-brand-soft/40 text-[14px] font-semibold text-fg">
          {route.dest === "album" ? t("desktop.dropToAlbum") : t("desktop.dropMedia")}
        </div>
      )}
    </main>
  );
}

type Q = { data?: Media[]; error: unknown; refetch: () => void; isLoading: boolean };

function Grid({ q, empty, byAdded }: { q: Q; empty: ReactNode; byAdded?: boolean }) {
  if (q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  if (q.isLoading) return <div className="flex-1" />;
  if (!q.data?.length) return <>{empty}</>;
  return <Timeline items={q.data} touch={false} byAdded={byAdded} />;
}

const empties = { timeline: Images, favorites: Heart, videos: Video, recent: Clock, archive: Archive, trash: Trash2 } as const;

function ListPane({ view, pick }: { view: keyof typeof empties; pick: (folder: boolean) => void }) {
  const e = { icon: empties[view], title: t(`desktop.empty.${view}.title`), text: t(`desktop.empty.${view}.text`) };
  const vault = useList(view);
  // Photos: what is in the backup folders and has not uploaded yet comes along.
  const local = useLibrary((s) => s.items);
  // Trash: the computer's trash comes along (what has no copy in the vault).
  const trashed = useDevice((s) => s.localOnly);
  const data = useMemo(
    () => (!vault.data ? vault.data : view === "timeline" ? merge(vault.data, local) : view === "trash" ? mergeTrash(vault.data, trashed) : vault.data),
    [view, vault.data, local, trashed],
  );
  const grid = (
    <Grid
      q={{ ...vault, data }}
      byAdded={view === "recent"}
      empty={
        <EmptyState
          icon={e.icon}
          title={e.title}
          text={e.text}
          action={
            view === "timeline" ? (
              <Button capability="write" variant="primary" onClick={() => pick(false)}>
                <Upload /> {t("desktop.uploadMediaCta")}
              </Button>
            ) : undefined
          }
        />
      }
    />
  );
  return grid;
}

function AlbumPane({ id, pick }: { id: number; pick: (folder: boolean) => void }) {
  return (
    <Grid
      q={useAlbumMedia(id)}
      empty={
        <EmptyState
          icon={Images}
          title={t("desktop.emptyAlbum.title")}
          text={t("desktop.emptyAlbum.text")}
          action={
            <Button capability="write" variant="primary" onClick={() => pick(false)}>
              <ImagePlus /> {t("desktop.addPhotos")}
            </Button>
          }
        />
      }
    />
  );
}

function SearchPane({ text }: { text: string }) {
  const q = useSearch(text);
  if (!text.trim()) return <EmptyState sync={false} icon={Search} title={t("desktop.search.title")} text={t("desktop.search.text")} />;
  return <Grid q={{ ...q, isLoading: q.isLoading && q.fetchStatus !== "idle" }} empty={<EmptyState icon={Search} title={t("desktop.search.none")} text={t("desktop.search.noneText", { q: text })} />} />;
}

