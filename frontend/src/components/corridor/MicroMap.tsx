"use client";

import { useEffect } from "react";
import { MapContainer, TileLayer, Polyline, Marker, useMap } from "react-leaflet";
import L from "leaflet";
import type { LatLon, SpatialCorridor } from "@/lib/types";
import { projectSToLatLon } from "./geo";

import "leaflet/dist/leaflet.css";

type MicroMapProps = {
  corridor: SpatialCorridor;
  center: LatLon;
  inspectS: number;
  selectedFeuIndex: number | null;
};

function Recenter({ center }: { center: LatLon }) {
  const map = useMap();
  useEffect(() => {
    map.setView([center.lat, center.lon], map.getZoom(), { animate: true });
    map.invalidateSize();
  }, [center.lat, center.lon, map]);
  return null;
}

const inspectIcon = L.divIcon({
  className: "",
  html: `<div style="
    width:14px;height:14px;border-radius:50%;
    background:#2563eb;border:2px solid #fff;
    box-shadow:0 1px 4px rgba(0,0,0,.45);
  "></div>`,
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

const feuIcon = (n: number, selected: boolean) =>
  L.divIcon({
    className: "",
    html: `<div style="
      width:20px;height:20px;border-radius:4px;
      background:${selected ? "#b91c1c" : "#dc2626"};
      border:2px solid #fff;
      display:flex;align-items:center;justify-content:center;
      font:700 9px/1 system-ui,sans-serif;color:#fff;
      box-shadow:0 1px 3px rgba(0,0,0,.4);
      outline:${selected ? "2px solid #2563eb" : "none"};
    ">${n}</div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });

export default function MicroMap({
  corridor,
  center,
  inspectS,
  selectedFeuIndex,
}: MicroMapProps) {
  const polyline = corridor.geometry.map(
    (p) => [p.lat, p.lon] as [number, number]
  );

  return (
    <MapContainer
      center={[center.lat, center.lon]}
      zoom={17}
      className="h-44 w-full z-0"
      zoomControl={false}
      attributionControl={false}
      scrollWheelZoom
    >
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
      <Recenter center={center} />
      {polyline.length >= 2 && (
        <Polyline
          positions={polyline}
          pathOptions={{ color: "#2563eb", weight: 4, opacity: 0.85 }}
        />
      )}
      {corridor.S_feux.map((s, i) => {
        const pos = projectSToLatLon(corridor, s);
        if (!pos) return null;
        return (
          <Marker
            key={`micro-feu-${i}`}
            position={[pos.lat, pos.lon]}
            icon={feuIcon(i + 1, selectedFeuIndex === i)}
          />
        );
      })}
      <Marker
        position={[center.lat, center.lon]}
        icon={inspectIcon}
        title={`s=${Math.round(inspectS)} m`}
      />
    </MapContainer>
  );
}
