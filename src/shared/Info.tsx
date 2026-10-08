/** Informações de uma mídia (painel do lightbox no desktop, folha no celular). */
import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Aperture, CloudOff, Calendar, ExternalLink, FolderOpen, Image as ImageIcon, Images, MapPin, ScanFace, Type, Upload } from "lucide-react";
import { formatDuration, formatFullDate, formatSize } from "@tgcloud/ui/core/format";
import { api, type Camera, type Details, type Media, type MediaFace } from "../core/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { notify, notifyError } from "@tgcloud/ui/core/notices";
import { FaceAvatar, usePeople } from "./People";
import { useDetails } from "../core/data";
import { nav } from "../core/nav";
import { wallClock } from "../timeline/layout";

export function Info({ media, touch }: { media: Media; touch: boolean }) {
  const { data } = useDetails(media.id);
  // O que a análise em segundo plano sabe: lugar, pessoas, texto.
  const { data: intel } = useQuery({ queryKey: ["media-intel", media.id], queryFn: () => api.mediaIntel(media.id), enabled: media.id > 0 });
  const d: Details | undefined = data ?? undefined;
  const when = wallClock(media);
  const video = media.mime.startsWith("video/");
  const dims = media.width && media.height ? `${media.width} × ${media.height}` : null;
  const mp = media.width && media.height && !video ? `${((media.width * media.height) / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MP` : null;

  return (
    <div className={`space-y-1 ${touch ? "" : "text-[13px]"}`}>
      <Row icon={<Calendar />} title={capitalize(when.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }))}>
        {when.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
        {media.tz !== null && ` · ${tzLabel(media.tz)}`}
      </Row>
      <Row icon={video ? <Images /> : <ImageIcon />} title={media.name} breakAll>
        {[mp, dims, video && media.duration ? formatDuration(media.duration) : null, formatSize(media.size)].filter(Boolean).join(" · ")}
      </Row>
      {d?.camera && <CameraRow camera={d.camera} />}
      {media.lat !== null && media.lon !== null && (
        <Row icon={<MapPin />} title={intel?.place || `${media.lat.toFixed(5)}, ${media.lon.toFixed(5)}`}>
          {intel?.place && <span className="mr-2">{`${media.lat.toFixed(4)}, ${media.lon.toFixed(4)}`}</span>}
          <button
            onClick={() => openExternal(`https://www.openstreetmap.org/?mlat=${media.lat}&mlon=${media.lon}#map=16/${media.lat}/${media.lon}`)}
            className="inline-flex items-center gap-1 text-accent hover:underline"
          >
            Abrir no mapa <ExternalLink size={12} />
          </button>
        </Row>
      )}
      {media.lat !== null && media.lon !== null && <MiniMap lat={media.lat} lon={media.lon} />}
      {!!intel?.faces.length && <FacesRow mediaId={media.id} faces={intel.faces} touch={touch} />}
      {intel?.text && (
        <Row icon={<Type />} title="Texto na imagem">
          <span className="line-clamp-4 whitespace-pre-line">{intel.text}</span>
        </Row>
      )}
      {!!d?.albums.length && (
        <Row icon={<Images />} title="Álbuns">
          <span className="mt-1 flex flex-wrap gap-1.5">
            {d.albums.map((a) => (
              <button
                key={a.id}
                onClick={() => nav.closeThen(() => nav.album(a.id))}
                className="surface rounded-full bg-s3 px-2.5 py-1 text-[12px] font-medium text-fg hover:bg-s4"
              >
                {a.name}
              </button>
            ))}
          </span>
        </Row>
      )}
      {d?.origin && (
        <Row icon={<FolderOpen />} title="Pasta de origem">
          {d.origin}
        </Row>
      )}
      {media.id < 0 ? (
        <Row icon={<CloudOff />} title="Só neste aparelho">
          Ainda sem backup no vault.
        </Row>
      ) : (
        <Row icon={<Upload />} title={media.local ? "Enviado deste aparelho" : "Enviado"}>
          {formatFullDate(media.added_at)}
        </Row>
      )}
    </div>
  );
}

