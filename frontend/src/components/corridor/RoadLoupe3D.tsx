"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SpatialCorridor } from "@/lib/types";
import {
  gradeBandColor,
  isDescentMean,
} from "@/components/corridor/ElevationProfileChart";
import {
  buildLoupeModel,
  LOUPE_WINDOW_M,
  LOUPE_WINDOW_OPTIONS_M,
  type EnuPoint,
  type LoupeModel,
  type LoupeWindowM,
} from "@/lib/roadLoupe";

const OPEN_KEY = "cyclegen.loupe.open";
const WINDOW_KEY = "cyclegen.loupe.windowM";

type RoadLoupe3DProps = {
  corridor: SpatialCorridor;
  s_m: number;
  className?: string;
  /** Narrow map rail — stack canvases, smaller footprint. */
  compact?: boolean;
  /** Controlled open (map menu can reopen). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

const W3 = 320;
const H3 = 150;
const WS = 320;
const HS = 120;
/** Reference vertical-curve radius drawn on the side view (m). */
const R5_M = 5;

function readOpen(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const v = localStorage.getItem(OPEN_KEY);
    if (v === "0") return false;
    if (v === "1") return true;
  } catch {
    /* ignore */
  }
  return true;
}

function readWindowM(): LoupeWindowM {
  if (typeof window === "undefined") return LOUPE_WINDOW_M as LoupeWindowM;
  try {
    const n = Number(localStorage.getItem(WINDOW_KEY));
    if ((LOUPE_WINDOW_OPTIONS_M as readonly number[]).includes(n)) {
      return n as LoupeWindowM;
    }
  } catch {
    /* ignore */
  }
  return 50;
}

/** Perspective project ENU → canvas (camera behind ego, looking forward). */
function project(
  p: EnuPoint,
  cam: { x: number; y: number; z: number },
  focal: number,
  cx: number,
  cy: number
): { u: number; v: number; depth: number } | null {
  const dx = p.x - cam.x;
  const dy = p.y - cam.y;
  const dz = p.z - cam.z;
  if (dx < 0.8) return null;
  const u = cx + (focal * dy) / dx;
  const v = cy - (focal * dz) / dx;
  return { u, v, depth: dx };
}

