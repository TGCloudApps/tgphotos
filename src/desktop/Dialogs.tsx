/** Diálogos do desktop (camadas do Navigator: Esc e voltar fecham). */
import { PresenceList } from "@tgcloud/ui/ui/Presence";
import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Eye, FolderOpen, FolderPlus, Plus, X } from "lucide-react";
import { notifyError } from "@tgcloud/ui/core/notices";
import { Button, Dialog, Field, IconButton } from "@tgcloud/ui/desktop/ui";
import { loadFolders, runBackup, setFolder, setShown, useBackup } from "../core/backup";
import { actions, useAlbums } from "../core/data";
import { nav, useLayers, type Layer } from "../core/nav";
import { AlbumCover, albumPeriod } from "../shared/Collections";
import { ImportView } from "../shared/Import";
import { SendToVault } from "@tgcloud/ui/ui/SendToVault";
import { FreeSpaceView, OutOfSyncView, type Btn } from "../shared/DeviceSync";
import { Viewer } from "../shared/Viewer";

/** Camadas do desktop: diálogos e o lightbox (por baixo de um diálogo aberto nele). */
export function DeskLayers({ onSignedOut }: { onSignedOut: () => void }) {
  const layers = useLayers();
  const top = layers[layers.length - 1];
  const viewer = layers.find((l): l is Extract<Layer, { type: "viewer" }> => l.type === "viewer");
  // Cada um sai com animação antes de desmontar.
  const items = [
    ...(viewer ? [{ key: "viewer", node: <Viewer layer={viewer} touch={false} /> }] : []),
    ...(top && top.type !== "viewer" ? [{ key: `${layers.length}-${top.type}`, node: <DeskLayer top={top} onSignedOut={onSignedOut} /> }] : []),
  ];
  return <PresenceList items={items} />;
}

function DeskLayer({ top, onSignedOut }: { top: Layer; onSignedOut: () => void }) {
  switch (top.type) {
    case "album-pick":
      return <AlbumPickDialog ids={top.ids} />;
    case "name":
      return <NameDialog layer={top} />;
    case "confirm":
      return <ConfirmDialog layer={top} onSignedOut={onSignedOut} />;
    case "backup":
      return <BackupDialog />;
    case "send-vault":
      return <SendToVault ids={top.ids} touch={false} onClose={nav.close} />;
    case "out-of-sync":
      return (
        <Dialog onClose={nav.close} width={520}>
          <h2 className="pb-3 text-[16px] font-semibold">Fora de sincronia</h2>
          <OutOfSyncView button={deskBtn} done={nav.close} />
        </Dialog>
      );
    case "free-space":
      return (
        <Dialog onClose={nav.close} width={460}>
          <h2 className="pb-3 text-[16px] font-semibold">Liberar espaço</h2>
          <FreeSpaceView button={deskBtn} done={nav.close} />
        </Dialog>
      );
    case "import":
      return (
        <Dialog onClose={nav.close} width={640}>
          <h2 className="pb-3 text-[16px] font-semibold">Importar do TGDrive</h2>
          <ImportView touch={false} />
        </Dialog>
      );
    default:
      return null;
  }
}

/** Fecha o diálogo; aberto do visualizador, volta para ele. */
function finish(fn: () => unknown) {
  const layers = nav.layers();
  const fromViewer = layers[layers.length - 2]?.type === "viewer";
  nav.closeThen(() => void fn(), fromViewer ? layers.length - 1 : 0);
}

function AlbumPickDialog({ ids }: { ids: number[] }) {
  const { data: albums = [] } = useAlbums();
  const [filter, setFilter] = useState("");
  const list = albums.filter((a) => a.name.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <Dialog onClose={nav.close} width={440}>
      <h2 className="text-[16px] font-semibold">Adicionar {ids.length === 1 ? "1 item" : `${ids.length} itens`} a um álbum</h2>
      <Field autoFocus placeholder="Filtrar álbuns" value={filter} onChange={(e) => setFilter(e.target.value)} className="mt-4" />
      <div className="-mx-2 mt-3 max-h-[50vh] overflow-y-auto">
        <button
          onClick={() => nav.replaceTop({ type: "name", mode: "album-new", ids })}
          className="flex h-14 w-full items-center gap-3 rounded-lg px-2 text-left text-[14px] font-semibold text-accent hover:bg-s3"
        >
          <span className="grid size-10 place-items-center rounded-lg bg-brand-soft">
            <Plus size={18} />
          </span>
          Novo álbum
        </button>
        {list.map((a) => (
          <button key={a.id} onClick={() => finish(() => actions.albumAdd(a, ids))} className="flex h-14 w-full items-center gap-3 rounded-lg px-2 text-left hover:bg-s3">
            <span className="surface size-10 shrink-0 overflow-hidden rounded-lg bg-s3">
              <AlbumCover album={a} icon={18} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-medium">{a.name}</span>
              <span className="block text-[12px] text-fg-3 tabular">
                {a.count} {a.count === 1 ? "item" : "itens"}
                {albumPeriod(a) && ` · ${albumPeriod(a)}`}
              </span>
            </span>
          </button>
        ))}
      </div>
      <div className="mt-4 flex justify-end">
        <Button onClick={nav.close}>Cancelar</Button>
      </div>
    </Dialog>
  );
}

