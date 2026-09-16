/** Canvas renderers for Excel-embedded charts & route map (from export data). */

import type { LatLon } from "@/lib/types";
import type { ExportCycleRow } from "@/lib/exportCycleRows";
import { alphaToColor } from "@/lib/mapColors";

export type ChartSeriesSpec = {
  id: string;
  title: string;
  yKey: keyof ExportCycleRow;
  color: string;
  unit: string;
};

export const EXPORT_CHART_SPECS: ChartSeriesSpec[] = [
  { id: "v", title: "Vitesse", yKey: "v_kmh", color: "#0ea5e9", unit: "km/h" },
  {
    id: "v_legal",
    title: "Limite légale",
    yKey: "v_legal_kmh",
    color: "#64748b",
    unit: "km/h",
  },
  {
    id: "v_traffic",
    title: "Limite trafic",
    yKey: "v_traffic_kmh",
    color: "#ea580c",
    unit: "km/h",
  },
  {
    id: "v_curve",
    title: "Limite virage",
    yKey: "v_curve_kmh",
    color: "#7c3aed",
    unit: "km/h",
  },
  {
    id: "v_envelope",
    title: "Enveloppe vitesse",
    yKey: "v_envelope_kmh",
    color: "#dc2626",
    unit: "km/h",
  },
  {
    id: "R",
    title: "Rayon de courbure",
    yKey: "R_m",
    color: "#0f766e",
    unit: "m",
  },
  {
    id: "kappa",
    title: "Courbure κ",
    yKey: "kappa_1_per_m",
    color: "#7c3aed",
    unit: "1/m",
  },
  { id: "slope", title: "Pente", yKey: "slope_pct", color: "#16a34a", unit: "%" },
  {
    id: "a_lon",
    title: "Accélération longitudinale",
    yKey: "a_lon_mps2",
    color: "#f59e0b",
    unit: "m/s²",
  },
  {
    id: "a_lon_max",
    title: "Limite a_max",
    yKey: "a_lon_max_mps2",
    color: "#b45309",
    unit: "m/s²",
  },
  {
    id: "a_lon_min",
    title: "Limite −b_comf",
    yKey: "a_lon_min_mps2",
    color: "#92400e",
    unit: "m/s²",
  },
  {
    id: "a_lat",
    title: "Accélération latérale",
    yKey: "a_lat_mps2",
    color: "#a855f7",
    unit: "m/s²",
  },
  {
    id: "a_lat_max",
    title: "Limite a_y",
    yKey: "a_lat_max_mps2",
    color: "#6b21a8",
    unit: "m/s²",
  },
  {
    id: "p_wheel",
    title: "Puissance mécanique roue",
    yKey: "p_wheel_kw",
    color: "#2563eb",
    unit: "kW",
  },
  {
    id: "torque",
    title: "Couple à la roue",
    yKey: "wheel_torque_nm",
    color: "#dc2626",
    unit: "N·m",
  },
  {
    id: "rpm",
    title: "Vitesse rotation roue",
    yKey: "wheel_rpm",
    color: "#0891b2",
    unit: "tr/min",
  },
];

function downsample<T>(arr: T[], maxPts: number): T[] {
  if (arr.length <= maxPts) return arr;
  const step = Math.ceil(arr.length / maxPts);
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[i]);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}

function seriesHasData(rows: ExportCycleRow[], key: keyof ExportCycleRow): boolean {
  return rows.some((r) => {
    const v = r[key];
    return typeof v === "number" && Number.isFinite(v);
  });
}

/** PNG base64 (no data: prefix) for one time-series chart. */
export function renderExportChartPng(
  rows: ExportCycleRow[],
  spec: ChartSeriesSpec,
  opts?: { width?: number; height?: number; maxPts?: number }
): string | null {
  if (typeof document === "undefined") return null;
  if (!rows.length || !seriesHasData(rows, spec.yKey)) return null;

  const width = opts?.width ?? 720;
  const height = opts?.height ?? 280;
  const pts = downsample(rows, opts?.maxPts ?? 900);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const pad = { t: 36, r: 16, b: 40, l: 56 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const xs = pts.map((r) => r.time_s);
  const ys = pts.map((r) => {
    const v = r[spec.yKey];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  });
  const x0 = xs[0];
  const x1 = xs[xs.length - 1] || x0 + 1;
  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);
  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  }
  const yPad = (yMax - yMin) * 0.08;
  yMin -= yPad;
  yMax += yPad;

  const xTo = (x: number) => pad.l + ((x - x0) / Math.max(1e-9, x1 - x0)) * plotW;
  const yTo = (y: number) => pad.t + (1 - (y - yMin) / Math.max(1e-9, yMax - yMin)) * plotH;

  ctx.strokeStyle = "#e2e8f0";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + plotW, y);
    ctx.stroke();
  }

  if (yMin < 0 && yMax > 0) {
    ctx.strokeStyle = "#cbd5e1";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.l, yTo(0));
    ctx.lineTo(pad.l + plotW, yTo(0));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.strokeStyle = spec.color;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const x = xTo(xs[i]);
    const y = yTo(ys[i]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.strokeStyle = "#94a3b8";
  ctx.lineWidth = 1;
  ctx.strokeRect(pad.l, pad.t, plotW, plotH);

  ctx.fillStyle = "#0f172a";
  ctx.font = "600 13px system-ui, sans-serif";
  ctx.fillText(`${spec.title} (${spec.unit})`, pad.l, 22);

  ctx.fillStyle = "#64748b";
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillText("t (s)", pad.l + plotW / 2 - 12, height - 12);
  ctx.fillText(yMax.toFixed(1), 8, pad.t + 10);
  ctx.fillText(yMin.toFixed(1), 8, pad.t + plotH);
  ctx.fillText(`${x0.toFixed(0)} s`, pad.l, height - 14);
  ctx.fillText(`${x1.toFixed(0)} s`, pad.l + plotW - 36, height - 14);

  const dataUrl = canvas.toDataURL("image/png");
  return dataUrl.replace(/^data:image\/png;base64,/, "");
}

