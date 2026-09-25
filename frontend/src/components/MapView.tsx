"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Polyline,
  useMapEvents,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import type { LatLngExpression } from "leaflet";
import type {
  CycleGenWarning,
  LatLon,
  SpatialCorridor,
  VehicleSnapshot,
} from "@/lib/types";
import { DEFAULT_CENTER, DEFAULT_ZOOM } from "@/lib/types";
import { projectSToLatLon } from "@/components/corridor/geo";
import { geometrySliceByS, type MapFocusRequest } from "@/lib/mapFocus";
import { nearestSFromLatLon } from "@/lib/roadLoupe";
import { alphaToPathOptions } from "@/lib/mapColors";
import type { MapSpeedLayers } from "@/components/MapLayerControls";
import { DEFAULT_MAP_SPEED_LAYERS } from "@/components/MapLayerControls";

import "leaflet/dist/leaflet.css";

/** Cap Leaflet layers on long mountain routes (~3k pts) to avoid UI freezes. */
const MAP_POLYLINE_MAX_PTS = 800;
const MAP_SPEED_MARKER_MAX = 80;
const MAP_ARROW_MAX = 36;
const MAP_SPEED_SAMPLE_MAX = 28;

function downsampleIndices(n: number, maxPts: number): number[] {
  if (n <= 0) return [];
  if (n <= maxPts) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < maxPts; i++) {
    out.push(Math.round((i * (n - 1)) / (maxPts - 1)));
  }
  return out;
}

/** Approximate curvilinear abscissa from polyline (m) when corridor S is unavailable. */
function approxSFromGeometry(geometry: LatLon[]): number[] {
  if (!geometry.length) return [];
  const S: number[] = [0];
  for (let i = 1; i < geometry.length; i++) {
    const a = geometry[i - 1];
    const b = geometry[i];
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = ((b.lon - a.lon) * Math.PI) / 180;
    const lat1 = (a.lat * Math.PI) / 180;
    const lat2 = (b.lat * Math.PI) / 180;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    S.push(S[i - 1] + 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h))));
  }
  return S;
}

// Re-export for callers that imported from MapView historically.
export { alphaToColor, alphaToPathOptions } from "@/lib/mapColors";

/** Fix broken default marker asset paths under Next.js bundling. */
function fixLeafletIcons() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (L.Icon.Default.prototype as any)._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconRetinaUrl:
      "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png",
    iconUrl:
      "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png",
    shadowUrl:
      "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png",
  });
}

