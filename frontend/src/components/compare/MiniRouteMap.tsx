"use client";

import { useMemo } from "react";
import type { LatLon } from "@/lib/types";

/** Lightweight SVG mini-map (no Leaflet instance per card). */
export default function MiniRouteMap({
  geometry,
  className = "",
}: {
  geometry: LatLon[];
  className?: string;
}) {
  const path = useMemo(() => {
    if (geometry.length < 2) return null;
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    for (const p of geometry) {
      minLat = Math.min(minLat, p.lat);
      maxLat = Math.max(maxLat, p.lat);
      minLon = Math.min(minLon, p.lon);
      maxLon = Math.max(maxLon, p.lon);
    }
    const pad = 0.08;
    const dLat = Math.max(maxLat - minLat, 1e-5);
    const dLon = Math.max(maxLon - minLon, 1e-5);
    const w = 120;
    const h = 64;
    const pts = geometry.map((p) => {
      const x = ((p.lon - minLon) / dLon) * (1 - 2 * pad) * w + pad * w;
      const y = (1 - (p.lat - minLat) / dLat) * (1 - 2 * pad) * h + pad * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return pts.join(" ");
  }, [geometry]);

  if (!path) {
    return (
      <div
        className={`flex items-center justify-center rounded bg-slate-100 text-[9px] text-slate-400 ${className}`}
      >
        Pas de géo
      </div>
    );
  }

  return (
    <svg
      viewBox="0 0 120 64"
      className={`rounded bg-slate-100 ${className}`}
      aria-hidden
    >
      <polyline
        points={path}
        fill="none"
        stroke="#0f766e"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