export type RouteMapFocus = "full" | "start" | "end";

export type RouteMapVignetteSet = {
  global: string;
  start: string;
  end: string;
};

const MAP_POLY_MAX = 600;
/** Higher point density for the large Excel overview map. */
const MAP_POLY_MAX_DETAIL = 1800;
const TILE_SIZE = 256;
const ENDPOINT_ZOOM = 17;

/** Prefer CARTO Voyager when `NEXT_PUBLIC_CARTO_API_KEY` is set; else OSM. */
const CARTO_API_KEY =
  typeof process !== "undefined"
    ? (process.env.NEXT_PUBLIC_CARTO_API_KEY ?? "").trim()
    : "";
const USE_CARTO = CARTO_API_KEY.length > 0;
const TILE_SUBDOMAINS = USE_CARTO
  ? (["a", "b", "c", "d"] as const)
  : (["a", "b", "c"] as const);

function downsampleIndices(n: number, maxPts: number): number[] {
  if (n <= 0) return [];
  if (n <= maxPts) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < maxPts; i++) {
    out.push(Math.round((i * (n - 1)) / (maxPts - 1)));
  }
  return out;
}

function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}

function latToTileY(lat: number, z: number): number {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const s = Math.sin((clamped * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
}

function focusGeometry(
  geometry: LatLon[],
  focus: RouteMapFocus,
  maxPts = MAP_POLY_MAX
): { pts: LatLon[]; srcIdx: number[] } {
  const idxs = downsampleIndices(geometry.length, maxPts);
  if (focus === "start") {
    const n = Math.max(8, Math.floor(idxs.length * 0.12));
    const srcIdx = idxs.slice(0, n);
    return { pts: srcIdx.map((i) => geometry[i]), srcIdx };
  }
  if (focus === "end") {
    const n = Math.max(8, Math.floor(idxs.length * 0.12));
    const srcIdx = idxs.slice(-n);
    return { pts: srcIdx.map((i) => geometry[i]), srcIdx };
  }
  return { pts: idxs.map((i) => geometry[i]), srcIdx: idxs };
}

function boundsOf(pts: LatLon[]): {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
} {
  let minLat = Infinity,
    maxLat = -Infinity,
    minLon = Infinity,
    maxLon = -Infinity;
  for (const p of pts) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
  }
  // Avoid zero-size bounds (single point / tiny segment)
  const padLat = Math.max(1e-5, (maxLat - minLat) * 0.08);
  const padLon = Math.max(1e-5, (maxLon - minLon) * 0.08);
  return {
    minLat: minLat - padLat,
    maxLat: maxLat + padLat,
    minLon: minLon - padLon,
    maxLon: maxLon + padLon,
  };
}

function fitZoom(
  b: { minLat: number; maxLat: number; minLon: number; maxLon: number },
  size: number,
  padPx: number
): number {
  const usable = Math.max(64, size - padPx * 2);
  for (let z = 18; z >= 2; z--) {
    const w =
      (lonToTileX(b.maxLon, z) - lonToTileX(b.minLon, z)) * TILE_SIZE;
    const h =
      (latToTileY(b.minLat, z) - latToTileY(b.maxLat, z)) * TILE_SIZE;
    if (w <= usable && h <= usable) return z;
  }
  return 2;
}

function loadTileImage(z: number, x: number, y: number): Promise<HTMLImageElement | null> {
  const n = 2 ** z;
  if (y < 0 || y >= n) return Promise.resolve(null);
  const xx = ((x % n) + n) % n;
  const sub = TILE_SUBDOMAINS[Math.abs(xx + y) % TILE_SUBDOMAINS.length];
  const url = USE_CARTO
    ? `https://${sub}.basemaps.cartocdn.com/rastertiles/voyager/${z}/${xx}/${y}.png?key=${encodeURIComponent(CARTO_API_KEY)}`
    : `https://${sub}.tile.openstreetmap.org/${z}/${xx}/${y}.png`;
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const t = window.setTimeout(() => resolve(null), 8000);
    img.onload = () => {
      window.clearTimeout(t);
      resolve(img);
    };
    img.onerror = () => {
      window.clearTimeout(t);
      resolve(null);
    };
    img.src = url;
  });
}

