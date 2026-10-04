/**
 * Lixeira do aparelho na interface: aviso e resolução do que está "fora de
 * sincronia" (lixeira do vault e a deste aparelho discordando) e "liberar
 * espaço". As cascas põem o conteúdo numa folha (celular) ou diálogo (desktop).
 */
import { useState, type ReactNode } from "react";
import { HardDriveUpload, RefreshCwOff } from "lucide-react";
import { available as onAndroid } from "@tgcloud/ui/core/android";
import { formatSize } from "@tgcloud/ui/core/format";
import { thumbUrl } from "@tgcloud/ui/core/thumbs";
import { useDevice } from "../core/deviceStore";
import { freeSpace, outOfSync } from "../core/deviceTrash";
import { nav } from "../core/nav";

/** Botão da casca: rótulo, ação e se é o principal. */
export type Btn = (label: string, run: () => void, primary?: boolean, disabled?: boolean) => ReactNode;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

/** Na Lixeira: quantos itens estão fora de sincronia, com o atalho para resolver. */
export function OutOfSyncBanner({ touch }: { touch: boolean }) {
  const n = useDevice((s) => s.out.vaultOnly.length + s.out.deviceOnly.length);
  if (!n) return null;
  return (
    <button
      onClick={() => nav.open({ type: "out-of-sync" })}
      className={`surface flex w-full items-center gap-3 rounded-xl border border-warning/30 bg-warning-soft text-left ${touch ? "min-h-14 px-3.5 py-2.5 active:brightness-110" : "min-h-12 px-3.5 py-2 hover:brightness-110"}`}
    >
      <RefreshCwOff size={20} className="shrink-0 text-warning" />
      <span className="min-w-0 flex-1">
        <span className={`block font-semibold text-fg ${touch ? "text-[14px]" : "text-[13px]"}`}>{plural(n, "1 item fora de sincronia", "itens fora de sincronia")}</span>
        <span className="block text-[12px] text-fg-2">A lixeira do vault e a deste aparelho discordam.</span>
      </span>
      <span className="shrink-0 text-[13px] font-semibold text-accent">Resolver</span>
    </button>
  );
}

/** Algumas miniaturas do vault (as que existem). */
function Strip({ ids }: { ids: number[] }) {
  const shown = ids.slice(0, 6);
  return (
    <div className="mt-2 flex gap-1.5">
      {shown.map((id) => (
        <div key={id} className="size-11 shrink-0 overflow-hidden rounded-md bg-s3">
          <img src={thumbUrl(id)} alt="" className="size-full object-cover" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
        </div>
      ))}
      {ids.length > shown.length && <div className="grid size-11 shrink-0 place-items-center rounded-md bg-s3 text-[12px] font-semibold text-fg-2 tabular">+{ids.length - shown.length}</div>}
    </div>
  );
}

function Group({ title, text, ids, children }: { title: string; text: string; ids: number[]; children: ReactNode }) {
  return (
    <section className="surface rounded-xl bg-s3 p-3.5">
      <p className="text-[14px] font-semibold">{title}</p>
      <p className="mt-0.5 text-[12px] text-fg-2">{text}</p>
      <Strip ids={ids} />
      <div className="mt-3 flex flex-wrap gap-2">{children}</div>
    </section>
  );
}