function NameDialog({ layer }: { layer: Extract<Layer, { type: "name" }> }) {
  const { data: albums = [] } = useAlbums();
  const current = layer.id ? albums.find((a) => a.id === layer.id) : undefined;
  const [name, setName] = useState(current?.name ?? "");
  const submit = () => {
    const n = name.trim();
    if (!n) return;
    if (layer.mode === "album-new") {
      const ids = layer.ids ?? [];
      nav.closeThen(async () => {
        const id = await actions.albumCreate(n, ids).catch(() => 0);
        if (id && !ids.length) nav.album(id);
      }, 0);
    } else if (layer.id) {
      const id = layer.id;
      nav.closeThen(() => void actions.albumRename(id, n).catch(() => {}));
    }
  };
  return (
    <Dialog onClose={nav.close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2 className="text-[16px] font-semibold">{layer.mode === "album-new" ? "Novo álbum" : "Renomear álbum"}</h2>
        {layer.mode === "album-new" && !!layer.ids?.length && (
          <p className="mt-1 text-[13px] text-fg-2">Com {layer.ids.length === 1 ? "1 item" : `${layer.ids.length} itens`} selecionados.</p>
        )}
        <Field autoFocus placeholder="Nome do álbum" value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} className="mt-4" />
        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={nav.close}>Cancelar</Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            {layer.mode === "album-new" ? "Criar" : "Renomear"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ConfirmDialog({ layer, onSignedOut }: { layer: Extract<Layer, { type: "confirm" }>; onSignedOut: () => void }) {
  const n = layer.ids.length;
  const text = {
    purge: {
      title: n === 1 ? "Apagar para sempre?" : `Apagar ${n} itens para sempre?`,
      body: "As fotos e vídeos saem do vault e deste aparelho. Não dá para desfazer.",
      cta: "Apagar",
      run: () => actions.purge(layer.ids),
    },
    empty: {
      title: "Esvaziar a lixeira?",
      body: "Tudo na lixeira sai do vault e deste aparelho. Não dá para desfazer.",
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
    <Dialog onClose={nav.close} width={420}>
      <h2 className="text-[16px] font-semibold">{text.title}</h2>
      <p className="mt-2 text-[14px] text-fg-2">{text.body}</p>
      <div className="mt-6 flex justify-end gap-2">
        <Button onClick={nav.close}>Cancelar</Button>
        <Button variant="danger" onClick={() => nav.closeThen(() => void text.run(), 0)}>
          {text.cta}
        </Button>
      </div>
    </Dialog>
  );
}

/** Pastas observadas: o que aparecer nelas sobe sozinho (a cada 5 min e ao abrir). */
function BackupDialog() {
  const folders = useBackup((s) => s.folders);
  const shownAll = useBackup((s) => s.shown);
  const shown = shownAll.filter((f) => !folders.includes(f));
  const running = useBackup((s) => s.running);
  useEffect(() => {
    void loadFolders();
  }, []);
  const add = async (backup: boolean) => {
    if (!isTauri()) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true, title: backup ? "Pasta para o backup automático" : "Pasta para mostrar em Fotos (sem backup)" });
      if (typeof dir === "string") await (backup ? setFolder(dir, true) : setShown(dir, true));
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Dialog onClose={nav.close} width={520}>
      <h2 className="text-[16px] font-semibold">Backup automático</h2>
      <p className="mt-1 text-[13px] text-fg-2">
        Fotos e vídeos novos das pastas abaixo (e das subpastas) sobem sozinhos para este vault: ao abrir o app e a cada 5 minutos enquanto ele estiver aberto.
        O que o vault já tem não sobe de novo.
      </p>
      <div className="surface mt-4 overflow-hidden rounded-xl bg-s2">
        {folders.map((f) => (
          <div key={f} className="flex h-12 items-center gap-3 border-b border-hairline px-3 last:border-0">
            <FolderOpen size={18} className="shrink-0 text-brand" />
            <span className="min-w-0 flex-1 truncate text-[13px]" title={f}>
              {f}
            </span>
            <IconButton label="Tirar do backup" onClick={() => void setFolder(f, false)}>
              <X />
            </IconButton>
          </div>
        ))}
        {!folders.length && <p className="px-3 py-4 text-[13px] text-fg-3">Nenhuma pasta ainda.</p>}
      </div>
      <h3 className="mt-6 text-[14px] font-semibold">Mostrar em Fotos, sem backup</h3>
      <p className="mt-1 text-[13px] text-fg-2">Aparecem na linha do tempo como “sem backup”; nada sobe sozinho.</p>
      <div className="surface mt-3 overflow-hidden rounded-xl bg-s2">
        {shown.map((f) => (
          <div key={f} className="flex h-12 items-center gap-3 border-b border-hairline px-3 last:border-0">
            <Eye size={18} className="shrink-0 text-fg-3" />
            <span className="min-w-0 flex-1 truncate text-[13px]" title={f}>
              {f}
            </span>
            <IconButton label="Não mostrar mais" onClick={() => void setShown(f, false)}>
              <X />
            </IconButton>
          </div>
        ))}
        {!shown.length && <p className="px-3 py-4 text-[13px] text-fg-3">Nenhuma pasta.</p>}
      </div>
      <div className="mt-6 flex items-center justify-between gap-2">
        <div className="flex gap-2">
          <Button onClick={() => void add(true)}>
            <FolderPlus /> Backup…
          </Button>
          <Button variant="ghost" onClick={() => void add(false)}>
            <Eye /> Só mostrar…
          </Button>
        </div>
        <div className="flex gap-2">
          <Button onClick={nav.close}>Fechar</Button>
          <Button variant="primary" disabled={!folders.length || running} onClick={() => void runBackup(true)}>
            {running ? "Verificando…" : "Fazer backup agora"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Botões dos diálogos para o conteúdo compartilhado (DeviceSync). */
const deskBtn: Btn = (label, run, primary, disabled) => (
  <Button key={label} variant={primary ? "primary" : undefined} disabled={disabled} onClick={run}>
    {label}
  </Button>
);
