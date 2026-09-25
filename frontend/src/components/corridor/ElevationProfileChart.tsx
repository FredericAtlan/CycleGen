"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SlopeKmSegment, SpatialCorridor } from "@/lib/types";
import { DEFAULT_SLOPE_ALGO } from "@/lib/slopeAlgo";
import { APP_NAME } from "@/lib/branding";
import {
  formatCoord,
  parsePlaceFromLabel,
} from "@/lib/placeLabel";

export type ElevationProfileMeta = {
  originLat?: number | null;
  originLon?: number | null;
  destLat?: number | null;
  destLon?: number | null;
  originLabel?: string | null;
  destLabel?: string | null;
};

type ElevationProfileChartProps = {
  corridor: SpatialCorridor;
  tall?: boolean;
  /** Fallback L when slope_profile is missing (e.g. UI setting). */
  trapLengthM?: number;
  meta?: ElevationProfileMeta | null;
  /** Shared playhead / hover cursor along S (m). */
  highlightS?: number | null;
  onCursorS?: (s_m: number | null) => void;
  syncEnabled?: boolean;
};

type ElevPt = { s_km: number; z_m: number };

type ChartLayout = {
  W: number;
  H: number;
  padL: number;
  padR: number;
  padT: number;
  padB: number;
  plotW: number;
  plotH: number;
  sMin: number;
  sMax: number;
  zMin: number;
  zMax: number;
  xScale: (s: number) => number;
  yScale: (z: number) => number;
  yBase: number;
};

/** Classes de pente sur |moyenne %| (sévérité). Descente = même teinte + marqueur. */
export const SLOPE_GRADE_LEGEND: {
  label: string;
  color: string;
  /** Inclusive low, exclusive high on |mean| (last band hi=Infinity). */
  lo: number;
  hi: number;
}[] = [
  { label: "|p| < 4 %", color: "#8fce68", lo: 0, hi: 4 },
  { label: "|p| < 6 %", color: "#6eb6e6", lo: 4, hi: 6 },
  { label: "|p| < 8 %", color: "#f2d15c", lo: 6, hi: 8 },
  { label: "|p| < 10 %", color: "#e57373", lo: 8, hi: 10 },
  { label: "|p| > 10 %", color: "#4a4a4a", lo: 10, hi: Infinity },
];

export const DESCENT_MARKER_COLOR = "#2563eb";

/** Pente moyenne d’un km — coerce + fallback Δz/Δs si besoin. */
export function resolveKmMeanPct(seg: {
  mean_pct?: number | string | null;
  z0_m?: number;
  z1_m?: number;
  s0_m?: number;
  s1_m?: number;
}): number {
  const raw = seg.mean_pct as unknown;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  const z0 = Number(seg.z0_m);
  const z1 = Number(seg.z1_m);
  const s0 = Number(seg.s0_m);
  const s1 = Number(seg.s1_m);
  const ds = s1 - s0;
  if (
    Number.isFinite(z0) &&
    Number.isFinite(z1) &&
    Number.isFinite(ds) &&
    Math.abs(ds) > 1e-6
  ) {
    return (100 * (z1 - z0)) / ds;
  }
  return 0;
}

/** Couleur de classe depuis |mean_pct|. */
export function gradeBandColor(meanPct: number): string {
  const g = Math.abs(Number(meanPct));
  if (!Number.isFinite(g)) return SLOPE_GRADE_LEGEND[0].color;
  for (const band of SLOPE_GRADE_LEGEND) {
    if (g >= band.lo && g < band.hi) return band.color;
  }
  return SLOPE_GRADE_LEGEND[SLOPE_GRADE_LEGEND.length - 1].color;
}

export function isDescentMean(meanPct: number): boolean {
  return Number.isFinite(meanPct) && meanPct < -1e-6;
}