/** Pessoas reconhecidas na foto; tocar abre o que fazer com aquele rosto. */
function FacesRow({ mediaId, faces, touch }: { mediaId: number; faces: MediaFace[]; touch: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<number | null>(null);
  const [name, setName] = useState("");
  const face = faces.find((f) => f.id === open);
  const { data: people } = usePeople();
  const q = name.trim().toLocaleLowerCase("pt-BR");
  // Quem já tem nome e combina com o que está sendo digitado.
  const hints = q ? (people ?? []).filter((p) => p.name && p.uid !== face?.person && p.name.toLocaleLowerCase("pt-BR").includes(q)).slice(0, 5) : [];
  // Sem digitar: escolher entre as pessoas que já existem (com nome primeiro; sem nome também).
  const pick = (people ?? []).filter((p) => !p.hidden && p.uid !== face?.person).slice(0, 40);
  const done = () => {
    setOpen(null);
    setName("");
    void qc.invalidateQueries({ queryKey: ["media-intel", mediaId] });
    void qc.invalidateQueries({ queryKey: ["people"] });
  };
  const give = async (to?: { uid: string; name: string }) => {
    if (!face || (!to && !name.trim())) return;
    // Nome que já existe: o rosto vai para essa pessoa; senão, pessoa nova.
    const same = to ?? (await api.peopleList()).find((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase());
    try {
      await api.facePut(face.id, same?.uid ?? null, same ? null : name.trim());
      notify({ text: same ? (same.name ? `Adicionado a ${same.name}` : "Adicionado à pessoa") : `“${name.trim()}” criada`, tone: "success" });
    } catch (e) {
      notifyError(e);
    }
    done();
  };
  const reject = async () => {
    if (!face) return;
    try {
      await api.faceReject(face.id);
      notify({ text: `Tirado de ${face.name}`, tone: "success" });
    } catch (e) {
      notifyError(e);
    }
    done();
  };
  return (
    <Row icon={<ScanFace />} title="Pessoas">
      <span className="mt-1.5 flex flex-wrap gap-3">
        {faces.map((f) => (
          <button key={f.id} type="button" onClick={() => setOpen(open === f.id ? null : f.id)} className="flex w-14 flex-col items-center gap-1">
            <FaceAvatar face={f.id} size={touch ? 48 : 44} className={open === f.id ? "ring-2 ring-brand" : ""} />
            <span className={`w-full truncate text-center text-[11px] ${f.name ? "" : "text-fg-3"}`}>{f.name || "Sem nome"}</span>
          </button>
        ))}
      </span>
      {face && (
        <span className="mt-2 block rounded-lg bg-s3 p-2 anim-fade">
          {face.person && face.name && (
            <span className="flex flex-wrap gap-1.5">
              <button type="button" onClick={() => nav.closeThen(() => nav.person(face.person!))} className="rounded-full bg-s4 px-2.5 py-1 text-[12px] font-semibold text-fg">
                Ver {face.name}
              </button>
              <button type="button" onClick={() => void reject()} className="rounded-full bg-s4 px-2.5 py-1 text-[12px] font-semibold text-danger">
                Não é {face.name}
              </button>
            </span>
          )}
          <span className="mt-1.5 flex gap-1.5">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void give()}
              placeholder={face.name ? "Outro nome…" : "Quem é?"}
              className="min-w-0 flex-1 rounded-md bg-s2 px-2 py-1 text-[13px] text-fg outline-none focus:ring-2 focus:ring-brand/30"
            />
            <button type="button" disabled={!name.trim()} onClick={() => void give()} className="rounded-md bg-brand px-2.5 text-[12px] font-semibold text-white disabled:opacity-50">
              OK
            </button>
          </span>
          {hints.length > 0 && (
            <span className="mt-1.5 flex flex-wrap gap-1.5">
              {hints.map((p) => (
                <button key={p.uid} type="button" onClick={() => void give(p)} className="flex items-center gap-1.5 rounded-full bg-s4 py-0.5 pr-2.5 pl-0.5 text-[12px] font-semibold text-fg">
                  <FaceAvatar face={p.cover} size={22} /> {p.name}
                </button>
              ))}
            </span>
          )}
          {!q && pick.length > 0 && (
            <>
              <span className="mt-2.5 block text-[12px] text-fg-3">Ou é alguém que já está em Pessoas:</span>
              <span className="mt-1.5 flex gap-2.5 overflow-x-auto pb-1 [scrollbar-width:none]">
                {pick.map((p) => (
                  <button key={p.uid} type="button" onClick={() => void give(p)} className="flex w-12 shrink-0 flex-col items-center gap-1" title={p.name || "Sem nome"}>
                    <FaceAvatar face={p.cover} size={touch ? 44 : 40} className="ring-2 ring-transparent transition hover:ring-brand" />
                    <span className={`w-full truncate text-center text-[10px] ${p.name ? "text-fg" : "text-fg-3"}`}>{p.name || "Sem nome"}</span>
                  </button>
                ))}
              </span>
            </>
          )}
        </span>
      )}
    </Row>
  );
}

function Row({ icon, title, children, breakAll }: { icon: React.ReactNode; title: string; children?: React.ReactNode; breakAll?: boolean }) {
  return (
    <div className="flex gap-3.5 py-2.5">
      <span className="mt-0.5 shrink-0 text-fg-3 [&>svg]:size-5">{icon}</span>
      {/* Dados (nome, câmera, local): copiáveis. */}
      <div className="min-w-0 select-text">
        <p className={`font-medium text-fg ${breakAll ? "break-all" : ""}`}>{title}</p>
        {children && <div className="mt-0.5 text-fg-2 tabular">{children}</div>}
      </div>
    </div>
  );
}

function CameraRow({ camera: c }: { camera: Camera }) {
  // "Google" + "Pixel 8" → "Google Pixel 8"; "Apple" + "iPhone 15" → "iPhone 15".
  const make = c.make && !c.model?.toLowerCase().startsWith(c.make.toLowerCase()) && c.make !== "Apple" ? `${c.make} ` : "";
  const name = `${make}${c.model ?? ""}`.trim() || c.make || "Câmera";
  const exposure = [
    c.f ? `ƒ/${c.f.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}` : null,
    c.exposure ? (c.exposure < 1 ? `1/${Math.round(1 / c.exposure)} s` : `${c.exposure.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s`) : null,
    c.focal ? `${c.focal.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mm` : null,
    c.iso ? `ISO ${c.iso}` : null,
  ].filter(Boolean);
  return (
    <Row icon={<Aperture />} title={name}>
      {exposure.join(" · ")}
      {c.lens && <p className="truncate">{c.lens}</p>}
    </Row>
  );
}

/** Navegador do sistema (no app) ou nova aba (modo dev). */
async function openExternal(url: string) {
  if (isTauri()) await (await import("@tauri-apps/plugin-opener")).openUrl(url);
  else window.open(url, "_blank", "noopener");
}

const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1);