/** Os dois lados do que discorda, cada um com as duas saídas. */
export function OutOfSyncView({ button, done }: { button: Btn; done: () => void }) {
  const { vaultOnly, deviceOnly } = useDevice((s) => s.out);
  const [busy, setBusy] = useState(false);
  const act = (fn: () => Promise<boolean>) => () => {
    setBusy(true);
    void fn().finally(() => setBusy(false));
  };
  if (!vaultOnly.length && !deviceOnly.length) {
    return (
      <>
        <p className="text-[14px] text-fg-2">Está tudo em sincronia.</p>
        <div className="mt-4 flex justify-end">{button("Fechar", done, true)}</div>
      </>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-fg-2">
        Acontece quando algo é apagado ou restaurado em outro aparelho, ou por outro app. Escolha qual lado vale.
      </p>
      {vaultOnly.length > 0 && (
        <Group
          title={plural(vaultOnly.length, "1 item na lixeira do vault", "itens na lixeira do vault")}
          text="Mas o original continua neste aparelho."
          ids={vaultOnly.map((l) => l.media_id)}
        >
          {button("Mover para a lixeira do aparelho", act(() => outOfSync.trashOnDevice(vaultOnly)), true, busy)}
          {button("Restaurar no vault", act(() => outOfSync.restoreInVault(vaultOnly)), false, busy)}
        </Group>
      )}
      {deviceOnly.length > 0 && (
        <Group
          title={plural(deviceOnly.length, "1 original na lixeira do aparelho", "originais na lixeira do aparelho")}
          text="Mas a mídia continua fora da lixeira do vault."
          ids={deviceOnly.map((i) => i.media_id)}
        >
          {button("Restaurar no aparelho", act(() => outOfSync.restoreOnDevice(deviceOnly)), true, busy)}
          {button("Mover para a lixeira do vault", act(() => outOfSync.trashInVault(deviceOnly)), false, busy)}
        </Group>
      )}
    </div>
  );
}

/** Coleções: atalho para liberar espaço, quando há originais que já estão no vault. */
export function FreeSpaceEntry({ touch }: { touch: boolean }) {
  const free = useDevice((s) => s.freeable);
  if (!free.length) return null;
  const bytes = free.reduce((a, l) => a + l.size, 0);
  return (
    <button
      onClick={() => nav.open({ type: "free-space" })}
      className={`surface flex items-center gap-3 rounded-xl bg-s1 px-3.5 text-left ${touch ? "col-span-2 min-h-14 py-2 active:bg-s3" : "min-h-12 py-1.5 hover:bg-s3"}`}
    >
      <HardDriveUpload size={20} className="shrink-0 text-brand" />
      <span className="min-w-0">
        <span className={`block font-semibold text-fg ${touch ? "text-[15px]" : "text-[14px]"}`}>Liberar espaço</span>
        <span className="block truncate text-[12px] text-fg-2 tabular">{formatSize(bytes)} já estão no vault</span>
      </span>
    </button>
  );
}

/** Apagar do aparelho os originais que já estão no vault. */
export function FreeSpaceView({ button, done }: { button: Btn; done: () => void }) {
  const free = useDevice((s) => s.freeable);
  const [busy, setBusy] = useState(false);
  const bytes = free.reduce((a, l) => a + l.size, 0);
  if (!free.length) {
    return (
      <>
        <p className="text-[14px] text-fg-2">Nada para liberar: o que está neste aparelho ainda não tem cópia no vault.</p>
        <div className="mt-4 flex justify-end">{button("Fechar", done, true)}</div>
      </>
    );
  }
  return (
    <>
      <p className="text-[14px] text-fg-2">
        {plural(free.length, "1 foto ou vídeo deste aparelho já está", "fotos e vídeos deste aparelho já estão")} no vault. Apagar as cópias do aparelho libera{" "}
        <b className="text-fg">{formatSize(bytes)}</b>; elas continuam na linha do tempo, vindas do vault.
      </p>
      <p className="mt-2 text-[13px] text-fg-3">
        {onAndroid ? "As cópias saem do aparelho de vez (não vão para a lixeira)." : "As cópias vão para a lixeira do sistema."}
      </p>
      <div className="mt-5 flex justify-end gap-2">
        {button("Cancelar", done, false, busy)}
        {button(
          busy ? "Liberando…" : `Liberar ${formatSize(bytes)}`,
          () => {
            setBusy(true);
            void freeSpace(free).then((ok) => {
              setBusy(false);
              if (ok) done();
            });
          },
          true,
          busy,
        )}
      </div>
    </>
  );
}
