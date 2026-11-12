"use client";

/**
 * Aperçu source vs preview — zoom souris fiable via overlay pixel→data.
 *  - Glisser : XY (diagonale) · X (horizontal) · Y (vertical)
 *  - Molette : XY · Shift=X · Alt=Y
 *  - Double-clic : reset
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DriverPhysics } from "@/lib/driverPresets";
import {
  downsamplePreview,
  physicsRevision,
  previewDriverOnSource,
  previewStats,
} from "@/lib/driverProfilePreview";

type Props = {
  time: number[];
  velocity_mps: number[];
  physics: DriverPhysics;
  sourceLabel?: string;
  tall?: boolean;
};

type Dom = [number, number];

type Row = {
  t: number;
  v_src: number;
  v_prev: number;
  a_src: number;
  a_prev: number;
};

/** Plot margins must match LineChart margin + axis widths. */
const MARGIN = { top: 28, right: 16, bottom: 36, left: 44 };

function span(d: Dom): number {
  return Math.max(d[1] - d[0], 1e-9);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function padY(full: Dom, frac = 0.08): Dom {
  const s = span(full);
  const p = s * frac || 0.5;
  return [full[0] - p, full[1] + p];
}

function zoomAxis(
  current: Dom,
  full: Dom,
  factor: number,
  pivot: number,
  minFrac = 0.004
): Dom {
  const left = pivot - (pivot - current[0]) * factor;
  const right = pivot + (current[1] - pivot) * factor;
  let lo = Math.max(full[0], Math.min(left, right));
  let hi = Math.min(full[1], Math.max(left, right));
  const minSpan = span(full) * minFrac;
  if (hi - lo < minSpan) {
    const mid = (lo + hi) / 2;
    lo = Math.max(full[0], mid - minSpan / 2);
    hi = Math.min(full[1], mid + minSpan / 2);
    if (hi - lo < minSpan) {
      if (lo <= full[0]) {
        lo = full[0];
        hi = Math.min(full[1], lo + minSpan);
      } else {
        hi = full[1];
        lo = Math.max(full[0], hi - minSpan);
      }
    }
  }
  return [lo, hi];
}

function clientToData(
  el: HTMLElement,
  clientX: number,
  clientY: number,
  xDom: Dom,
  yDom: Dom
): { x: number; y: number; px: number; py: number } {
  const rect = el.getBoundingClientRect();
  const plotW = Math.max(rect.width - MARGIN.left - MARGIN.right, 1);
  const plotH = Math.max(rect.height - MARGIN.top - MARGIN.bottom, 1);
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const fx = clamp01((px - MARGIN.left) / plotW);
  const fy = clamp01((py - MARGIN.top) / plotH);
  return {
    x: xDom[0] + fx * (xDom[1] - xDom[0]),
    y: yDom[1] - fy * (yDom[1] - yDom[0]),
    px,
    py,
  };
}

export default function DriverIdentifyPreview({
  time,
  velocity_mps,
  physics,
  sourceLabel = "Source",
  tall = false,
}: Props) {
  const [mode, setMode] = useState<"v" | "a">("v");
  const [xDomain, setXDomain] = useState<Dom | null>(null);
  const [yDomain, setYDomain] = useState<Dom | null>(null);
  const [hover, setHover] = useState<{ t: number; y: number } | null>(null);
  const [rubber, setRubber] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);

  const plotRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    active: boolean;
    x0: number;
    y0: number;
    px0: number;
    py0: number;
    shift: boolean;
    alt: boolean;
  } | null>(null);
  const hoverRef = useRef<{ t: number; y: number } | null>(null);
  const domainsRef = useRef<{ x: Dom | null; y: Dom | null }>({
    x: null,
    y: null,
  });
  const fullRef = useRef<{ x: Dom; y: Dom }>({ x: [0, 1], y: [0, 1] });

  const physicsKey = useMemo(() => physicsRevision(physics), [physics]);

  const { chartData, stats } = useMemo(() => {
    const raw = previewDriverOnSource(time, velocity_mps, physics);
    const s = downsamplePreview(raw, 900);
    const t0 = s.time[0] ?? 0;
    const rows: Row[] = s.time.map((t, i) => ({
      t: Math.round((t - t0) * 10) / 10,
      v_src: Math.round(s.v_src_mps[i] * 3.6 * 10) / 10,
      v_prev: Math.round(s.v_prev_mps[i] * 3.6 * 10) / 10,
      a_src: Math.round(s.a_src[i] * 100) / 100,
      a_prev: Math.round(s.a_prev[i] * 100) / 100,
    }));
    return { chartData: rows, stats: previewStats(raw) };
  }, [time, velocity_mps, physics]);

  const seriesKey = `${time.length}:${time[0] ?? 0}:${time[time.length - 1] ?? 0}`;

  const fullX: Dom = useMemo(() => {
    if (chartData.length < 2) return [0, 1];
    return [chartData[0].t, chartData[chartData.length - 1].t];
  }, [chartData]);

  const fullY: Dom = useMemo(() => {
    if (!chartData.length) return [0, 1];
    let lo = Infinity;
    let hi = -Infinity;
    for (const row of chartData) {
      if (mode === "v") {
        lo = Math.min(lo, row.v_src, row.v_prev);
        hi = Math.max(hi, row.v_src, row.v_prev);
      } else {
        lo = Math.min(lo, row.a_src, row.a_prev);
        hi = Math.max(hi, row.a_src, row.a_prev);
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
    if (lo === hi) return [lo - 1, hi + 1];
    return padY([lo, hi]);
  }, [chartData, mode]);

  useEffect(() => {
    setXDomain(null);
    setYDomain(null);
    setRubber(null);
    dragRef.current = null;
  }, [mode, seriesKey]);

  useEffect(() => {
    hoverRef.current = hover;
  }, [hover]);
  useEffect(() => {
    domainsRef.current = { x: xDomain, y: yDomain };
  }, [xDomain, yDomain]);
  useEffect(() => {
    fullRef.current = { x: fullX, y: fullY };
  }, [fullX, fullY]);

  const xDom = xDomain ?? fullX;
  const yDom = yDomain ?? fullY;

  const resetZoom = useCallback(() => {
    setXDomain(null);
    setYDomain(null);
    setRubber(null);
    dragRef.current = null;
  }, []);

  const applyBoxZoom = useCallback(
    (
      x0: number,
      y0: number,
      x1: number,
      y1: number,
      px0: number,
      py0: number,
      px1: number,
      py1: number,
      shift: boolean,
      alt: boolean
    ) => {
      const fullX0 = fullRef.current.x;
      const fullY0 = fullRef.current.y;
      const dpx = Math.abs(px1 - px0);
      const dpy = Math.abs(py1 - py0);
      if (dpx < 6 && dpy < 6) return;

      // Axis from modifiers, else from drag aspect ratio
      let zoomX = true;
      let zoomY = true;
      if (shift && !alt) {
        zoomX = true;
        zoomY = false;
      } else if (alt && !shift) {
        zoomX = false;
        zoomY = true;
      } else if (!shift && !alt) {
        if (dpx > dpy * 2.2) {
          zoomX = true;
          zoomY = false;
        } else if (dpy > dpx * 2.2) {
          zoomX = false;
          zoomY = true;
        }
      }

      if (zoomX) {
        const lo = Math.max(fullX0[0], Math.min(x0, x1));
        const hi = Math.min(fullX0[1], Math.max(x0, x1));
        if (hi - lo > span(fullX0) * 0.004) setXDomain([lo, hi]);
      }
      if (zoomY) {
        const lo = Math.max(fullY0[0], Math.min(y0, y1));
        const hi = Math.min(fullY0[1], Math.max(y0, y1));
        if (hi - lo > span(fullY0) * 0.004) setYDomain([lo, hi]);
      }
    },
    []
  );

  // Overlay listeners (capture) — independent of Recharts
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const fullX0 = fullRef.current.x;
      const fullY0 = fullRef.current.y;
      const curX = domainsRef.current.x ?? fullX0;
      const curY = domainsRef.current.y ?? fullY0;
      const factor = e.deltaY > 0 ? 1.22 : 0.82;
      const pt = clientToData(el, e.clientX, e.clientY, curX, curY);
      const pivotX = pt.x;
      const pivotY = pt.y;
      const zoomX = e.shiftKey || (!e.shiftKey && !e.altKey);
      const zoomY = e.altKey || (!e.shiftKey && !e.altKey);
      if (zoomX) setXDomain(zoomAxis(curX, fullX0, factor, pivotX));
      if (zoomY) setYDomain(zoomAxis(curY, fullY0, factor, pivotY));
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const curX = domainsRef.current.x ?? fullRef.current.x;
      const curY = domainsRef.current.y ?? fullRef.current.y;
      const pt = clientToData(el, e.clientX, e.clientY, curX, curY);
      dragRef.current = {
        active: true,
        x0: pt.x,
        y0: pt.y,
        px0: pt.px,
        py0: pt.py,
        shift: e.shiftKey,
        alt: e.altKey,
      };
      setRubber({ x0: pt.px, y0: pt.py, x1: pt.px, y1: pt.py });
    };

    const onMove = (e: MouseEvent) => {
      const curX = domainsRef.current.x ?? fullRef.current.x;
      const curY = domainsRef.current.y ?? fullRef.current.y;
      const pt = clientToData(el, e.clientX, e.clientY, curX, curY);
      setHover({ t: pt.x, y: pt.y });
      const d = dragRef.current;
      if (!d?.active) return;
      setRubber({ x0: d.px0, y0: d.py0, x1: pt.px, y1: pt.py });
    };

    const onUp = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d?.active) return;
      const curX = domainsRef.current.x ?? fullRef.current.x;
      const curY = domainsRef.current.y ?? fullRef.current.y;
      const pt = clientToData(el, e.clientX, e.clientY, curX, curY);
      applyBoxZoom(
        d.x0,
        d.y0,
        pt.x,
        pt.y,
        d.px0,
        d.py0,
        pt.px,
        pt.py,
        d.shift || e.shiftKey,
        d.alt || e.altKey
      );
      dragRef.current = null;
      setRubber(null);
    };

    const onDbl = (e: MouseEvent) => {
      e.preventDefault();
      resetZoom();
    };

    const onLeave = () => {
      setHover(null);
      if (dragRef.current?.active) {
        dragRef.current = null;
        setRubber(null);
      }
    };

    el.addEventListener("wheel", onWheel, { passive: false, capture: true });
    el.addEventListener("mousedown", onDown);
    el.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    el.addEventListener("dblclick", onDbl);
    el.addEventListener("mouseleave", onLeave);
    return () => {
      el.removeEventListener("wheel", onWheel, true);
      el.removeEventListener("mousedown", onDown);
      el.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      el.removeEventListener("dblclick", onDbl);
      el.removeEventListener("mouseleave", onLeave);
    };
  }, [applyBoxZoom, resetZoom]);

  const hoverRow =
    hover == null || !chartData.length
      ? null
      : chartData.reduce(
          (best, row) =>
            Math.abs(row.t - hover.t) < Math.abs(best.t - hover.t)
              ? row
              : best,
          chartData[0]
        );

  const zoomed = xDomain != null || yDomain != null;

  if (chartData.length < 3) {
    return (
      <p className="rounded border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-[11px] text-slate-500">
        Profil source indisponible — ré-identifiez la trace pour activer
        l’aperçu réactif.
      </p>
    );
  }

  const rubberStyle =
    rubber == null
      ? null
      : {
          left: Math.min(rubber.x0, rubber.x1),
          top: Math.min(rubber.y0, rubber.y1),
          width: Math.abs(rubber.x1 - rubber.x0),
          height: Math.abs(rubber.y1 - rubber.y0),
        };

  return (
    <div
      data-testid="driver-identify-preview"
      className={`flex flex-col space-y-2 rounded-lg border border-slate-200 bg-white p-3 ${
        tall ? "h-full min-h-[22rem]" : ""
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Aperçu réactif
          </h3>
          <p className="text-[10px] text-slate-400">
            Glisser = zoom (↔ X · ↕ Y · ↘ XY) · molette XY (Shift/Alt) ·
            double-clic = reset
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            data-testid="driver-preview-stats"
            className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[9px] tabular-nums text-slate-600"
          >
            RMSE Δv {stats.rmse_kmh.toFixed(2)} km/h · max{" "}
            {stats.max_abs_kmh.toFixed(1)} · bias {stats.bias_kmh.toFixed(2)}
          </span>
          {zoomed ? (
            <span
              data-testid="driver-zoom-badge"
              className="rounded bg-teal-50 px-1.5 py-0.5 font-mono text-[9px] tabular-nums text-teal-800"
            >
              zoom {xDom[0].toFixed(0)}–{xDom[1].toFixed(0)}s
              {yDomain
                ? ` · ${yDom[0].toFixed(1)}–${yDom[1].toFixed(1)}`
                : ""}
            </span>
          ) : null}
          <div className="flex gap-1">
            {(
              [
                ["v", "Vitesse"],
                ["a", "Accélération"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setMode(k)}
                className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                  mode === k
                    ? "bg-slate-900 text-white"
                    : "border border-slate-200 bg-white text-slate-600"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {hoverRow ? (
        <div className="flex flex-wrap gap-3 font-mono text-[10px] tabular-nums text-slate-600">
          <span>t={hoverRow.t.toFixed(1)} s</span>
          {mode === "v" ? (
            <>
              <span className="text-slate-400">
                {sourceLabel} {hoverRow.v_src} km/h
              </span>
              <span className="font-semibold text-teal-800">
                preview {hoverRow.v_prev} km/h
              </span>
              <span className="text-slate-400">
                Δ {(hoverRow.v_prev - hoverRow.v_src).toFixed(1)}
              </span>
            </>
          ) : (
            <>
              <span className="text-slate-400">a_src {hoverRow.a_src}</span>
              <span className="font-semibold text-teal-800">
                a_prev {hoverRow.a_prev}
              </span>
            </>
          )}
        </div>
      ) : null}

      <div
        ref={plotRef}
        data-testid="driver-zoom-plot"
        className={`relative w-full min-w-0 touch-none ${
          tall ? "min-h-[18rem] flex-1" : "h-56"
        }`}
        style={{ cursor: rubber ? "crosshair" : "crosshair" }}
      >
        {/* Chart: no pointer events — overlay owns the mouse */}
        <div className="pointer-events-none absolute inset-0">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              key={`phys-${physicsKey}-z-${xDom[0].toFixed(4)}-${xDom[1].toFixed(4)}-${yDom[0].toFixed(4)}-${yDom[1].toFixed(4)}-${mode}`}
              data={chartData}
              margin={MARGIN}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis
                dataKey="t"
                type="number"
                domain={[xDom[0], xDom[1]]}
                allowDataOverflow
                tick={{ fontSize: 10, fill: "#94a3b8" }}
                tickFormatter={(v) => `${Number(v).toFixed(0)}s`}
              />
              <YAxis
                domain={[yDom[0], yDom[1]]}
                allowDataOverflow
                tick={{ fontSize: 10, fill: "#94a3b8" }}
                width={36}
                label={{
                  value: mode === "v" ? "km/h" : "m/s²",
                  angle: -90,
                  position: "insideLeft",
                  style: { fontSize: 9, fill: "#94a3b8" },
                }}
              />
              <Tooltip content={() => null} />
              <Legend wrapperStyle={{ fontSize: 11, pointerEvents: "none" }} />
              {hover ? (
                <ReferenceLine
                  x={hover.t}
                  stroke="#94a3b8"
                  strokeDasharray="4 4"
                />
              ) : null}
              {mode === "v" ? (
                <>
                  <Line
                    type="monotone"
                    dataKey="v_src"
                    name={sourceLabel}
                    stroke="#94a3b8"
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="v_prev"
                    name="Preview (params)"
                    stroke="#0f766e"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                </>
              ) : (
                <>
                  <Line
                    type="monotone"
                    dataKey="a_src"
                    name="a source"
                    stroke="#94a3b8"
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="a_prev"
                    name="a preview"
                    stroke="#c2410c"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                </>
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Transparent hit layer + rubber-band */}
        <div className="absolute inset-0 z-10" aria-hidden>
          {rubberStyle && rubberStyle.width + rubberStyle.height > 2 ? (
            <div
              className="pointer-events-none absolute border border-teal-700 bg-teal-600/15"
              style={{
                left: rubberStyle.left,
                top: rubberStyle.top,
                width: rubberStyle.width,
                height: rubberStyle.height,
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
