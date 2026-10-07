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
import { MapPinOff } from "lucide-react";
import type { Map as MlMap, GeoJSONSource, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useNet } from "@tgcloud/ui/core/net";
import { EmptyState } from "@tgcloud/ui/ui/States";
import { api, type Media } from "../core/api";
import { useList } from "../core/data";
import { Timeline } from "../timeline/Timeline";

const ONLINE_STYLE = "https://tiles.openfreemap.org/styles/liberty";

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
    void import("maplibre-gl").then(({ Map, LngLatBounds }) => {
      if (gone || !box.current) return;
      const brand = css("--brand", "#e8603c");
      const m = new Map({ container: box.current, style: online ? ONLINE_STYLE : offlineStyle(), attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false });
      map.current = m;
      // Enquadra tudo que tem localização.
      const b = new LngLatBounds();
      for (const [, lat, lon] of points) b.extend([lon, lat]);
      m.fitBounds(b, { padding: 40, maxZoom: 12, duration: 0 });
      const add = () => {
        if (m.getSource("fotos")) return;
        m.addSource("fotos", { type: "geojson", data: geo, cluster: true, clusterRadius: 44, clusterMaxZoom: 15 });
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
        m.addLayer({
          id: "grupos",
          type: "circle",
          source: "fotos",
          minzoom: 6,
          filter: ["has", "point_count"],
          paint: { "circle-color": brand, "circle-radius": ["step", ["get", "point_count"], 14, 20, 18, 100, 24], "circle-stroke-width": 2, "circle-stroke-color": "#fff" },
        });
        m.addLayer({
          id: "grupos-n",
          type: "symbol",
          source: "fotos",
          minzoom: 6,
          filter: ["has", "point_count"],
          layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 12, "text-font": ["Noto Sans Bold"] },
          paint: { "text-color": "#fff" },
        });
        m.addLayer({ id: "pontos", type: "circle", source: "fotos", minzoom: 6, filter: ["!", ["has", "point_count"]], paint: { "circle-color": brand, "circle-radius": 6, "circle-stroke-width": 2, "circle-stroke-color": "#fff" } });
        // Tocar num grupo aproxima.
        m.on("click", "grupos", (e) => {
          const f = e.features?.[0];
          if (!f) return;
          void (m.getSource("fotos") as GeoJSONSource).getClusterExpansionZoom(f.properties.cluster_id).then((z) => m.easeTo({ center: (f.geometry as { coordinates: [number, number] }).coordinates, zoom: z }));
        });
        m.on("mouseenter", "grupos", () => (m.getCanvas().style.cursor = "pointer"));
        m.on("mouseleave", "grupos", () => (m.getCanvas().style.cursor = ""));
      };
      m.on("load", add);
      m.on("styledata", add);
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
      <div ref={box} className="relative min-h-0 flex-[3] bg-s1" />
      <div className="glint-top flex min-h-0 flex-[2] flex-col border-t border-hairline bg-canvas">
        <p className={`shrink-0 py-2 text-[13px] font-semibold tabular ${touch ? "px-4" : "px-5"}`}>
          {visible === null ? "…" : `${items.length.toLocaleString("pt-BR")} ${items.length === 1 ? "foto" : "fotos"} nesta área`}
        </p>
        {items.length > 0 && <Timeline items={items} touch={touch} bottom={touch ? 96 : 24} />}
      </div>
    </div>
  );
}
