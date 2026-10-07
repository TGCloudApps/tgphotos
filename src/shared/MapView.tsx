/**
 * Mapa das fotos com localização: heatmap de longe, grupos com contagem de
 * perto; embaixo, a linha do tempo do que está visível (atualiza ao mover).
 *
 * Fundo: com internet, os mapas abertos do OpenFreeMap (sem chave; só a área
 * vista é baixada, e fica em cache); sem internet, um mundo simples embutido
 * (países do Natural Earth, 164 KB) — o heatmap funciona igual.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Maximize, MapPinOff } from "lucide-react";
import type { Map as MlMap, GeoJSONSource, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useNet } from "@tgcloud/ui/core/net";
import { thumbUrl } from "@tgcloud/ui/core/thumbs";
import { nav } from "../core/nav";
import { EmptyState } from "@tgcloud/ui/ui/States";
import { api, type Media } from "../core/api";
import { useList } from "../core/data";
import { Timeline } from "../timeline/Timeline";

/** Estilo do mapa conforme o tema do app (escuro: "dark"; claro: "liberty"). */
function onlineStyle() {
  const bg = getComputedStyle(document.body).backgroundColor.match(/\d+/g)?.map(Number) ?? [0, 0, 0];
  const dark = (bg[0] * 299 + bg[1] * 587 + bg[2] * 114) / 1000 < 128;
  return `https://tiles.openfreemap.org/styles/${dark ? "dark" : "liberty"}`;
}