function drawPerspective(
  ctx: CanvasRenderingContext2D,
  model: LoupeModel,
  s_m: number
) {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W3, H3);

  const sky = ctx.createLinearGradient(0, 0, 0, H3);
  sky.addColorStop(0, "#dbeafe");
  sky.addColorStop(0.55, "#f1f5f9");
  sky.addColorStop(1, "#e2e8f0");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W3, H3);

  const cam = { x: -18, y: 0, z: 4.5 };
  const focal = 140;
  const cx = W3 * 0.5;
  const cy = H3 * 0.58;

  ctx.strokeStyle = "rgba(100,116,139,0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, cy);
  ctx.lineTo(W3, cy);
  ctx.stroke();

  const sorted = [...model.ribbon].sort((a, b) => {
    const ax = 0.5 * (a.corners[0].x + a.corners[2].x);
    const bx = 0.5 * (b.corners[0].x + b.corners[2].x);
    return bx - ax;
  });

  for (const q of sorted) {
    const pts = q.corners
      .map((c) => project(c, cam, focal, cx, cy))
      .filter(Boolean) as { u: number; v: number; depth: number }[];
    if (pts.length < 4) continue;
    ctx.beginPath();
    ctx.moveTo(pts[0].u, pts[0].v);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].u, pts[i].v);
    ctx.closePath();
    ctx.fillStyle = gradeBandColor(q.grade_pct);
    ctx.globalAlpha = isDescentMean(q.grade_pct) ? 0.88 : 0.92;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(51,65,85,0.35)";
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }

  ctx.beginPath();
  let started = false;
  for (const p of model.enu) {
    const pr = project(p, cam, focal, cx, cy);
    if (!pr) continue;
    if (!started) {
      ctx.moveTo(pr.u, pr.v);
      started = true;
    } else ctx.lineTo(pr.u, pr.v);
  }
  if (started) {
    ctx.strokeStyle = "rgba(15,23,42,0.55)";
    ctx.lineWidth = 1.4;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const egoEnu = model.enu.reduce((best, p) =>
    Math.abs(p.s_m - s_m) < Math.abs(best.s_m - s_m) ? p : best
  );
  const ego = project(
    { ...egoEnu, x: Math.max(egoEnu.x, 1.2), y: 0, z: egoEnu.z + 0.4 },
    cam,
    focal,
    cx,
    cy
  );
  if (ego) {
    ctx.fillStyle = "#0f172a";
    ctx.beginPath();
    ctx.arc(ego.u, ego.v, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#38bdf8";
    ctx.beginPath();
    ctx.arc(ego.u, ego.v, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  if (model.next_turn) {
    const turnPt =
      model.enu.find((p) => p.s_m >= model.next_turn!.s_m - 0.5) ??
      model.enu[model.enu.length - 1];
    const tp = project(turnPt, cam, focal, cx, cy);
    if (tp) {
      ctx.fillStyle = "#f59e0b";
      ctx.beginPath();
      ctx.arc(tp.u, tp.v, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = "bold 8px system-ui,sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(model.next_turn.side, tp.u, tp.v);
    }
  }

  ctx.fillStyle = "rgba(15,23,42,0.55)";
  ctx.font = "9px system-ui,sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("Vue 3D (devant)", 6, 12);
}

/**
 * Side elevation: abscissa = s (forward), ordinate = z.
 * Draws grade-colored profile + R5 reference circle at ego.
 */
function drawSideView(
  ctx: CanvasRenderingContext2D,
  model: LoupeModel,
  s_m: number
) {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, WS, HS);

  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, WS, HS);

  const padL = 28;
  const padR = 10;
  const padT = 14;
  const padB = 18;
  const plotW = WS - padL - padR;
  const plotH = HS - padT - padB;

  const samples = model.samples;
  if (samples.length < 2) return;

  const s0 = samples[0].s_m;
  const s1 = samples[samples.length - 1].s_m;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const p of samples) {
    zMin = Math.min(zMin, p.z_m);
    zMax = Math.max(zMax, p.z_m);
  }
  // Ensure R5 circle fits in vertical scale
  const zSpan = Math.max(zMax - zMin, R5_M * 2.2, 4);
  const zMid = 0.5 * (zMin + zMax);
  zMin = zMid - zSpan / 2;
  zMax = zMid + zSpan / 2;

  const xOf = (s: number) => padL + ((s - s0) / Math.max(s1 - s0, 1e-6)) * plotW;
  const yOf = (z: number) => padT + ((zMax - z) / Math.max(zMax - zMin, 1e-6)) * plotH;

  // Grid
  ctx.strokeStyle = "#e2e8f0";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
  }

  // Fill under profile with grade segments
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    const x0 = xOf(a.s_m);
    const x1 = xOf(b.s_m);
    const y0 = yOf(a.z_m);
    const y1 = yOf(b.z_m);
    const yBase = padT + plotH;
    ctx.beginPath();
    ctx.moveTo(x0, yBase);
    ctx.lineTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.lineTo(x1, yBase);
    ctx.closePath();
    ctx.fillStyle = gradeBandColor(0.5 * (a.grade_pct + b.grade_pct));
    ctx.globalAlpha = 0.35;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Profile polyline
  ctx.beginPath();
  samples.forEach((p, i) => {
    const x = xOf(p.s_m);
    const y = yOf(p.z_m);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#0f172a";
  ctx.lineWidth = 1.8;
  ctx.stroke();

  // Ego
  const ego = samples.reduce((best, p) =>
    Math.abs(p.s_m - s_m) < Math.abs(best.s_m - s_m) ? p : best
  );
  const ex = xOf(ego.s_m);
  const ey = yOf(ego.z_m);
  ctx.fillStyle = "#0f172a";
  ctx.beginPath();
  ctx.arc(ex, ey, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#38bdf8";
  ctx.beginPath();
  ctx.arc(ex, ey, 2, 0, Math.PI * 2);
  ctx.fill();

  // Vertical cursor
  ctx.strokeStyle = "rgba(56,189,248,0.5)";
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 2]);
  ctx.beginPath();
  ctx.moveTo(ex, padT);
  ctx.lineTo(ex, padT + plotH);
  ctx.stroke();
  ctx.setLineDash([]);

  // —— R5 reference circle (vertical curve radius = 5 m) ——
  // Scale: use same m/px on s and z for a true circle in plot space
  const mPerPxS = (s1 - s0) / plotW;
  const mPerPxZ = (zMax - zMin) / plotH;
  const pxPerM = 1 / Math.max(mPerPxS, mPerPxZ, 1e-6);
  const rPx = R5_M * pxPerM;

  // Local grade angle for tangent
  const iEgo = Math.max(
    0,
    samples.findIndex((p) => p.s_m >= ego.s_m)
  );
  const gradeRad = ego.alpha_rad;
  // Center of circle is normal to tangent, on the concave side of the vertical curve
  // Use neighbors to pick concave side
  let concaveUp = true;
  if (iEgo > 0 && iEgo < samples.length - 1) {
    const zPrev = samples[iEgo - 1].z_m;
    const zNext = samples[Math.min(iEgo + 1, samples.length - 1)].z_m;
    const mid = 0.5 * (zPrev + zNext);
    concaveUp = ego.z_m <= mid; // sag → center below
  }
  const nx = -Math.sin(gradeRad);
  const nz = Math.cos(gradeRad);
  const sign = concaveUp ? -1 : 1;
  const cxM = ego.s_m + sign * nx * R5_M;
  const czM = ego.z_m + sign * nz * R5_M;
  // Map center with isotropic scale around ego for circle appearance
  const cScreenX = ex + (cxM - ego.s_m) * pxPerM;
  const cScreenY = ey - (czM - ego.z_m) * pxPerM;

  ctx.strokeStyle = "#dc2626";
  ctx.lineWidth = 1.4;
  ctx.setLineDash([3, 2]);
  ctx.beginPath();
  ctx.arc(cScreenX, cScreenY, rPx, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // Radius tick + label R5
  ctx.strokeStyle = "#dc2626";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cScreenX, cScreenY);
  ctx.lineTo(ex, ey);
  ctx.stroke();
  ctx.fillStyle = "#dc2626";
  ctx.font = "bold 10px system-ui,sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  const labelX = (cScreenX + ex) / 2 + 4;
  const labelY = (cScreenY + ey) / 2 - 2;
  ctx.fillText("R5", labelX, labelY);

  // Axes labels
  ctx.fillStyle = "#64748b";
  ctx.font = "9px system-ui,sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("Vue latérale (pente)", 6, 11);
  ctx.textAlign = "right";
  ctx.fillText(`${zMax.toFixed(0)} m`, padL - 3, padT + 8);
  ctx.fillText(`${zMin.toFixed(0)} m`, padL - 3, padT + plotH);
  ctx.textAlign = "center";
  ctx.fillText(`s −${((s_m - s0) | 0)}…+${((s1 - s_m) | 0)} m`, padL + plotW / 2, HS - 4);
}

export default function RoadLoupe3D({
  corridor,
  s_m,
  className = "",
  compact = false,
  open: openProp,
  onOpenChange,
}: RoadLoupe3DProps) {
  const canvas3Ref = useRef<HTMLCanvasElement | null>(null);
  const canvasSideRef = useRef<HTMLCanvasElement | null>(null);
  const [openInternal, setOpenInternal] = useState(true);
  const [windowM, setWindowM] = useState<LoupeWindowM>(50);
  const [hydrated, setHydrated] = useState(false);

  const controlled = openProp !== undefined;
  const open = controlled ? !!openProp : openInternal;
  const setOpen = (next: boolean) => {
    if (!controlled) setOpenInternal(next);
    onOpenChange?.(next);
  };

  useEffect(() => {
    const stored = readOpen();
    setOpenInternal(stored);
    if (!controlled) onOpenChange?.(stored);
    setWindowM(readWindowM());
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydrate once
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [open, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(WINDOW_KEY, String(windowM));
    } catch {
      /* ignore */
    }
  }, [windowM, hydrated]);

  const hasElev = useMemo(() => {
    const elev = corridor.elevations_m;
    const n = Math.min(
      corridor.S.length,
      corridor.geometry.length,
      elev?.length ?? 0,
      corridor.alpha?.length ?? 0
    );
    return n >= 2;
  }, [corridor]);

  const model = useMemo(() => {
    if (!hasElev || !open) return null;
    return buildLoupeModel(corridor, s_m, windowM);
  }, [corridor, s_m, windowM, hasElev, open]);

  useEffect(() => {
    if (!model || !open) return;
    const dpr = window.devicePixelRatio || 1;
    const c3 = canvas3Ref.current;
    if (c3) {
      c3.width = Math.round(W3 * dpr);
      c3.height = Math.round(H3 * dpr);
      const ctx = c3.getContext("2d");
      if (ctx) drawPerspective(ctx, model, s_m);
    }
    const cs = canvasSideRef.current;
    if (cs) {
      cs.width = Math.round(WS * dpr);
      cs.height = Math.round(HS * dpr);
      const ctx = cs.getContext("2d");
      if (ctx) drawSideView(ctx, model, s_m);
    }
  }, [model, s_m, open]);

  if (!hasElev) {
    return (
      <div
        className={`rounded-md border border-dashed border-slate-200 bg-slate-50 px-2 py-2 text-center text-[10px] text-slate-500 ${className}`}
      >
        Loupe 3D indisponible — pas d’altitude corridor
      </div>
    );
  }

  if (!open) {
    return (
      <div
        className={`flex items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-2 py-1.5 ${className}`}
      >
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Loupe route · vue 3D + pente · fermée
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-semibold text-slate-700 hover:bg-white"
        >
          Ouvrir
        </button>
      </div>
    );
  }

  if (!model) {
    return (
      <div
        className={`rounded-md border border-slate-200 bg-slate-50 px-2 py-3 text-center text-[10px] text-slate-500 ${className}`}
      >
        Fenêtre trop courte pour la loupe
      </div>
    );
  }

  const turn = model.next_turn;
  const R = model.R_m;
  const cssH3 = compact ? 110 : H3;
  const cssHS = compact ? 90 : HS;

  return (
    <div
      className={`overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm ${className}`}
      data-testid="road-loupe-3d"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-2 py-1">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-600">
          Loupe route · s = {(s_m / 1000).toFixed(2)} km
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <div
            role="group"
            aria-label="Fenêtre loupe"
            className="flex rounded border border-slate-200 bg-slate-50 p-0.5"
          >
            {LOUPE_WINDOW_OPTIONS_M.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setWindowM(w)}
                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
                  windowM === w
                    ? "bg-white text-brand shadow-sm ring-1 ring-slate-200"
                    : "text-slate-600 hover:text-slate-900"
                }`}
                title={`Fenêtre ±${w} m`}
              >
                ±{w}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-50"
          >
            Fermer
          </button>
        </div>
      </div>

      <div
        className={`grid gap-1 p-1 ${compact ? "grid-cols-1" : "sm:grid-cols-2"}`}
      >
        <div className="min-w-0">
          <p className="mb-0.5 px-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-400">
            Vue 3D
          </p>
          <canvas
            ref={canvas3Ref}
            style={{ width: W3, height: cssH3, maxWidth: "100%" }}
            className="block w-full rounded border border-slate-100 bg-slate-50"
            role="img"
            aria-label={`Vue 3D locale ±${windowM} m`}
          />
        </div>
        <div className="min-w-0">
          <p className="mb-0.5 px-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-400">
            Vue pente
          </p>
          <canvas
            ref={canvasSideRef}
            style={{ width: WS, height: cssHS, maxWidth: "100%" }}
            className="block w-full rounded border border-slate-100 bg-slate-50"
            role="img"
            aria-label={`Vue latérale pente ±${windowM} m avec repère R5`}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 border-t border-slate-100 px-2 py-1.5 text-[10px] tabular-nums text-slate-600 sm:grid-cols-5">
        <span>
          pente{" "}
          <strong className="text-slate-900">
            {model.mean_grade_pct.toFixed(1)} %
          </strong>
          {isDescentMean(model.mean_grade_pct) ? " ↓" : ""}
        </span>
        <span>
          Δz{" "}
          <strong className="text-slate-900">
            {model.dz_m >= 0 ? "+" : ""}
            {model.dz_m.toFixed(1)} m
          </strong>
        </span>
        <span>
          virage{" "}
          <strong className="text-slate-900">
            {turn ? `${turn.side} · ${Math.round(turn.distance_m)} m` : "—"}
          </strong>
        </span>
        <span>
          R{" "}
          <strong className="text-slate-900">
            {R != null ? `${Math.round(R)} m` : "∞"}
          </strong>
        </span>
        <span>
          ref.{" "}
          <strong className="text-red-600">R5</strong>
          <span className="text-slate-400"> (= 5 m)</span>
        </span>
      </div>
    </div>
  );
}