function tzLabel(min: number) {
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  return `GMT${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

/** Mapa estático com blocos do OpenStreetMap ao redor do ponto. */
function MiniMap({ lat, lon }: { lat: number; lon: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(320);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const z = 14;
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  const H = 160;
  const tiles: { tx: number; ty: number; left: number; top: number }[] = [];
  const span = Math.ceil(w / 256 / 2) + 1;
  for (let tx = Math.floor(x) - span; tx <= Math.floor(x) + span; tx++) {
    for (let ty = Math.floor(y) - 1; ty <= Math.floor(y) + 1; ty++) {
      if (ty < 0 || ty >= n) continue;
      tiles.push({ tx: ((tx % n) + n) % n, ty, left: (tx - x) * 256 + w / 2, top: (ty - y) * 256 + H / 2 });
    }
  }
  return (
    <div ref={box} className="surface relative ml-[34px] overflow-hidden rounded-xl bg-s3" style={{ height: H }}>
      {tiles.map((t) => (
        <img
          key={`${t.tx}-${t.ty}-${t.left}`}
          src={`https://tile.openstreetmap.org/${z}/${t.tx}/${t.ty}.png`}
          alt=""
          draggable={false}
          className="absolute size-64 max-w-none select-none"
          style={{ left: t.left, top: t.top, filter: "brightness(.85) saturate(.8)" }}
        />
      ))}
      <MapPin size={28} className="absolute -translate-x-1/2 -translate-y-full fill-brand text-white drop-shadow" style={{ left: w / 2, top: H / 2 }} />
      <span className="absolute right-1 bottom-1 rounded bg-black/55 px-1.5 text-[10px] text-white/80">© OpenStreetMap</span>
    </div>
  );
}

/**
 * Caixas dos rostos sobre a foto, com o nome (enquanto as informações estão
 * abertas, como no Apple Fotos). Tocar num rosto com nome abre a pessoa.
 */
export function FaceBoxes({ id }: { id: number }) {
  const { data } = useQuery({ queryKey: ["media-intel", id], queryFn: () => api.mediaIntel(id) });
  // Rostos de quadros da tira do vídeo não ficam em cima da imagem mostrada.
  const faces = data?.faces.filter((f) => f.frame == null) ?? [];
  if (!faces.length) return null;
  return (
    <>
      {faces.map((f) => (
        <button
          key={f.id}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (f.person && f.name) nav.closeThen(() => nav.person(f.person!));
          }}
          className={`pointer-events-auto absolute rounded-md border-2 border-white/85 shadow-[0_0_0_1px_rgba(0,0,0,0.35)] ${f.person && f.name ? "cursor-pointer" : "cursor-default"}`}
          style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` }}
          aria-label={f.name || "Rosto sem nome"}
          data-hud
        >
          <span className="absolute top-full left-1/2 mt-1 -translate-x-1/2 rounded-full bg-black/70 px-2 py-0.5 text-[12px] font-semibold whitespace-nowrap text-white">
            {f.name || "Sem nome"}
          </span>
        </button>
      ))}
    </>
  );
}