function css(name: string, fallback: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Mundo sem internet: fundo e países (contorno). */
function offlineStyle(): StyleSpecification {
  return {
    version: 8,
    sources: { paises: { type: "geojson", data: `${location.origin}/mapa/paises.geojson` } },
    layers: [
      { id: "fundo", type: "background", paint: { "background-color": css("--surface-1", "#1b1d22") } },
      { id: "terra", type: "fill", source: "paises", paint: { "fill-color": css("--surface-3", "#2a2d34") } },
      { id: "fronteira", type: "line", source: "paises", paint: { "line-color": css("--line", "#3a3d45"), "line-width": 0.6 } },
    ],
  };
}

export function MapView({ touch }: { touch: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const online = useNet((s) => s.online);
  const { data: points } = useQuery({ queryKey: ["map-points"], queryFn: () => api.mapPoints() });
  const { data: all } = useList("timeline");
  const [visible, setVisible] = useState<number[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Enquadra todas as fotos ("Ver tudo").
  const fitAll = useRef<(animate: boolean) => void>(() => {});

  const geo = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: (points ?? []).map(([id, lat, lon]) => ({ type: "Feature" as const, properties: { id }, geometry: { type: "Point" as const, coordinates: [lon, lat] } })),
    }),
    [points],
  );

  useEffect(() => {
    if (!box.current || !points?.length) return;
    let gone = false;
    void import("maplibre-gl").then(({ Map, LngLatBounds, Marker }) => {
      if (gone || !box.current) return;
      const brand = css("--brand", "#e8603c");
      const m = new Map({ container: box.current, style: online ? onlineStyle() : offlineStyle(), attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false });
      map.current = m;
      // Enquadra tudo que tem localização.
      const b = new LngLatBounds();
      for (const [, lat, lon] of points) b.extend([lon, lat]);
      // Folga para as miniaturas (52 px) não ficarem cortadas na borda.
      fitAll.current = (animate) => m.fitBounds(b, { padding: 80, maxZoom: 12, duration: animate ? 600 : 0 });
      fitAll.current(false);
      m.once("load", () => !gone && setLoaded(true));
      const add = () => {
        if (m.getSource("fotos")) return;
        // Cada grupo guarda o maior id (a foto mais recente enviada) como capa.
        m.addSource("fotos", { type: "geojson", data: geo, cluster: true, clusterRadius: 56, clusterMaxZoom: 16, clusterProperties: { cover: ["max", ["get", "id"]] } });
        m.addSource("calor", { type: "geojson", data: geo });
        m.addLayer({
          id: "calor",
          type: "heatmap",
          source: "calor",
          maxzoom: 9,
          paint: {
            "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 6, 9, 24],
            "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 6, 0.9, 9, 0],
            "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(0,0,0,0)", 0.2, "rgba(255,190,90,0.5)", 0.6, "rgba(255,120,60,0.8)", 1, brand],
          },
        });
        // Pontos invisíveis: só servem para saber o que desenhar como foto (abaixo).
        m.addLayer({ id: "fotos-ref", type: "circle", source: "fotos", minzoom: 5, paint: { "circle-radius": 0, "circle-opacity": 0 } });
      };
      m.on("load", add);
      m.on("styledata", add);

      // De perto, cada grupo é uma miniatura com a contagem (como no Google
      // Fotos e no Apple Fotos); tocar aproxima, ou abre a foto se for uma só.
      const markers = new globalThis.Map<string, import("maplibre-gl").Marker>();
      const draw = () => {
        if (!m.getSource("fotos") || m.getZoom() < 5) {
          markers.forEach((mk) => mk.remove());
          markers.clear();
          return;
        }
        const seen = new Set<string>();
        for (const f of m.querySourceFeatures("fotos")) {
          const pr = f.properties as { cluster?: boolean; cluster_id?: number; point_count?: number; cover?: number; id?: number };
          const key = pr.cluster ? `c${pr.cluster_id}` : `p${pr.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (markers.has(key)) continue;
          const coords = (f.geometry as { coordinates: [number, number] }).coordinates;
          const id = pr.cluster ? pr.cover! : pr.id!;
          const el = document.createElement("button");
          el.className = "tg-map-photo";
          el.style.backgroundImage = `url(${thumbUrl(id)})`;
          if (pr.cluster && pr.point_count) {
            const n = document.createElement("span");
            n.textContent = pr.point_count > 999 ? `${Math.round(pr.point_count / 100) / 10}k` : String(pr.point_count);
            el.appendChild(n);
          }
          el.onclick = (ev) => {
            ev.stopPropagation();
            if (pr.cluster) void (m.getSource("fotos") as GeoJSONSource).getClusterExpansionZoom(pr.cluster_id!).then((z) => m.easeTo({ center: coords, zoom: z + 0.5 }));
            else nav.open({ type: "viewer", id, siblings: [id] });
          };
          markers.set(key, new Marker({ element: el }).setLngLat(coords).addTo(m));
        }
        for (const [k, mk] of markers) {
          if (!seen.has(k)) {
            mk.remove();
            markers.delete(k);
          }
        }
      };
      m.on("render", () => {
        if (m.isSourceLoaded("fotos")) draw();
      });
      // O que está visível vai para a linha do tempo embaixo.
      let t: number | null = null;
      const update = () => {
        if (t) clearTimeout(t);
        t = window.setTimeout(() => {
          const bb = m.getBounds();
          setVisible(points.filter(([, lat, lon]) => bb.contains([lon, lat])).map(([id]) => id));
        }, 300);
      };
      m.on("moveend", update);
      update();
    });
    return () => {
      gone = true;
      map.current?.remove();
      map.current = null;
      setLoaded(false);
    };
    // Recria ao trocar online/offline (o fundo muda).
  }, [points, online]);

  const items: Media[] = useMemo(() => {
    if (!visible || !all) return [];
    const ids = new Set(visible);
    return all.filter((m) => ids.has(m.id));
  }, [visible, all]);

  if (points && !points.length)
    return (
      <div className="grid flex-1 place-items-center">
        <EmptyState touch={touch} sync={false} icon={MapPinOff} title="Nenhuma foto com localização" text="Fotos tiradas com a localização ligada aparecem aqui, no mapa." />
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-[3]">
        <div ref={box} className="absolute inset-0 bg-s1" />
        {!loaded && <div className="skeleton pointer-events-none absolute inset-0 rounded-none" />}
        {loaded && (
          <button
            type="button"
            onClick={() => fitAll.current(true)}
            className={`surface absolute top-3 left-3 flex items-center gap-1.5 rounded-full bg-s1/90 px-3 font-semibold shadow backdrop-blur ${touch ? "h-9 text-[13px] active:bg-s3" : "h-8 text-[12px] hover:bg-s3"}`}
          >
            <Maximize size={14} /> Ver tudo
          </button>
        )}
      </div>
      <div className="glint-top flex min-h-0 flex-[2] flex-col border-t border-hairline bg-canvas">
        <p className={`shrink-0 py-2 text-[13px] font-semibold tabular ${touch ? "px-4" : "px-5"}`}>
          {visible === null ? "…" : `${items.length.toLocaleString("pt-BR")} ${items.length === 1 ? "foto" : "fotos"} nesta área`}
        </p>
        {items.length > 0 ? (
          <Timeline items={items} touch={touch} bottom={touch ? 96 : 24} />
        ) : visible !== null ? (
          <p className={`text-[13px] text-fg-3 ${touch ? "px-4" : "px-5"}`}>
            Nenhuma foto nesta área. Afaste o mapa ou toque em{" "}
            <button type="button" onClick={() => fitAll.current(true)} className="font-semibold text-accent">
              Ver tudo
            </button>
            .
          </p>
        ) : null}
      </div>
    </div>
  );
}
