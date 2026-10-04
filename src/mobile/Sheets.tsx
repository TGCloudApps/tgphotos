/** Folhas do celular (camadas do Navigator: o voltar fecha). */
import { useEffect, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  CloudUpload,
  Download,
  FolderDown,
  FolderOpen,
  FolderPlus,
  FolderUp,
  HardDriveDownload,
  ImagePlus,
  Images,
  LogOut,
  MapPinOff,
  Pencil,
  Plus,
  RefreshCw,
  Repeat,
  Send,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { android, available as onAndroid } from "@tgcloud/ui/core/android";
import { formatSize } from "@tgcloud/ui/core/format";
import { notifyError } from "@tgcloud/ui/core/notices";
import { transfers } from "@tgcloud/ui/core/transfers";
import { app } from "@tgcloud/ui/core/app";
import { Sheet, SheetButton, SheetItem } from "@tgcloud/ui/ui/Sheet";
import type { Session } from "@tgcloud/ui/ui/Boot";
import { api } from "../core/api";
import { actions, findMedia, refresh, useAlbums, useUsage } from "../core/data";
import { nav, useRoute, type Layer } from "../core/nav";
import { AlbumCover, albumPeriod } from "../shared/Collections";
import { Switch } from "../shared/Switch";
import { ImportView } from "../shared/Import";
import { moveLocal, renameLocal } from "../core/localActions";
import { loadFolders, markConfigured, runBackup, setFolder, useBackup } from "../core/backup";
import type { DeviceFolder, MediaAccess } from "@tgcloud/ui/core/android";

/**
 * Fecha a folha e roda `fn`. Aberta do visualizador, volta para ele; aberta
 * da seleção, fecha a seleção junto (a ação já consumiu os itens).
 */
function finish(fn: () => unknown) {
  const layers = nav.layers();
  const fromViewer = layers[layers.length - 2]?.type === "viewer";
  nav.closeThen(() => void fn(), fromViewer ? layers.length - 1 : 0);
}

/** Enviar: seletor do sistema (só fotos e vídeos) ou uma pasta inteira. */
export function AddSheet({ fileInput, album }: { fileInput: React.RefObject<HTMLInputElement | null>; album: number }) {
  const pick = (folder: boolean) =>
    nav.closeThen(async () => {
      if (!onAndroid) return fileInput.current?.click();
      try {
        const items = folder ? await android.pickFolder() : await android.pickMedia();
        await transfers.uploadUris(items, album);
      } catch (e) {
        notifyError(e);
      }
    });
  return (
    <Sheet title={<p className="text-[16px] font-semibold">{album ? "Adicionar ao álbum" : "Enviar para o TGPhotos"}</p>}>
      <SheetItem icon={<ImagePlus />} onClick={() => pick(false)}>
        Fotos e vídeos
      </SheetItem>
      {onAndroid && (
        <SheetItem icon={<FolderUp />} hint="só fotos e vídeos" onClick={() => pick(true)}>
          Uma pasta inteira
        </SheetItem>
      )}
    </Sheet>
  );
}

/** Mais ações sobre a seleção (ou o item aberto no visualizador). */
export function ActionsSheet({ ids }: { ids: number[] }) {
  const route = useRoute();
  const album = route.dest === "album" ? route.album : 0;
  const single = ids.length === 1 ? findMedia(ids[0]) : undefined;
  const archived = route.dest === "archive" || !!single?.archived;
  return (
    <Sheet title={<p className="text-[16px] font-semibold">{ids.length === 1 ? (single?.name ?? "1 item") : `${ids.length} itens`}</p>}>
      <SheetItem icon={<Download />} onClick={() => finish(() => actions.download(ids))}>
        Baixar
      </SheetItem>
      <SheetItem icon={<Images />} onClick={() => nav.replaceTop({ type: "album-pick", ids })}>
        Adicionar a um álbum
      </SheetItem>
      {/* Volta para a seleção depois (ela continua, para fazer mais coisas). */}
      <SheetItem icon={<Send />} onClick={() => nav.replaceTop({ type: "send-vault", ids })}>
        Enviar para outro vault
      </SheetItem>
      {album > 0 && single && (
        <SheetItem icon={<Star />} onClick={() => finish(() => actions.albumCover(album, single.id))}>
          Usar como capa do álbum
        </SheetItem>
      )}
      {album > 0 && (
        <SheetItem icon={<X />} onClick={() => finish(() => actions.albumRemove(album, ids))}>
          Remover do álbum
        </SheetItem>
      )}
      {archived ? (
        <SheetItem icon={<ArchiveRestore />} onClick={() => finish(() => actions.archive(ids, false))}>
          Desarquivar
        </SheetItem>
      ) : (
        <SheetItem icon={<Archive />} onClick={() => finish(() => actions.archive(ids, true))}>
          Arquivar
        </SheetItem>
      )}
    </Sheet>
  );
}

/** Escolher o álbum de destino (ou criar um com a seleção). */
export function AlbumPickSheet({ ids }: { ids: number[] }) {
  const { data: albums = [] } = useAlbums();
  return (
    <Sheet title={<p className="text-[16px] font-semibold">Adicionar {ids.length === 1 ? "1 item" : `${ids.length} itens`} a…</p>}>
      <SheetItem icon={<Plus />} onClick={() => nav.replaceTop({ type: "name", mode: "album-new", ids })}>
        Novo álbum
      </SheetItem>
      <div className="max-h-[50vh] overflow-y-auto">
        {albums.map((a) => (
          <button
            key={a.id}
            onClick={() => finish(() => actions.albumAdd(a, ids))}
            className="flex min-h-16 w-full items-center gap-4 px-5 text-left active:bg-s4"
          >
            <span className="surface size-12 shrink-0 overflow-hidden rounded-lg bg-s3">
              <AlbumCover album={a} icon={20} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-medium">{a.name}</span>
              <span className="block text-[12px] text-fg-3 tabular">
                {a.count} {a.count === 1 ? "item" : "itens"}
                {albumPeriod(a) && ` · ${albumPeriod(a)}`}
              </span>
            </span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

export function NameSheet({ layer }: { layer: Extract<Layer, { type: "name" }> }) {
  const { data: albums = [] } = useAlbums();
  const current = layer.id ? albums.find((a) => a.id === layer.id) : undefined;
  const [name, setName] = useState(current?.name ?? "");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      if (layer.mode === "album-new") {
        const ids = layer.ids ?? [];
        // Fecha tudo (inclusive a seleção) e abre o álbum novo.
        nav.closeThen(async () => {
          const id = await actions.albumCreate(name.trim(), ids).catch(() => 0);
          if (id && !ids.length) nav.album(id);
        }, 0);
      } else if (layer.id) {
        await actions.albumRename(layer.id, name.trim());
        nav.close();
      }
    } catch {
      setBusy(false);
    }
  };
  return (
    <Sheet>
      <form
        className="px-5 pt-2 pb-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="text-[18px] font-semibold">{layer.mode === "album-new" ? "Novo álbum" : "Renomear álbum"}</p>
        {layer.mode === "album-new" && !!layer.ids?.length && (
          <p className="mt-1 text-[13px] text-fg-2">Com {layer.ids.length === 1 ? "1 item" : `${layer.ids.length} itens`} selecionados.</p>
        )}
        <input
          autoFocus
          value={name}
          placeholder="Nome do álbum"
          onChange={(e) => setName(e.target.value)}
          className="surface mt-4 h-12 w-full rounded-xl border border-line bg-s3 px-4 text-[16px] outline-none placeholder:text-fg-3 focus:border-brand focus:ring-[3px] focus:ring-brand/25"
        />
        <div className="mt-5 flex gap-3">
          <SheetButton onClick={nav.close}>Cancelar</SheetButton>
          <SheetButton type="submit" primary disabled={!name.trim() || busy}>
            {layer.mode === "album-new" ? "Criar" : "Salvar"}
          </SheetButton>
        </div>
      </form>
    </Sheet>
  );
}

export function ConfirmSheet({ layer, onSignedOut }: { layer: Extract<Layer, { type: "confirm" }>; onSignedOut: () => void }) {
  const n = layer.ids.length;
  const text = {
    purge: {
      title: n === 1 ? "Apagar para sempre?" : `Apagar ${n} itens para sempre?`,
      body: "As fotos e vídeos saem do canal do Telegram. Não dá para desfazer.",
      cta: "Apagar",
      run: () => actions.purge(layer.ids),
    },
    empty: {
      title: "Esvaziar a lixeira?",
      body: "Tudo na lixeira sai do canal do Telegram. Não dá para desfazer.",
      cta: "Esvaziar",
      run: () => actions.emptyTrash(),
    },
    "album-delete": {
      title: "Apagar o álbum?",
      body: "Só o álbum some. As fotos e vídeos continuam na biblioteca.",
      cta: "Apagar álbum",
      run: async () => {
        await actions.albumDelete(layer.ids[0]);
        nav.dest("collections");
      },
    },
    signout: {
      title: "Sair da conta?",
      body: "Suas fotos continuam no canal. Para voltar, é só entrar de novo.",
      cta: "Sair",
      run: onSignedOut,
    },
  }[layer.action];
  return (
    <Sheet>
      <div className="px-5 pt-2 pb-3">
        <p className="text-[18px] font-semibold">{text.title}</p>
        <p className="mt-2 text-[14px] text-fg-2">{text.body}</p>
        <div className="mt-6 flex gap-3">
          <SheetButton onClick={nav.close}>Cancelar</SheetButton>
          <SheetButton primary danger onClick={() => nav.closeThen(() => void text.run(), 0)}>
            {text.cta}
          </SheetButton>
        </div>
      </div>
    </Sheet>
  );
}

export function AccountSheet({ session }: { session: Session }) {
  const { data: usage } = useUsage();
  return (
    <Sheet
      title={
        <div className="flex items-center gap-3">
          <div className="step grid size-10 place-items-center rounded-xl bg-brand text-white">
            <app.icon size={20} />
          </div>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold">{session.vault.name}</p>
            <p className="text-[12px] text-fg-3 tabular">
              {usage ? `${usage.photos.toLocaleString("pt-BR")} fotos · ${usage.videos.toLocaleString("pt-BR")} vídeos · ${formatSize(usage.bytes)}` : "…"}
            </p>
          </div>
        </div>
      }
    >
      <SheetItem icon={<Repeat />} onClick={() => nav.closeThen(session.switchVault)}>
        Trocar de vault
      </SheetItem>
      {onAndroid && (
        <SheetItem icon={<FolderDown />} hint={android.downloadTree()?.name ?? "não escolhida"} onClick={() => nav.closeThen(() => void android.chooseDownloadTree())}>
          Pasta de downloads
        </SheetItem>
      )}
      {onAndroid && (
        <SheetItem icon={<CloudUpload />} onClick={() => nav.replaceTop({ type: "backup" })}>
          Backup automático
        </SheetItem>
      )}
      <SheetItem icon={<HardDriveDownload />} onClick={() => nav.replaceTop({ type: "import" })}>
        Importar do TGDrive
      </SheetItem>
      <SheetItem
        icon={<RefreshCw />}
        onClick={() =>
          nav.closeThen(() =>
            api
              .syncNow()
              .then(() => refresh())
              .catch(notifyError),
          )
        }
      >
        Sincronizar agora
      </SheetItem>
      <SheetItem icon={<LogOut />} danger onClick={() => nav.replaceTop({ type: "confirm", action: "signout", ids: [] })}>
        Sair da conta
      </SheetItem>
    </Sheet>
  );
}

/** "Compartilhar → TGPhotos" de outro app. */
export function ReceiveSheet({ layer }: { layer: Extract<Layer, { type: "receive" }> }) {
  const media = layer.items.filter((i) => /^(image|video)\//.test(i.mime));
  const skipped = layer.items.length - media.length;
  const n = media.length;
  return (
    <Sheet title={<p className="text-[16px] font-semibold">Enviar {n === 1 ? `“${media[0].name}”` : `${n} itens`} para o {app.name}</p>}>
      <div className="px-5 pb-2">
        {skipped > 0 && <p className="mb-3 text-[13px] text-fg-2">{skipped === 1 ? "1 arquivo não é foto nem vídeo e fica de fora." : `${skipped} arquivos não são fotos nem vídeos e ficam de fora.`}</p>}
        <div className="flex gap-3 pt-1">
          <SheetButton onClick={nav.close}>Cancelar</SheetButton>
          <SheetButton primary disabled={!n} onClick={() => nav.closeThen(() => void transfers.uploadUris(media, 0))}>
            Enviar
          </SheetButton>
        </div>
      </div>
    </Sheet>
  );
}

/** Backup automático (Android): acesso às mídias e pastas do aparelho. */
export function BackupSheet() {
  const [access, setAccess] = useState<MediaAccess>(() => android.mediaAccess());
  const [folders, setFolders] = useState<DeviceFolder[]>([]);
  const on = useBackup((s) => s.folders);
  const running = useBackup((s) => s.running);
  const allowed = access.full || access.partial;

  useEffect(() => {
    markConfigured();
    void loadFolders();
  }, []);
  useEffect(() => {
    if (allowed) setFolders(android.mediaFolders());
  }, [allowed]);

  const ask = async () => setAccess(await android.requestMedia());

  return (
    <Sheet title={<p className="text-[16px] font-semibold">Backup automático</p>}>
      <div className="px-5 pb-2">
        <p className="text-[14px] text-fg-2">Fotos e vídeos novos das pastas ligadas sobem sozinhos para este vault: ao abrir o app e quando o aparelho registra mídia nova.</p>
        {!allowed && (
          <div className="mt-4">
            <SheetButton primary onClick={ask}>
              Permitir acesso às fotos
            </SheetButton>
          </div>
        )}
        {access.partial && (
          <p className="surface mt-3 rounded-lg bg-s3 px-3 py-2.5 text-[13px] text-fg-2">
            Acesso só às fotos escolhidas: o backup vê apenas essas.{" "}
            <button onClick={ask} className="font-semibold text-accent">
              Permitir todas
            </button>
          </p>
        )}
        {allowed && !access.location && (
          <p className="mt-3 flex items-start gap-2 text-[13px] text-fg-3">
            <MapPinOff size={16} className="mt-0.5 shrink-0" /> Sem a permissão de localização de mídia, as fotos sobem sem o GPS.
          </p>
        )}
      </div>
      {allowed && (
        <>
          <p className="px-5 pt-3 pb-1 text-[12px] font-semibold tracking-wide text-fg-3 uppercase">Pastas do aparelho</p>
          <div className="max-h-[45vh] overflow-y-auto">
            {folders.map((f) => {
              const active = on.includes(f.path);
              return (
                <button key={f.path} onClick={() => void setFolder(f.path, !active)} className="flex min-h-16 w-full items-center gap-4 px-5 text-left active:bg-s4">
                  <span className={`surface grid size-12 shrink-0 place-items-center rounded-lg ${active ? "bg-brand-soft text-brand" : "bg-s3 text-fg-3"}`}>
                    <FolderUp size={20} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium">{f.name}</span>
                    <span className="block truncate text-[12px] text-fg-3 tabular">
                      {f.count.toLocaleString("pt-BR")} · {f.path || "raiz"}
                    </span>
                  </span>
                  <Switch on={active} touch />
                </button>
              );
            })}
            {!folders.length && <p className="px-5 py-4 text-[14px] text-fg-3">Nenhuma foto ou vídeo encontrado no aparelho.</p>}
          </div>
          <div className="flex gap-3 px-5 pt-3 pb-2">
            <SheetButton primary disabled={!on.length || running} onClick={() => void runBackup(true)}>
              {running ? "Verificando…" : "Fazer backup agora"}
            </SheetButton>
          </div>
        </>
      )}
    </Sheet>
  );
}

export function ImportSheet() {
  return (
    <Sheet title={<p className="text-[16px] font-semibold">Importar do TGDrive</p>}>
      <ImportView touch />
    </Sheet>
  );
}

/** Menu ⋮ do álbum aberto. */
export function AlbumMenuSheet({ id }: { id: number }) {
  const { data: albums = [] } = useAlbums();
  const a = albums.find((x) => x.id === id);
  return (
    <Sheet title={<p className="truncate text-[16px] font-semibold">{a?.name ?? "Álbum"}</p>}>
      <SheetItem icon={<ImagePlus />} onClick={() => nav.replaceTop({ type: "add" })}>
        Adicionar fotos
      </SheetItem>
      <SheetItem icon={<Pencil />} onClick={() => nav.replaceTop({ type: "name", mode: "album-rename", id })}>
        Renomear
      </SheetItem>
      <SheetItem icon={<Trash2 />} danger onClick={() => nav.replaceTop({ type: "confirm", action: "album-delete", ids: [id] })}>
        Apagar álbum
      </SheetItem>
    </Sheet>
  );
}

/** Mover fotos do aparelho para outra pasta (ou uma nova, em Pictures). */
export function DeviceMoveSheet({ uris }: { uris: string[] }) {
  const folders = android.mediaFolders();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const go = (folder: string) => nav.closeThen(() => void moveLocal(uris, folder));
  return (
    <Sheet title={<p className="text-[16px] font-semibold">Mover {uris.length === 1 ? "1 item" : `${uris.length} itens`} para…</p>}>
      {creating ? (
        <form
          className="px-5 pt-1 pb-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) go(`Pictures/${name.trim()}`);
          }}
        >
          <input
            autoFocus
            value={name}
            placeholder="Nome da pasta"
            onChange={(e) => setName(e.target.value.replace(/[/\\]/g, ""))}
            className="surface h-12 w-full rounded-xl border border-line bg-s3 px-4 text-[16px] outline-none placeholder:text-fg-3 focus:border-brand focus:ring-[3px] focus:ring-brand/25"
          />
          <p className="mt-2 text-[12px] text-fg-3">Fica em Pictures/{name.trim() || "…"}</p>
          <div className="mt-4 flex gap-3">
            <SheetButton onClick={() => setCreating(false)}>Voltar</SheetButton>
            <SheetButton type="submit" primary disabled={!name.trim()}>
              Mover
            </SheetButton>
          </div>
        </form>
      ) : (
        <>
          <SheetItem icon={<FolderPlus />} onClick={() => setCreating(true)}>
            Nova pasta
          </SheetItem>
          <div className="max-h-[50vh] overflow-y-auto">
            {folders.map((f) => (
              <SheetItem key={f.path} icon={<FolderOpen />} hint={f.count.toLocaleString("pt-BR")} onClick={() => go(f.path)}>
                {f.name}
              </SheetItem>
            ))}
          </div>
        </>
      )}
    </Sheet>
  );
}

/** Renomear uma foto do aparelho (a extensão fica). */
export function DeviceRenameSheet({ uri, name: initial }: { uri: string; name: string }) {
  const dot = initial.lastIndexOf(".");
  const ext = dot > 0 ? initial.slice(dot) : "";
  const [name, setName] = useState(dot > 0 ? initial.slice(0, dot) : initial);
  return (
    <Sheet>
      <form
        className="px-5 pt-2 pb-3"
        onSubmit={(e) => {
          e.preventDefault();
          const n = name.trim();
          if (n) nav.closeThen(() => void renameLocal(uri, n + ext));
        }}
      >
        <p className="text-[18px] font-semibold">Renomear</p>
        <div className="mt-4 flex items-center gap-2">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value.replace(/[/\\]/g, ""))}
            onFocus={(e) => e.target.select()}
            className="surface h-12 min-w-0 flex-1 rounded-xl border border-line bg-s3 px-4 text-[16px] outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/25"
          />
          {ext && <span className="text-[15px] text-fg-3">{ext}</span>}
        </div>
        <div className="mt-5 flex gap-3">
          <SheetButton onClick={nav.close}>Cancelar</SheetButton>
          <SheetButton type="submit" primary disabled={!name.trim()}>
            Salvar
          </SheetButton>
        </div>
      </form>
    </Sheet>
  );
}
