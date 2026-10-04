/** Informações de uma mídia (painel do lightbox no desktop, folha no celular). */
import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Aperture, CloudOff, Calendar, ExternalLink, FolderOpen, Image as ImageIcon, Images, MapPin, Upload } from "lucide-react";
import { formatDuration, formatFullDate, formatSize } from "@tgcloud/ui/core/format";
import type { Camera, Details, Media } from "../core/api";
import { useDetails } from "../core/data";
import { nav } from "../core/nav";
import { wallClock } from "../timeline/layout";

export function Info({ media, touch }: { media: Media; touch: boolean }) {
  const { data } = useDetails(media.id);
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
        <Row icon={<MapPin />} title={`${media.lat.toFixed(5)}, ${media.lon.toFixed(5)}`}>
          <button
            onClick={() => openExternal(`https://www.openstreetmap.org/?mlat=${media.lat}&mlon=${media.lon}#map=16/${media.lat}/${media.lon}`)}
            className="inline-flex items-center gap-1 text-accent hover:underline"
          >
            Abrir no mapa <ExternalLink size={12} />
          </button>
        </Row>
      )}
      {media.lat !== null && media.lon !== null && <MiniMap lat={media.lat} lon={media.lon} />}
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

function Row({ icon, title, children, breakAll }: { icon: React.ReactNode; title: string; children?: React.ReactNode; breakAll?: boolean }) {
  return (
    <div className="flex gap-3.5 py-2.5">
      <span className="mt-0.5 shrink-0 text-fg-3 [&>svg]:size-5">{icon}</span>
      <div className="min-w-0">
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