function drawCaption(
  ctx: CanvasRenderingContext2D,
  size: number,
  title: string,
  subtitleLines: string[]
) {
  const grad = ctx.createLinearGradient(0, 0, 0, 56);
  grad.addColorStop(0, "rgba(255,255,255,0.94)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, 56);
  ctx.fillStyle = "#0f172a";
  ctx.font = "700 12px system-ui,sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(title, 9, 8);
  ctx.fillStyle = "#334155";
  ctx.font = "10px system-ui,sans-serif";
  let ty = 24;
  for (const line of subtitleLines) {
    ctx.fillText(line, 9, ty);
    ty += 12;
  }
  ctx.fillStyle = "rgba(15,23,42,0.45)";
  ctx.font = "8px system-ui,sans-serif";
  ctx.fillText(
    USE_CARTO
      ? "© OpenStreetMap contributors · © CARTO"
      : "© OpenStreetMap contributors",
    9,
    size - 12
  );
}

function drawRouteOverlay(
  ctx: CanvasRenderingContext2D,
  args: {
    geometry: LatLon[];
    alpha?: number[] | null;
    focus: RouteMapFocus;
    pts: LatLon[];
    srcIdx: number[];
    toXY: (p: LatLon) => { x: number; y: number };
  }
) {
  const { geometry, alpha, focus, pts, srcIdx, toXY } = args;
  const hasAlpha =
    !!alpha && alpha.length === geometry.length && geometry.length >= 2;

  // White halo for contrast on busy basemap
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 7;
  ctx.beginPath();
  for (let k = 0; k < pts.length; k++) {
    const { x, y } = toXY(pts[k]);
    if (k === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  for (let k = 1; k < pts.length; k++) {
    const a = toXY(pts[k - 1]);
    const b = toXY(pts[k]);
    const gi = srcIdx[k] ?? k;
    ctx.strokeStyle = hasAlpha
      ? alphaToColor(alpha![Math.min(gi, alpha!.length - 1)] ?? 0)
      : "#2563eb";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  const drawMarker = (p: LatLon, fill: string, label: string) => {
    const { x, y } = toXY(p);
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "700 10px system-ui,sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x, y + 0.5);
  };
  drawMarker(pts[0], "#16a34a", focus === "end" ? "…" : "A");
  drawMarker(pts[pts.length - 1], "#dc2626", focus === "start" ? "…" : "B");
}

/**
 * Basemap tiles + slope-colored route (looks like the studio map).
 * Falls back to a plain schematic if tiles cannot be loaded.
 */
async function renderRouteMapVignette(args: {
  geometry: LatLon[];
  alpha?: number[] | null;
  focus: RouteMapFocus;
  size: number;
  title: string;
  subtitleLines: string[];
  /** Max polyline samples (higher = more detail on large maps). */
  maxPts?: number;
  /** Extra padding around the route when fitting zoom (full view). */
  padPx?: number;
}): Promise<string | null> {
  if (typeof document === "undefined") return null;
  const { geometry, alpha, focus, size, title, subtitleLines } = args;
  if (geometry.length < 2) return null;

  const maxPts =
    args.maxPts ??
    (focus === "full" && size >= 480 ? MAP_POLY_MAX_DETAIL : MAP_POLY_MAX);
  const { pts, srcIdx } = focusGeometry(geometry, focus, maxPts);
  if (pts.length < 2) return null;

  const b = boundsOf(pts);
  const padPx = args.padPx ?? (focus === "full" ? 48 : 24);
  const z =
    focus === "full" ? fitZoom(b, size, padPx) : ENDPOINT_ZOOM;

  let worldLeft: number;
  let worldTop: number;
  if (focus === "full") {
    // Center in Web Mercator pixels so the full route is framed tightly.
    const x0 = lonToTileX(b.minLon, z) * TILE_SIZE;
    const x1 = lonToTileX(b.maxLon, z) * TILE_SIZE;
    const y0 = latToTileY(b.maxLat, z) * TILE_SIZE;
    const y1 = latToTileY(b.minLat, z) * TILE_SIZE;
    worldLeft = (x0 + x1) / 2 - size / 2;
    worldTop = (y0 + y1) / 2 - size / 2;
  } else {
    const a = geometry[0];
    const end = geometry[geometry.length - 1];
    const centerLon = focus === "start" ? a.lon : end.lon;
    const centerLat = focus === "start" ? a.lat : end.lat;
    const centerPxX = lonToTileX(centerLon, z) * TILE_SIZE;
    const centerPxY = latToTileY(centerLat, z) * TILE_SIZE;
    worldLeft = centerPxX - size / 2;
    worldTop = centerPxY - size / 2;
  }

  const tileX0 = Math.floor(worldLeft / TILE_SIZE);
  const tileY0 = Math.floor(worldTop / TILE_SIZE);
  const tileX1 = Math.floor((worldLeft + size) / TILE_SIZE);
  const tileY1 = Math.floor((worldTop + size) / TILE_SIZE);

  const tileJobs: { x: number; y: number; img: Promise<HTMLImageElement | null> }[] =
    [];
  for (let ty = tileY0; ty <= tileY1; ty++) {
    for (let tx = tileX0; tx <= tileX1; tx++) {
      tileJobs.push({ x: tx, y: ty, img: loadTileImage(z, tx, ty) });
    }
  }
  const loaded = await Promise.all(tileJobs.map(async (j) => ({ ...j, el: await j.img })));
  const okCount = loaded.filter((t) => t.el).length;
  const useTiles = okCount >= Math.max(1, Math.floor(loaded.length * 0.4));

  const dpr = 2;
  const canvas = document.createElement("canvas");
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);

  ctx.fillStyle = useTiles ? "#dbe4ee" : "#f1f5f9";
  ctx.fillRect(0, 0, size, size);

  if (useTiles) {
    for (const t of loaded) {
      if (!t.el) continue;
      const dx = t.x * TILE_SIZE - worldLeft;
      const dy = t.y * TILE_SIZE - worldTop;
      ctx.drawImage(t.el, dx, dy, TILE_SIZE, TILE_SIZE);
    }
  } else {
    ctx.strokeStyle = "#e2e8f0";
    ctx.lineWidth = 1;
    for (let i = 1; i < 6; i++) {
      const p = (size * i) / 6;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, p);
      ctx.lineTo(size, p);
      ctx.stroke();
    }
  }

  const toXY = (p: LatLon) => ({
    x: lonToTileX(p.lon, z) * TILE_SIZE - worldLeft,
    y: latToTileY(p.lat, z) * TILE_SIZE - worldTop,
  });

  drawRouteOverlay(ctx, {
    geometry,
    alpha,
    focus,
    pts,
    srcIdx,
    toXY,
  });
  drawCaption(ctx, size, title, subtitleLines);

  try {
    return canvas
      .toDataURL("image/png")
      .replace(/^data:image\/png;base64,/, "");
  } catch {
    return null;
  }
}

/**
 * Single large overview map for Excel Tracabilite (full route, max detail).
 */
export async function renderRouteMapOverview(
  geometry: LatLon[] | null | undefined,
  opts?: {
    size?: number;
    gpsA?: string | null;
    gpsB?: string | null;
    elevA_m?: number | null;
    elevB_m?: number | null;
    alpha?: number[] | null;
  }
): Promise<string | null> {
  if (!geometry || geometry.length < 2) return null;
  const size = opts?.size ?? 720;
  const fmtAlt = (v: number | null | undefined) =>
    v != null && Number.isFinite(v) ? `${Math.round(v)} m` : "—";

  const sub: string[] = [
    `${geometry.length} pts · vue d’ensemble A→B`,
  ];
  if (opts?.gpsA || opts?.gpsB) {
    sub.push(
      `A ${opts?.gpsA ?? "—"} (${fmtAlt(opts?.elevA_m)}) → B ${opts?.gpsB ?? "—"} (${fmtAlt(opts?.elevB_m)})`
    );
  }

  return renderRouteMapVignette({
    geometry,
    alpha: opts?.alpha,
    focus: "full",
    size,
    title: "Trajet complet",
    subtitleLines: sub,
    maxPts: MAP_POLY_MAX_DETAIL,
    padPx: Math.max(40, Math.round(size * 0.06)),
  });
}

/**
 * @deprecated Prefer {@link renderRouteMapOverview}. Kept for compatibility.
 */
export async function renderRouteMapVignettes(
  geometry: LatLon[] | null | undefined,
  opts?: {
    size?: number;
    gpsA?: string | null;
    gpsB?: string | null;
    elevA_m?: number | null;
    elevB_m?: number | null;
    /** Slope α (rad), same length as geometry — colors the route like the app. */
    alpha?: number[] | null;
  }
): Promise<RouteMapVignetteSet | null> {
  const global = await renderRouteMapOverview(geometry, opts);
  if (!global) return null;
  return { global, start: global, end: global };
}