/** Tint léger pour fond de ligne tableau (alpha 0–1). */
export function hexWithAlpha(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Texte sombre sauf sur bande gris foncé (>10 %). */
function gradeBandNeedsDarkText(meanPct: number): boolean {
  return Math.abs(Number(meanPct)) < 10;
}

function downsampleElev(
  S: number[],
  z: number[],
  maxPts = 600
): ElevPt[] {
  const n = Math.min(S.length, z.length);
  if (n < 2) return [];
  const step = Math.max(1, Math.floor(n / maxPts));
  const rows: ElevPt[] = [];
  for (let i = 0; i < n; i += step) {
    rows.push({ s_km: S[i] / 1000, z_m: z[i] });
  }
  if ((n - 1) % step !== 0) {
    const i = n - 1;
    rows.push({ s_km: S[i] / 1000, z_m: z[i] });
  }
  return rows;
}

function polylinePath(
  pts: ElevPt[],
  xScale: (s: number) => number,
  yScale: (z: number) => number
): string {
  if (pts.length < 2) return "";
  return pts
    .map((p, i) => {
      const x = xScale(p.s_km).toFixed(1);
      const y = yScale(p.z_m).toFixed(1);
      return `${i === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");
}

function computeLayout(
  elevPts: ElevPt[],
  kmSegments: SlopeKmSegment[],
  size: "compact" | "wide",
  tall: boolean
): ChartLayout {
  const W = size === "wide" ? 1400 : 720;
  const H =
    size === "wide" ? 300 : tall ? 260 : 200;
  const padL = size === "wide" ? 52 : 44;
  const padR = size === "wide" ? 18 : 14;
  const padT = size === "wide" ? 28 : 22;
  const padB = kmSegments.length
    ? size === "wide"
      ? 58
      : 52
    : 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  let sMin = 0;
  let sMax = 1;
  let zMin = 0;
  let zMax = 100;
  if (elevPts.length >= 2) {
    sMin = elevPts[0].s_km;
    sMax = elevPts[elevPts.length - 1].s_km;
    zMin = Math.min(...elevPts.map((p) => p.z_m));
    zMax = Math.max(...elevPts.map((p) => p.z_m));
  } else if (kmSegments.length) {
    sMin = kmSegments[0].s0_m / 1000;
    sMax = kmSegments[kmSegments.length - 1].s1_m / 1000;
    zMin = Math.min(...kmSegments.map((s) => Math.min(s.z0_m, s.z1_m)));
    zMax = Math.max(...kmSegments.map((s) => Math.max(s.z0_m, s.z1_m)));
  }
  if (sMax <= sMin) sMax = sMin + 0.001;
  const zPad = Math.max(5, (zMax - zMin) * 0.08);
  zMin -= zPad;
  zMax += zPad;
  if (zMax <= zMin) zMax = zMin + 1;

  const xScale = (s: number) => padL + ((s - sMin) / (sMax - sMin)) * plotW;
  const yScale = (z: number) =>
    padT + (1 - (z - zMin) / (zMax - zMin)) * plotH;
  const yBase = padT + plotH;

  return {
    W,
    H,
    padL,
    padR,
    padT,
    padB,
    plotW,
    plotH,
    sMin,
    sMax,
    zMin,
    zMax,
    xScale,
    yScale,
    yBase,
  };
}

function yTicksFor(layout: ChartLayout): number[] {
  const { zMin, zMax } = layout;
  const span = zMax - zMin;
  const step =
    span > 400 ? 100 : span > 200 ? 50 : span > 80 ? 20 : span > 30 ? 10 : 5;
  const ticks: number[] = [];
  const start = Math.ceil(zMin / step) * step;
  for (let z = start; z <= zMax; z += step) ticks.push(z);
  return ticks;
}

export default function ElevationProfileChart({
  corridor,
  tall = false,
  trapLengthM,
  meta = null,
  highlightS = null,
  onCursorS,
  syncEnabled = true,
}: ElevationProfileChartProps) {
  const [selectedKm, setSelectedKm] = useState<number | null>(null);
  const [hoverKm, setHoverKm] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [mounted, setMounted] = useState(false);
  const kmRowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map());
  const tableScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [expanded]);

  useEffect(() => {
    if (selectedKm == null) return;
    const row = kmRowRefs.current.get(selectedKm);
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedKm, expanded]);

  const toggleKm = (km: number) => {
    setSelectedKm((prev) => (prev === km ? null : km));
  };

  const elevPts = useMemo(() => {
    const z = corridor.elevations_m;
    if (!z?.length || !corridor.S?.length) return [];
    return downsampleElev(corridor.S, z, tall || expanded ? 900 : 500);
  }, [corridor.S, corridor.elevations_m, tall, expanded]);

  const profile = corridor.slope_profile ?? null;
  const kmSegments = profile?.km_segments ?? [];
  const L =
    profile?.trap_length_m ??
    trapLengthM ??
    DEFAULT_SLOPE_ALGO.trapLengthM;

  const geom = corridor.geometry;
  const originLat = meta?.originLat ?? geom?.[0]?.lat ?? null;
  const originLon = meta?.originLon ?? geom?.[0]?.lon ?? null;
  const destLat =
    meta?.destLat ??
    (geom && geom.length >= 2 ? geom[geom.length - 1].lat : null);
  const destLon =
    meta?.destLon ??
    (geom && geom.length >= 2 ? geom[geom.length - 1].lon : null);
  const originPlace = parsePlaceFromLabel(meta?.originLabel);
  const destPlace = parsePlaceFromLabel(meta?.destLabel);

  const selected = useMemo(
    () =>
      selectedKm == null
        ? null
        : kmSegments.find((s) => s.km_index === selectedKm) ?? null,
    [kmSegments, selectedKm]
  );

  const hoverSeg = useMemo(
    () =>
      hoverKm == null
        ? null
        : kmSegments.find((s) => s.km_index === hoverKm) ?? null,
    [kmSegments, hoverKm]
  );

  const compactLayout = useMemo(
    () => computeLayout(elevPts, kmSegments, "compact", tall),
    [elevPts, kmSegments, tall]
  );
  const wideLayout = useMemo(
    () => computeLayout(elevPts, kmSegments, "wide", true),
    [elevPts, kmSegments]
  );

  const endLabels = useMemo(() => {
    if (elevPts.length < 2) return null;
    const a = elevPts[0];
    const b = elevPts[elevPts.length - 1];
    return {
      z0: Math.round(a.z_m),
      z1: Math.round(b.z_m),
      s0: a.s_km,
      s1: b.s_km,
    };
  }, [elevPts]);

  const hasElev = elevPts.length >= 2;
  const hasBands = kmSegments.length > 0;
  const titleLine =
    originPlace.city !== "—" || destPlace.city !== "—"
      ? `${originPlace.city} → ${destPlace.city}`
      : "Profil d'altitude";

  const headerBlock = (opts?: { showExpand?: boolean }) => (
    <div className="rounded-md border border-slate-200 bg-white px-2.5 py-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-bold tracking-wide text-slate-900">
            {APP_NAME}
          </p>
          <p className="truncate text-[12px] font-semibold uppercase tracking-wide text-slate-700">
            {titleLine}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-slate-700">
            Trapèzes L = {L} m
          </span>
          {opts?.showExpand !== false && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-700 hover:bg-slate-50"
              title="Élargir le profil (75 % de l’écran)"
            >
              Agrandir
            </button>
          )}
        </div>
      </div>
      <div className="mt-1.5 grid grid-cols-1 gap-1.5 text-[10px] leading-snug text-slate-600 sm:grid-cols-2">
        <div className="rounded border border-slate-100 bg-slate-50/80 px-2 py-1">
          <p className="font-semibold uppercase tracking-wide text-slate-500">
            Départ
          </p>
          <p className="tabular-nums text-slate-800">
            {formatCoord(originLat, originLon)}
          </p>
          <p>
            <span className="font-medium text-slate-800">
              {originPlace.city}
            </span>
            <span className="text-slate-400"> · </span>
            {originPlace.country}
          </p>
        </div>
        <div className="rounded border border-slate-100 bg-slate-50/80 px-2 py-1">
          <p className="font-semibold uppercase tracking-wide text-slate-500">
            Arrivée
          </p>
          <p className="tabular-nums text-slate-800">
            {formatCoord(destLat, destLon)}
          </p>
          <p>
            <span className="font-medium text-slate-800">{destPlace.city}</span>
            <span className="text-slate-400"> · </span>
            {destPlace.country}
          </p>
        </div>
      </div>
    </div>
  );

  const legend = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[9px] text-slate-600">
      <span className="font-semibold uppercase tracking-wide text-slate-500">
        Classes |pente|
      </span>
      {SLOPE_GRADE_LEGEND.map((band) => (
        <span key={band.label} className="inline-flex items-center gap-1">
          <span
            className="inline-block h-2.5 w-3.5 rounded-sm border border-slate-300"
            style={{ backgroundColor: band.color }}
          />
          {band.label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1">
        <span
          className="inline-block h-2.5 w-1 rounded-sm"
          style={{ backgroundColor: DESCENT_MARKER_COLOR }}
        />
        descente (moy &lt; 0)
      </span>
    </div>
  );

  /** White mask above the elevation polyline so km colors only show under the profile. */
  const maskAboveElevation = (layout: ChartLayout): string => {
    if (elevPts.length < 2) return "";
    const x0 = layout.xScale(elevPts[0].s_km);
    const x1 = layout.xScale(elevPts[elevPts.length - 1].s_km);
    const top = layout.padT;
    const parts: string[] = [
      `M ${x0.toFixed(1)} ${top.toFixed(1)}`,
      `L ${x1.toFixed(1)} ${top.toFixed(1)}`,
      `L ${x1.toFixed(1)} ${layout.yScale(elevPts[elevPts.length - 1].z_m).toFixed(1)}`,
    ];
    for (let i = elevPts.length - 2; i >= 0; i--) {
      const p = elevPts[i];
      parts.push(
        `L ${layout.xScale(p.s_km).toFixed(1)} ${layout.yScale(p.z_m).toFixed(1)}`
      );
    }
    parts.push("Z");
    return parts.join(" ");
  };

  const chartSvg = (layout: ChartLayout, size: "compact" | "wide") => {
    const ticks = yTicksFor(layout);
    const meanMinW = size === "wide" ? 12 : 16;
    const statsMinW = size === "wide" ? 22 : 28;
    const labelStripH = kmSegments.length ? (size === "wide" ? 44 : 40) : 0;
    const aboveMask = maskAboveElevation(layout);
    return (
      <div className="relative w-full">
        <svg
          viewBox={`0 0 ${layout.W} ${layout.H}`}
          className="h-auto w-full rounded-md border border-slate-200 bg-white"
          role="img"
          aria-label="Profil d'altitude par bandes de 1 km"
        >
          {/* defs: hatch for descent km (id unique compact/wide si les 2 SVG coexistent) */}
          <defs>
            <pattern
              id={`cg-descent-hatch-${size}`}
              patternUnits="userSpaceOnUse"
              width="6"
              height="6"
              patternTransform="rotate(45)"
            >
              <line
                x1="0"
                y1="0"
                x2="0"
                y2="6"
                stroke={DESCENT_MARKER_COLOR}
                strokeWidth="1.5"
                strokeOpacity="0.45"
              />
            </pattern>
          </defs>

          {ticks.map((z) => (
            <g key={z}>
              <line
                x1={layout.padL}
                x2={layout.W - layout.padR}
                y1={layout.yScale(z)}
                y2={layout.yScale(z)}
                stroke="#e2e8f0"
                strokeDasharray="3 3"
              />
              <text
                x={layout.padL - 6}
                y={layout.yScale(z) + 3}
                textAnchor="end"
                className="fill-slate-500"
                style={{ fontSize: size === "wide" ? 11 : 10 }}
              >
                {Math.round(z)}
              </text>
            </g>
          ))}

          {/* Full-height km rectangles colored by |mean| class */}
          {hasBands &&
            kmSegments.map((seg) => {
              const mean = resolveKmMeanPct(seg);
              const color = gradeBandColor(mean);
              const descent = isDescentMean(mean);
              const s0 = seg.s0_m / 1000;
              const s1 = seg.s1_m / 1000;
              const x0 = layout.xScale(s0);
              const x1 = layout.xScale(s1);
              const w = Math.max(1, x1 - x0);
              const active =
                selectedKm === seg.km_index || hoverKm === seg.km_index;
              return (
                <g key={`fill-${seg.km_index}`}>
                  <rect
                    x={x0}
                    y={layout.padT}
                    width={w}
                    height={layout.plotH}
                    fill={color}
                    fillOpacity={active ? 1 : 0.92}
                    stroke="#64748b"
                    strokeWidth={0.5}
                  />
                  {descent && (
                    <>
                      <rect
                        x={x0}
                        y={layout.padT}
                        width={w}
                        height={layout.plotH}
                        fill={`url(#cg-descent-hatch-${size})`}
                        pointerEvents="none"
                      />
                      <rect
                        x={x0}
                        y={layout.padT}
                        width={Math.min(4, w)}
                        height={layout.plotH}
                        fill={DESCENT_MARKER_COLOR}
                        fillOpacity={0.85}
                        pointerEvents="none"
                      />
                    </>
                  )}
                </g>
              );
            })}

          {/* Mask above elevation so only the area under the profile keeps km colors */}
          {aboveMask && (
            <path d={aboveMask} fill="#ffffff" stroke="none" />
          )}

          {/* Km separators */}
          {hasBands &&
            kmSegments.map((seg) => {
              const x = layout.xScale(seg.s0_m / 1000);
              return (
                <line
                  key={`sep-${seg.km_index}`}
                  x1={x}
                  x2={x}
                  y1={layout.padT}
                  y2={layout.yBase}
                  stroke="#64748b"
                  strokeOpacity={0.35}
                  strokeWidth={0.6}
                />
              );
            })}

          {hasElev && (
            <path
              d={polylinePath(elevPts, layout.xScale, layout.yScale)}
              fill="none"
              stroke="#0f172a"
              strokeWidth={size === "wide" ? 2 : 1.6}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}

          {endLabels && (
            <>
              <text
                x={layout.xScale(endLabels.s0) + 4}
                y={layout.yScale(endLabels.z0) - 4}
                className="fill-slate-700"
                style={{ fontSize: size === "wide" ? 11 : 9, fontWeight: 700 }}
              >
                {endLabels.z0}
              </text>
              <text
                x={layout.xScale(endLabels.s1) - 4}
                y={layout.yScale(endLabels.z1) - 4}
                textAnchor="end"
                className="fill-slate-700"
                style={{ fontSize: size === "wide" ? 11 : 9, fontWeight: 700 }}
              >
                {endLabels.z1}
              </text>
            </>
          )}

          {/* Colored label strip under each km + hit targets */}
          {kmSegments.map((seg) => {
            const mean = resolveKmMeanPct(seg);
            const descent = isDescentMean(mean);
            const s0 = seg.s0_m / 1000;
            const s1 = seg.s1_m / 1000;
            const x0 = layout.xScale(s0);
            const x1 = layout.xScale(s1);
            const bandW = Math.max(1, x1 - x0);
            const cx = (x0 + x1) / 2;
            const isSelected = selectedKm === seg.km_index;
            const showStats = bandW >= statsMinW;
            const showMean = bandW >= meanMinW;
            const color = gradeBandColor(mean);
            const dark = gradeBandNeedsDarkText(mean);
            const stripTop = layout.yBase;
            const stripH = Math.min(labelStripH || 36, layout.padB - 4);
            return (
              <g key={`hit-${seg.km_index}`}>
                <rect
                  x={x0}
                  y={stripTop}
                  width={bandW}
                  height={Math.max(stripH, 28)}
                  fill={color}
                  stroke="#64748b"
                  strokeWidth={0.5}
                  fillOpacity={1}
                />
                {descent && (
                  <rect
                    x={x0}
                    y={stripTop}
                    width={Math.min(3, bandW)}
                    height={Math.max(stripH, 28)}
                    fill={DESCENT_MARKER_COLOR}
                    pointerEvents="none"
                  />
                )}
                <rect
                  x={x0}
                  y={layout.padT}
                  width={bandW}
                  height={layout.plotH + Math.max(stripH, 28)}
                  fill="transparent"
                  className="cursor-pointer"
                  onMouseEnter={() => {
                    setHoverKm(seg.km_index);
                    if (syncEnabled && onCursorS) {
                      onCursorS((seg.s0_m + seg.s1_m) / 2);
                    }
                  }}
                  onMouseLeave={() => {
                    setHoverKm(null);
                    if (syncEnabled) onCursorS?.(null);
                  }}
                  onClick={() => toggleKm(seg.km_index)}
                >
                  <title>
                    {`km ${seg.km_index} · moy ${mean.toFixed(1)} % · min ${seg.min_pct.toFixed(1)} · max ${seg.max_pct.toFixed(1)} · σ ${seg.std_pct.toFixed(1)}${descent ? " · descente" : ""}`}
                  </title>
                </rect>
                {isSelected && (
                  <rect
                    x={x0}
                    y={layout.padT}
                    width={bandW}
                    height={layout.plotH}
                    fill="none"
                    stroke="#0f172a"
                    strokeWidth={1.6}
                    strokeDasharray="3 2"
                    pointerEvents="none"
                  />
                )}
                {showMean && (
                  <text
                    x={cx}
                    y={stripTop + (showStats ? 14 : 18)}
                    textAnchor="middle"
                    fill={dark ? "#0f172a" : "#f8fafc"}
                    style={{
                      fontSize: showStats ? (size === "wide" ? 12 : 11) : 9,
                      fontWeight: 700,
                    }}
                    pointerEvents="none"
                  >
                    {mean.toFixed(1)}
                  </text>
                )}
                {showStats && (
                  <>
                    <text
                      x={cx}
                      y={stripTop + 26}
                      textAnchor="middle"
                      fill={dark ? "#334155" : "#e2e8f0"}
                      style={{ fontSize: size === "wide" ? 9 : 7.5 }}
                      pointerEvents="none"
                    >
                      {`${seg.min_pct.toFixed(1)}…${seg.max_pct.toFixed(1)}`}
                    </text>
                    <text
                      x={cx}
                      y={stripTop + 36}
                      textAnchor="middle"
                      fill={dark ? "#475569" : "#cbd5e1"}
                      style={{ fontSize: size === "wide" ? 9 : 7.5 }}
                      pointerEvents="none"
                    >
                      {`σ ${seg.std_pct.toFixed(1)}`}
                    </text>
                  </>
                )}
              </g>
            );
          })}

          <text
            x={12}
            y={layout.padT + layout.plotH / 2}
            textAnchor="middle"
            className="fill-slate-400"
            style={{ fontSize: 9 }}
            transform={`rotate(-90 12 ${layout.padT + layout.plotH / 2})`}
          >
            altitude (m)
          </text>

          {highlightS != null &&
            Number.isFinite(highlightS) &&
            (() => {
              const sKm = highlightS / 1000;
              if (sKm < layout.sMin || sKm > layout.sMax) return null;
              const x = layout.xScale(sKm);
              return (
                <line
                  x1={x}
                  x2={x}
                  y1={layout.padT}
                  y2={layout.padT + layout.plotH}
                  stroke="#0f172a"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  pointerEvents="none"
                />
              );
            })()}
        </svg>

        {!hasBands && (
          <p className="mt-1 text-[11px] text-amber-700/90">
            Profil 1 km indisponible — reconstruire le cycle.
          </p>
        )}

        {hoverSeg && !selected && <KmTooltip seg={hoverSeg} L={L} />}
      </div>
    );
  };

  const kmTable = (
    <table className="w-full min-w-[28rem] text-left text-[11px] tabular-nums text-slate-700">
      <thead className="sticky top-0 z-[1] bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 shadow-sm">
        <tr>
          <th className="px-2 py-1.5 font-semibold">km</th>
          <th className="px-2 py-1.5 font-semibold">s₀–s₁</th>
          <th className="px-2 py-1.5 font-semibold">moy %</th>
          <th className="px-2 py-1.5 font-semibold">min %</th>
          <th className="px-2 py-1.5 font-semibold">max %</th>
          <th className="px-2 py-1.5 font-semibold">σ %</th>
          <th className="px-2 py-1.5 font-semibold">Δz m</th>
          <th className="px-2 py-1.5 font-semibold">trap.</th>
        </tr>
      </thead>
      <tbody>
        {kmSegments.map((seg) => {
          const active = selectedKm === seg.km_index;
          const mean = resolveKmMeanPct(seg);
          const color = gradeBandColor(mean);
          const descent = isDescentMean(mean);
          return (
            <tr
              key={seg.km_index}
              ref={(el) => {
                if (el) kmRowRefs.current.set(seg.km_index, el);
                else kmRowRefs.current.delete(seg.km_index);
              }}
              className={`cursor-pointer border-t border-slate-200/80 ${
                active ? "ring-2 ring-inset ring-slate-800" : "hover:brightness-95"
              }`}
              style={{
                backgroundColor: hexWithAlpha(color, 0.22),
                boxShadow: descent
                  ? `inset 4px 0 0 0 ${DESCENT_MARKER_COLOR}`
                  : `inset 4px 0 0 0 ${color}`,
              }}
              onClick={() => toggleKm(seg.km_index)}
            >
              <td className="px-2 py-1.5 font-semibold text-slate-900">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-block h-2.5 w-3.5 shrink-0 rounded-sm border border-slate-300"
                    style={{ backgroundColor: color }}
                    title={descent ? "Descente" : "Montée / plat"}
                  />
                  {seg.km_index}
                  {descent && (
                    <span className="text-[9px] font-bold text-blue-600">
                      ↓
                    </span>
                  )}
                </span>
              </td>
              <td className="px-2 py-1.5 text-slate-700">
                {(seg.s0_m / 1000).toFixed(2)}–{(seg.s1_m / 1000).toFixed(2)}
              </td>
              <td className="px-2 py-1.5 font-bold text-slate-900">
                {mean.toFixed(1)}
              </td>
              <td className="px-2 py-1.5 text-slate-700">
                {seg.min_pct.toFixed(1)}
              </td>
              <td className="px-2 py-1.5 text-slate-700">
                {seg.max_pct.toFixed(1)}
              </td>
              <td className="px-2 py-1.5 text-slate-700">
                {seg.std_pct.toFixed(1)}
              </td>
              <td className="px-2 py-1.5 text-slate-700">
                {seg.z1_m - seg.z0_m >= 0 ? "+" : ""}
                {(seg.z1_m - seg.z0_m).toFixed(1)}
              </td>
              <td className="px-2 py-1.5 text-slate-700">
                {seg.traps?.length ?? 0}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  const body = (
    <div className="space-y-2">
      {headerBlock({ showExpand: true })}
      {legend}
      {!hasElev && !hasBands ? (
        <div
          className={`flex items-center justify-center rounded-md border border-dashed border-slate-200 bg-slate-50/60 text-[11px] text-slate-500 ${
            tall ? "h-52" : "h-36"
          }`}
        >
          Altitudes indisponibles — reconstruire le cycle
        </div>
      ) : (
        chartSvg(compactLayout, "compact")
      )}
      {selected && (
        <KmDetailPanel
          seg={selected}
          L={L}
          onClose={() => setSelectedKm(null)}
        />
      )}
    </div>
  );

  const drawer =
    mounted &&
    expanded &&
    createPortal(
      <div className="fixed inset-0 z-[1200] flex justify-start">
        <aside
          className="relative flex h-full w-[75vw] min-w-[20rem] max-w-full flex-col border-r border-slate-200 bg-white shadow-2xl"
          style={{ animation: "cyclegen-elev-drawer-in 280ms ease-out" }}
          role="dialog"
          aria-modal="true"
          aria-label="Profil d'altitude élargi"
        >
          <style>{`
            @keyframes cyclegen-elev-drawer-in {
              from { transform: translateX(-100%); }
              to { transform: translateX(0); }
            }
          `}</style>
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900">
                Profil de pente
              </p>
              <p className="truncate text-[11px] text-slate-500">
                {titleLine} · L = {L} m · 75 % largeur
              </p>
            </div>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="shrink-0 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
            >
              Fermer
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            {/* Profil — toujours visible */}
            <div className="flex min-h-0 shrink-0 flex-col space-y-2 overflow-y-auto border-b border-slate-200 bg-white p-3 lg:w-[55%] lg:border-b-0 lg:border-r lg:border-slate-200">
              {headerBlock({ showExpand: false })}
              {legend}
              <div className="max-h-[55vh] w-full shrink-0 overflow-hidden lg:max-h-none">
                {hasElev || hasBands ? (
                  chartSvg(wideLayout, "wide")
                ) : (
                  <p className="text-sm text-slate-500">Pas d’altitude.</p>
                )}
              </div>
              {selected && (
                <KmDetailPanel
                  seg={selected}
                  L={L}
                  onClose={() => setSelectedKm(null)}
                />
              )}
            </div>
            {/* Tableau km — scroll pleine hauteur */}
            {kmSegments.length > 0 ? (
              <div className="flex min-h-[40vh] min-w-0 flex-1 flex-col p-3 pt-2 lg:min-h-0">
                <p className="mb-1.5 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  Sections kilomètres — scroll · clic = détail / sync graphe
                </p>
                <div
                  ref={tableScrollRef}
                  className="min-h-0 flex-1 overflow-y-auto rounded-md border border-slate-200 bg-white"
                >
                  {kmTable}
                </div>
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center p-4 text-[11px] text-slate-500">
                Aucune section km
              </div>
            )}
          </div>
        </aside>
        <button
          type="button"
          aria-label="Fermer le profil élargi"
          className="min-w-0 flex-1 bg-slate-900/35"
          onClick={() => setExpanded(false)}
        />
      </div>,
      document.body
    );

  return (
    <>
      {body}
      {drawer}
    </>
  );
}

function KmTooltip({ seg, L }: { seg: SlopeKmSegment; L: number }) {
  const mean = resolveKmMeanPct(seg);
  return (
    <div className="pointer-events-none absolute right-1 top-1 z-10 max-w-[15rem] rounded border border-slate-200 bg-white/95 px-2 py-1.5 text-[10px] text-slate-600 shadow-sm">
      <p className="font-semibold text-slate-800">
        km {seg.km_index} · {mean.toFixed(1)} %{isDescentMean(mean) ? " ↓" : ""}
      </p>
      <p className="tabular-nums">
        min {seg.min_pct.toFixed(1)} · max {seg.max_pct.toFixed(1)} · σ{" "}
        {seg.std_pct.toFixed(1)}
      </p>
      <p className="text-slate-400">L = {L} m · clic pour détail</p>
    </div>
  );
}

function KmDetailPanel({
  seg,
  L,
  onClose,
}: {
  seg: SlopeKmSegment;
  L: number;
  onClose: () => void;
}) {
  const mean = resolveKmMeanPct(seg);
  const dz = seg.z1_m - seg.z0_m;
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50/80 px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold text-slate-800">
            km {seg.km_index}{" "}
            <span className="font-normal text-slate-500">
              ({(seg.s0_m / 1000).toFixed(2)}–{(seg.s1_m / 1000).toFixed(2)} km)
            </span>
            {isDescentMean(mean) && (
              <span className="ml-1 text-[10px] font-bold text-blue-600">
                descente
              </span>
            )}
          </p>
          <p className="mt-0.5 text-[10px] tabular-nums text-slate-600">
            moy{" "}
            <span className="font-bold text-slate-900">{mean.toFixed(1)} %</span>{" "}
            · min {seg.min_pct.toFixed(1)} · max {seg.max_pct.toFixed(1)} · σ{" "}
            {seg.std_pct.toFixed(1)} · Δz {dz >= 0 ? "+" : ""}
            {dz.toFixed(1)} m · L = {L} m
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 text-[10px] font-semibold text-slate-500 hover:text-slate-800"
        >
          Fermer
        </button>
      </div>
      {seg.traps?.length ? (
        <div className="mt-2 max-h-48 overflow-y-auto">
          <table className="w-full text-left text-[10px] tabular-nums text-slate-600">
            <thead className="sticky top-0 bg-slate-50 text-slate-400">
              <tr>
                <th className="py-0.5 pr-2 font-medium">s₀–s₁ (m)</th>
                <th className="py-0.5 pr-2 font-medium">Δz</th>
                <th className="py-0.5 font-medium">pente %</th>
              </tr>
            </thead>
            <tbody>
              {seg.traps.map((t, i) => {
                const dzt = t.z1_m - t.z0_m;
                return (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="py-0.5 pr-2">
                      {Math.round(t.s0_m)}–{Math.round(t.s1_m)}
                    </td>
                    <td className="py-0.5 pr-2">
                      {dzt >= 0 ? "+" : ""}
                      {dzt.toFixed(1)}
                    </td>
                    <td className="py-0.5 font-semibold text-slate-800">
                      {t.slope_pct.toFixed(1)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-1 text-[10px] text-slate-400">
          Aucun trapèze listé pour ce km.
        </p>
      )}
    </div>
  );
}