const markerAIcon = L.divIcon({
  className: "",
  html: `<div style="
    width:22px;height:22px;border-radius:50%;
    background:#16a34a;border:3px solid #fff;
    box-shadow:0 1px 4px rgba(0,0,0,.4);
  "></div>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

const markerBIcon = L.divIcon({
  className: "",
  html: `<div style="
    width:22px;height:22px;border-radius:50%;
    background:#dc2626;border:3px solid #fff;
    box-shadow:0 1px 4px rgba(0,0,0,.4);
  "></div>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

const refStartIcon = L.divIcon({
  className: "",
  html: `<div style="
    width:16px;height:16px;border-radius:50%;
    background:#059669;border:2px solid #fff;
    box-shadow:0 1px 4px rgba(0,0,0,.4);
  "></div>`,
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

const refEndIcon = L.divIcon({
  className: "",
  html: `<div style="
    width:16px;height:16px;border-radius:3px;
    background:#047857;border:2px solid #fff;
    box-shadow:0 1px 4px rgba(0,0,0,.4);
  "></div>`,
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

const signalIcon = L.divIcon({
  className: "",
  html: `<div style="
    width:12px;height:12px;border-radius:2px;
    background:#dc2626;border:2px solid #fff;
    box-shadow:0 1px 3px rgba(0,0,0,.45);
  "></div>`,
  iconSize: [12, 12],
  iconAnchor: [6, 6],
});

const egoIcon = L.divIcon({
  className: "",
  html: `<div style="
    width:16px;height:16px;border-radius:3px;
    background:#2563eb;border:2px solid #fff;
    box-shadow:0 1px 4px rgba(0,0,0,.45);
    transform:rotate(45deg);
  "></div>`,
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

const otherVehicleIcon = L.divIcon({
  className: "",
  html: `<div style="
    width:10px;height:10px;border-radius:50%;
    background:#64748b;border:2px solid #fff;
    box-shadow:0 1px 3px rgba(0,0,0,.35);
  "></div>`,
  iconSize: [10, 10],
  iconAnchor: [5, 5],
});

const speedIconCache = new Map<number, L.DivIcon>();

function speedLimitIcon(kmh: number): L.DivIcon {
  const cached = speedIconCache.get(kmh);
  if (cached) return cached;
  const icon = L.divIcon({
    className: "",
    html: `<div style="
      width:28px;height:28px;border-radius:50%;
      background:#fff;border:2px solid #2563eb;
      display:flex;align-items:center;justify-content:center;
      font:700 10px/1 system-ui,sans-serif;color:#1e293b;
      box-shadow:0 1px 3px rgba(0,0,0,.35);
    ">${kmh}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
  speedIconCache.set(kmh, icon);
  return icon;
}

type MapClickHandlerProps = {
  onMapClick: (lat: number, lon: number) => void;
};

function MapClickHandler({ onMapClick }: MapClickHandlerProps) {
  useMapEvents({
    click(e) {
      onMapClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function MapZoomControls() {
  const map = useMap();
  return (
    <div className="absolute left-3 top-1/2 z-[1000] flex -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white/95 shadow-sm">
      <button
        type="button"
        title="Zoom in"
        aria-label="Zoom in"
        onClick={() => map.zoomIn()}
        className="flex h-9 w-9 items-center justify-center text-lg font-semibold text-slate-700 hover:bg-slate-50"
      >
        +
      </button>
      <div className="h-px bg-slate-200" />
      <button
        type="button"
        title="Zoom out"
        aria-label="Zoom out"
        onClick={() => map.zoomOut()}
        className="flex h-9 w-9 items-center justify-center text-lg font-semibold text-slate-700 hover:bg-slate-50"
      >
        −
      </button>
    </div>
  );
}

function collectEndpointLatLngs(
  pointA: LatLon | null,
  pointB: LatLon | null,
  waypoints: Array<{ lat: number | null; lon: number | null }>
): [number, number][] {
  const out: [number, number][] = [];
  if (pointA) out.push([pointA.lat, pointA.lon]);
  for (const wp of waypoints) {
    if (wp.lat != null && wp.lon != null) out.push([wp.lat, wp.lon]);
  }
  if (pointB) out.push([pointB.lat, pointB.lon]);
  return out;
}

function fitPoints(
  map: L.Map,
  points: [number, number][],
  opts?: { maxZoom?: number; padding?: [number, number] }
) {
  if (points.length === 0) return;
  if (points.length === 1) {
    map.setView(points[0], opts?.maxZoom ?? 15, { animate: true });
    return;
  }
  map.fitBounds(L.latLngBounds(points), {
    padding: opts?.padding ?? [48, 48],
    animate: true,
    maxZoom: opts?.maxZoom ?? 16,
  });
}

function MapCameraDriver({
  focus,
  geometry,
  pointA,
  pointB,
  waypoints,
  rangeGeometry,
  referenceGeometry,
}: {
  focus: MapFocusRequest | null;
  geometry: LatLon[];
  pointA: LatLon | null;
  pointB: LatLon | null;
  waypoints: Array<{ lat: number | null; lon: number | null }>;
  rangeGeometry: LatLon[];
  referenceGeometry: LatLon[];
}) {
  const map = useMap();
  useEffect(() => {
    if (!focus) return;
    if (focus.kind === "bounds" && focus.points.length >= 1) {
      fitPoints(
        map,
        focus.points.map((p) => [p.lat, p.lon] as [number, number])
      );
      return;
    }
    if (focus.kind === "route") {
      if (geometry.length >= 2) {
        const idxs = downsampleIndices(geometry.length, MAP_POLYLINE_MAX_PTS);
        fitPoints(
          map,
          idxs.map((i) => [geometry[i].lat, geometry[i].lon] as [number, number])
        );
        return;
      }
      if (referenceGeometry.length >= 2) {
        const idxs = downsampleIndices(
          referenceGeometry.length,
          MAP_POLYLINE_MAX_PTS
        );
        fitPoints(
          map,
          idxs.map(
            (i) =>
              [referenceGeometry[i].lat, referenceGeometry[i].lon] as [
                number,
                number,
              ]
          )
        );
        return;
      }
      fitPoints(map, collectEndpointLatLngs(pointA, pointB, waypoints));
      return;
    }
    if (focus.kind === "points") {
      fitPoints(map, collectEndpointLatLngs(pointA, pointB, waypoints));
      return;
    }
    if (focus.kind === "reference" && referenceGeometry.length >= 1) {
      const idxs = downsampleIndices(
        referenceGeometry.length,
        MAP_POLYLINE_MAX_PTS
      );
      fitPoints(
        map,
        idxs.map(
          (i) =>
            [referenceGeometry[i].lat, referenceGeometry[i].lon] as [
              number,
              number,
            ]
        )
      );
      return;
    }
    if (focus.kind === "A" && pointA) {
      map.setView([pointA.lat, pointA.lon], 16, { animate: true });
      return;
    }
    if (focus.kind === "B" && pointB) {
      map.setView([pointB.lat, pointB.lon], 16, { animate: true });
      return;
    }
    if (focus.kind === "range") {
      const pts =
        rangeGeometry.length >= 2
          ? rangeGeometry
          : geometrySliceByS(
              approxSFromGeometry(geometry),
              geometry,
              focus.s0,
              focus.s1
            );
      if (pts.length >= 2) {
        fitPoints(
          map,
          pts.map((p) => [p.lat, p.lon] as [number, number]),
          { maxZoom: 17, padding: [56, 56] }
        );
      }
    }
  }, [
    focus,
    geometry,
    pointA,
    pointB,
    waypoints,
    rangeGeometry,
    referenceGeometry,
    map,
  ]);

  return null;
}

function SoftPanToCursor({
  position,
  enabled,
}: {
  position: LatLon | null;
  enabled: boolean;
}) {
  const map = useMap();
  useEffect(() => {
    if (!enabled || !position) return;
    const ll = L.latLng(position.lat, position.lon);
    // Only nudge the map when the playhead leaves a comfortable inner frame
    const inner = map.getBounds().pad(-0.2);
    if (!inner.contains(ll)) {
      const reduce =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      map.panTo(ll, reduce ? { animate: false } : { animate: true, duration: 0.22 });
    }
  }, [enabled, position, map]);
  return null;
}

/** Recalculate tiles after sidebar flex changes, then refit the route. */
function InvalidateOnLayout({
  layoutKey,
  geometry,
}: {
  layoutKey: string | number | boolean;
  geometry: LatLon[];
}) {
  const map = useMap();
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;
  useEffect(() => {
    const t = window.setTimeout(() => {
      map.invalidateSize({ animate: false });
      const geo = geometryRef.current;
      if (geo.length >= 2) {
        const idxs = downsampleIndices(geo.length, MAP_POLYLINE_MAX_PTS);
        fitPoints(
          map,
          idxs.map((i) => [geo[i].lat, geo[i].lon] as [number, number]),
          { padding: [18, 18], maxZoom: 15 }
        );
      }
    }, 240);
    return () => window.clearTimeout(t);
  }, [layoutKey, map]);
  return null;
}

/** Normalize speed-limit value to km/h (accepts m/s or already km/h). */
function toKmh(value: number): number {
  return value > 60 ? Math.round(value) : Math.round(value * 3.6);
}

function bearingDeg(a: LatLon, b: LatLon): number {
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const Δλ = ((b.lon - a.lon) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function arrowIcon(bearing: number) {
  return L.divIcon({
    className: "",
    html: `<div style="
      width:16px;height:16px;display:flex;align-items:center;justify-content:center;
      transform:rotate(${bearing}deg);
    "><div style="
      width:0;height:0;
      border-left:5px solid transparent;border-right:5px solid transparent;
      border-bottom:11px solid #1d4ed8;
      filter:drop-shadow(0 0 1px #fff) drop-shadow(0 1px 1px rgba(0,0,0,.35));
    "></div></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function speedLayerIcon(kmh: number, color: string) {
  return L.divIcon({
    className: "",
    html: `<div style="
      background:${color};color:#fff;
      font:700 9px/1.1 system-ui,sans-serif;
      padding:2px 4px;border-radius:4px;border:1px solid #fff;
      box-shadow:0 1px 3px rgba(0,0,0,.35);white-space:nowrap;
    ">${Math.round(kmh)}</div>`,
    iconSize: [30, 16],
    iconAnchor: [15, 8],
  });
}

function mpsToKmhOrNull(v: number | undefined): number | null {
  if (v == null || !Number.isFinite(v) || v <= 0) return null;
  const kmh = v * 3.6;
  if (kmh > 160) return null; // non-binding / straight
  return kmh;
}

const cursorIcon = L.divIcon({
  className: "",
  html: `<div style="
    width:18px;height:18px;border-radius:50%;
    background:#2563eb;border:3px solid #fff;
    box-shadow:0 0 0 2px rgba(37,99,235,.35),0 1px 4px rgba(0,0,0,.45);
  "></div>`,
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

export type MapViewProps = {
  pointA: LatLon | null;
  pointB: LatLon | null;
  geometry: LatLon[];
  corridor?: SpatialCorridor | null;
  /** Optional α samples (same length as geometry) for slope gradient. */
  alpha?: number[] | null;
  trafficSource?: string | null;
  warnings?: CycleGenWarning[];
  waypoints?: Array<{
    id: string;
    lat: number | null;
    lon: number | null;
    label: string;
    stop_duration_s: number;
  }>;
  onMapClick: (lat: number, lon: number) => void;
  /** Ego vehicle position during simulation. */
  egoPosition?: LatLon | null;
  /** Other vehicles from the latest simulation frame. */
  otherVehicles?: VehicleSnapshot[];
  /** Bumps when map/analysis flex ratio changes (invalidateSize). */
  layoutKey?: string | number | boolean;
  /** Chart ↔ map sync cursor position. */
  syncCursor?: LatLon | null;
  syncPan?: boolean;
  /** Highlighted route segment for brush selection. */
  rangeGeometry?: LatLon[];
  /** Optional benchmark reference GPS polyline (green). */
  referenceGeometry?: LatLon[];
  /** Imperative camera request. */
  mapFocus?: MapFocusRequest | null;
  showArrows?: boolean;
  speedLayers?: MapSpeedLayers;
  /**
   * Hover / click on the corridor route → nearest curvilinear S (m).
   * Used by the 3D loupe + chart↔map sync.
   */
  onRouteCursorS?: (s_m: number | null) => void;
};

const viaIcon = (n: number) =>
  L.divIcon({
    className: "",
    html: `<div style="
      width:22px;height:22px;border-radius:50%;
      background:#f59e0b;border:2px solid #fff;
      display:flex;align-items:center;justify-content:center;
      font:700 10px/1 system-ui,sans-serif;color:#fff;
      box-shadow:0 1px 4px rgba(0,0,0,.4);
    ">${n}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });

export default function MapView({
  pointA,
  pointB,
  geometry,
  corridor = null,
  alpha = null,
  waypoints = [],
  onMapClick,
  egoPosition = null,
  otherVehicles = [],
  layoutKey = false,
  syncCursor = null,
  syncPan = false,
  rangeGeometry = [],
  referenceGeometry = [],
  mapFocus = null,
  showArrows = true,
  speedLayers = DEFAULT_MAP_SPEED_LAYERS,
  onRouteCursorS,
}: MapViewProps) {
  useEffect(() => {
    fixLeafletIcons();
  }, []);

  const alphaSeries =
    alpha && alpha.length === geometry.length
      ? alpha
      : corridor?.alpha && corridor.alpha.length === geometry.length
        ? corridor.alpha
        : null;

  const slopeGeom =
    alphaSeries && geometry.length >= 2
      ? geometry
      : corridor?.alpha &&
          corridor.geometry &&
          corridor.alpha.length === corridor.geometry.length &&
          corridor.geometry.length >= 2
        ? corridor.geometry
        : null;

  const slopeAlpha =
    slopeGeom === geometry
      ? alphaSeries
      : slopeGeom && corridor?.alpha
        ? corridor.alpha
        : null;

  const slopeSegments = useMemo(() => {
    if (!slopeGeom || !slopeAlpha || slopeGeom.length < 2) return null;
    const idxs = downsampleIndices(slopeGeom.length, MAP_POLYLINE_MAX_PTS);
    type Seg = {
      positions: LatLngExpression[];
      color: string;
      weight: number;
      dashArray?: string;
      opacity: number;
    };
    const segs: Seg[] = [];
    let current: Seg | null = null;
    for (let k = 0; k < idxs.length - 1; k++) {
      const i = idxs[k];
      const j = idxs[k + 1];
      const opts = alphaToPathOptions(slopeAlpha[i] ?? 0);
      const key = `${opts.color}|${opts.weight}|${opts.dashArray ?? ""}`;
      const a = slopeGeom[i];
      const b = slopeGeom[j];
      const pair: LatLngExpression[] = [
        [a.lat, a.lon],
        [b.lat, b.lon],
      ];
      const curKey = current
        ? `${current.color}|${current.weight}|${current.dashArray ?? ""}`
        : null;
      if (current && curKey === key) {
        current.positions.push(pair[1]);
      } else {
        current = {
          positions: [...pair],
          color: opts.color,
          weight: opts.weight,
          dashArray: opts.dashArray,
          opacity: opts.opacity,
        };
        segs.push(current);
      }
    }
    return segs;
  }, [slopeGeom, slopeAlpha]);

  const polylinePositions: LatLngExpression[] = useMemo(() => {
    const idxs = downsampleIndices(geometry.length, MAP_POLYLINE_MAX_PTS);
    return idxs.map((i) => [geometry[i].lat, geometry[i].lon] as LatLngExpression);
  }, [geometry]);

  const rangePositions: LatLngExpression[] = useMemo(() => {
    const idxs = downsampleIndices(rangeGeometry.length, MAP_POLYLINE_MAX_PTS);
    return idxs.map(
      (i) => [rangeGeometry[i].lat, rangeGeometry[i].lon] as LatLngExpression
    );
  }, [rangeGeometry]);

  const referencePositions: LatLngExpression[] = useMemo(() => {
    const idxs = downsampleIndices(referenceGeometry.length, MAP_POLYLINE_MAX_PTS);
    return idxs.map(
      (i) =>
        [referenceGeometry[i].lat, referenceGeometry[i].lon] as LatLngExpression
    );
  }, [referenceGeometry]);

  const emitRouteS = useCallback(
    (lat: number, lon: number) => {
      if (!onRouteCursorS) return;
      const src =
        corridor && corridor.S.length >= 2 && corridor.geometry.length >= 2
          ? corridor
          : geometry.length >= 2
            ? {
                S: approxSFromGeometry(geometry),
                geometry,
              }
            : null;
      if (!src) return;
      const s = nearestSFromLatLon(src, lat, lon);
      if (s != null) onRouteCursorS(s);
    },
    [onRouteCursorS, corridor, geometry]
  );

  const routeHitPositions =
    polylinePositions.length >= 2 ? polylinePositions : [];

  const routeCursorHandlers = onRouteCursorS
    ? {
        mouseover: (e: L.LeafletMouseEvent) => {
          emitRouteS(e.latlng.lat, e.latlng.lng);
        },
        mousemove: (e: L.LeafletMouseEvent) => {
          emitRouteS(e.latlng.lat, e.latlng.lng);
        },
        click: (e: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(e);
          emitRouteS(e.latlng.lat, e.latlng.lng);
        },
      }
    : undefined;

  const signalPositions = useMemo(() => {
    if (!corridor) return [] as LatLon[];
    const fromFeux = (corridor.S_feux ?? [])
      .map((s) => projectSToLatLon(corridor, s))
      .filter((p): p is LatLon => p != null);
    if (fromFeux.length > 0) return fromFeux;
    return (corridor.events ?? [])
      .filter((e) => e.kind === "traffic_signal")
      .map((e) => projectSToLatLon(corridor, e.s_m))
      .filter((p): p is LatLon => p != null);
  }, [corridor]);

  const speedMarkers = useMemo(() => {
    if (!corridor || !speedLayers.envelope) return [] as { pos: LatLon; kmh: number }[];
    const all = (corridor.events ?? [])
      .filter((e) => e.kind === "speed_limit" && e.value != null)
      .map((e) => {
        const pos = projectSToLatLon(corridor, e.s_m);
        if (!pos) return null;
        return { pos, kmh: toKmh(e.value as number) };
      })
      .filter((m): m is { pos: LatLon; kmh: number } => m != null);
    if (all.length <= MAP_SPEED_MARKER_MAX) return all;
    const idxs = downsampleIndices(all.length, MAP_SPEED_MARKER_MAX);
    return idxs.map((i) => all[i]);
  }, [corridor, speedLayers.envelope]);

  const directionArrows = useMemo(() => {
    if (!showArrows || geometry.length < 2) {
      return [] as { pos: LatLon; bearing: number }[];
    }
    const idxs = downsampleIndices(geometry.length, MAP_ARROW_MAX + 1);
    const out: { pos: LatLon; bearing: number }[] = [];
    for (let k = 0; k < idxs.length - 1; k++) {
      const i = idxs[k];
      const iNext = idxs[k + 1];
      const a = geometry[i];
      const b = geometry[iNext];
      if (!a || !b) continue;
      const dlat = a.lat - b.lat;
      const dlon = a.lon - b.lon;
      if (dlat * dlat + dlon * dlon < 1e-12) continue;
      out.push({
        pos: {
          lat: (a.lat + b.lat) / 2,
          lon: (a.lon + b.lon) / 2,
        },
        bearing: bearingDeg(a, b),
      });
    }
    return out;
  }, [geometry, showArrows]);

  const speedLayerMarkers = useMemo(() => {
    if (!corridor?.S?.length) {
      return [] as { key: string; pos: LatLon; kmh: number; color: string }[];
    }
    const n = corridor.S.length;
    const idxs = downsampleIndices(n, MAP_SPEED_SAMPLE_MAX);
    const layers: {
      id: keyof MapSpeedLayers;
      arr: number[] | undefined;
      color: string;
      dy: number;
    }[] = [
      {
        id: "envelope",
        arr: corridor.V_envelope?.length === n ? corridor.V_envelope : corridor.V_limite,
        color: "#2563eb",
        dy: 0,
      },
      { id: "legal", arr: corridor.V_limite_legal, color: "#64748b", dy: 0.00012 },
      { id: "traffic", arr: corridor.V_traffic, color: "#ea580c", dy: -0.00012 },
      { id: "curve", arr: corridor.V_curve, color: "#7c3aed", dy: 0.00022 },
    ];
    const out: { key: string; pos: LatLon; kmh: number; color: string }[] = [];
    for (const layer of layers) {
      if (!speedLayers[layer.id] || !layer.arr || layer.arr.length !== n) continue;
      for (const i of idxs) {
        const kmh = mpsToKmhOrNull(layer.arr[i]);
        if (kmh == null) continue;
        const g = corridor.geometry?.[i];
        const pos = g
          ? { lat: g.lat + layer.dy, lon: g.lon }
          : projectSToLatLon(corridor, corridor.S[i]);
        if (!pos) continue;
        out.push({
          key: `${layer.id}-${i}`,
          pos,
          kmh,
          color: layer.color,
        });
      }
    }
    return out;
  }, [corridor, speedLayers]);

  return (
    <MapContainer
      center={DEFAULT_CENTER}
      zoom={DEFAULT_ZOOM}
      className="h-full w-full z-0"
      zoomControl={false}
      scrollWheelZoom
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <MapClickHandler onMapClick={onMapClick} />
      <MapZoomControls />
      <InvalidateOnLayout layoutKey={layoutKey} geometry={geometry} />
      <MapCameraDriver
        focus={mapFocus}
        geometry={geometry}
        pointA={pointA}
        pointB={pointB}
        waypoints={waypoints}
        rangeGeometry={rangeGeometry}
        referenceGeometry={referenceGeometry}
      />
      <SoftPanToCursor position={syncCursor} enabled={syncPan} />
      {pointA && (
        <Marker position={[pointA.lat, pointA.lon]} icon={markerAIcon} />
      )}
      {pointB && (
        <Marker position={[pointB.lat, pointB.lon]} icon={markerBIcon} />
      )}
      {waypoints.map((wp, i) =>
        wp.lat != null && wp.lon != null ? (
          <Marker
            key={wp.id}
            position={[wp.lat, wp.lon]}
            icon={viaIcon(i + 1)}
            title={`${wp.label || `Stop ${i + 1}`} — ${wp.stop_duration_s}s`}
          />
        ) : null
      )}
      {slopeSegments && slopeSegments.length > 0
        ? slopeSegments.map((seg, i) => (
            <Polyline
              key={`slope-${i}-${seg.color}-${seg.weight}-${seg.dashArray ?? "s"}`}
              positions={seg.positions}
              pathOptions={{
                color: seg.color,
                weight: seg.weight,
                opacity: seg.opacity,
                dashArray: seg.dashArray,
              }}
            />
          ))
        : polylinePositions.length >= 2 && (
            <Polyline
              positions={polylinePositions}
              pathOptions={{ color: "#2563eb", weight: 5, opacity: 0.55 }}
            />
          )}
      {routeHitPositions.length >= 2 && routeCursorHandlers && (
        <Polyline
          positions={routeHitPositions}
          pathOptions={{
            color: "#000000",
            weight: 18,
            opacity: 0,
            interactive: true,
          }}
          eventHandlers={routeCursorHandlers}
        />
      )}
      {rangePositions.length >= 2 && (
        <Polyline
          positions={rangePositions}
          pathOptions={{ color: "#f59e0b", weight: 7, opacity: 0.95 }}
        />
      )}
      {referencePositions.length >= 2 && (
        <Polyline
          positions={referencePositions}
          pathOptions={{
            color: "#059669",
            weight: 4,
            opacity: 0.85,
            dashArray: "8 6",
          }}
        />
      )}
      {referenceGeometry.length >= 1 && (
        <Marker
          position={[referenceGeometry[0].lat, referenceGeometry[0].lon]}
          icon={refStartIcon}
          title="GPS reference start"
          zIndexOffset={500}
        />
      )}
      {referenceGeometry.length >= 2 && (
        <Marker
          position={[
            referenceGeometry[referenceGeometry.length - 1].lat,
            referenceGeometry[referenceGeometry.length - 1].lon,
          ]}
          icon={refEndIcon}
          title="GPS reference end"
          zIndexOffset={500}
        />
      )}
      {directionArrows.map((a, i) => (
        <Marker
          key={`arrow-${i}-${a.pos.lat.toFixed(5)}`}
          position={[a.pos.lat, a.pos.lon]}
          icon={arrowIcon(a.bearing)}
          interactive={false}
          zIndexOffset={200}
        />
      ))}
      {speedLayerMarkers.map((m) => (
        <Marker
          key={m.key}
          position={[m.pos.lat, m.pos.lon]}
          icon={speedLayerIcon(m.kmh, m.color)}
          title={`${Math.round(m.kmh)} km/h`}
          interactive={false}
          zIndexOffset={250}
        />
      ))}
      {signalPositions.map((p, i) => (
        <Marker
          key={`signal-${i}-${p.lat}-${p.lon}`}
          position={[p.lat, p.lon]}
          icon={signalIcon}
          title="Traffic signal"
        />
      ))}
      {speedMarkers.map((m, i) => (
        <Marker
          key={`speed-${i}-${m.kmh}-${m.pos.lat}-${m.pos.lon}`}
          position={[m.pos.lat, m.pos.lon]}
          icon={speedLimitIcon(m.kmh)}
          title={`Speed limit ${m.kmh} km/h`}
        />
      ))}
      {otherVehicles.map((v) => (
        <Marker
          key={`veh-${v.id}`}
          position={[v.lat, v.lon]}
          icon={otherVehicleIcon}
          title={v.id}
        />
      ))}
      {egoPosition && (
        <Marker
          position={[egoPosition.lat, egoPosition.lon]}
          icon={egoIcon}
          title="Ego vehicle"
          zIndexOffset={1000}
        />
      )}
      {syncCursor && (
        <Marker
          position={[syncCursor.lat, syncCursor.lon]}
          icon={cursorIcon}
          title="Chart cursor"
          zIndexOffset={1100}
        />
      )}
    </MapContainer>
  );
}
