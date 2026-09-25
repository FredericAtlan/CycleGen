"use client";

/**
 * Unified results analysis desk: focus chart + context strip + time bar.
 * Absorbs ChartInspectDrawer capabilities (rolling, cursors, stats, JPEG).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { toJpeg } from "html-to-image";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  INSPECT_SERIES,
  findKeyMoments,
  inspectSeriesMeta,
  isZeroInflatedSeries,
  nearestRow,
  seriesShort,
  sliceStats,
  withRollingOverlay,
  type InspectRow,
  type InspectSeriesId,
  type RollingMode,
} from "@/lib/chartInspectData";
import {
  metaLinesForCsv,
  type InspectRunMeta,
} from "@/lib/inspectRunMeta";
import { formatTimeLabel, formatTimeTick } from "@/lib/chartTime";
import { sampleLimitsAlongProfile } from "@/lib/cycleMetrics";
import type { ConsolidatedProfile, SpatialCorridor } from "@/lib/types";
import type { SlopeUnit } from "@/lib/units";
import SlopeUnitToggle from "@/components/SlopeUnitToggle";
import TrafficLightsEditor from "@/components/corridor/TrafficLightsEditor";
import ElevationProfileChart, {
  type ElevationProfileMeta,
} from "@/components/corridor/ElevationProfileChart";
import MicroInspectPanel from "@/components/corridor/MicroInspectPanel";
import ProfileTable from "@/components/export/ProfileTable";
import WarningsPanel from "@/components/WarningsPanel";
import { withUpdatedFeux } from "@/lib/corridorEdit";
import type { CycleGenWarning } from "@/lib/types";

type VertCursor = {
  id: string;
  t: number;
  color: string;
  label: string;
};

type ChartPoint = InspectRow & {
  rolling?: number;
  rolling2?: number;
  y2?: number;
  env_kmh?: number;
  legal_kmh?: number;
  traffic_kmh?: number;
  curve_kmh?: number;
};

type SpeedLimitKey = "envelope" | "legal" | "traffic" | "curve";

type SpeedLimitFlags = Record<SpeedLimitKey, boolean>;

const SPEED_LIMIT_OVERLAYS: {
  key: "env_kmh" | "legal_kmh" | "traffic_kmh" | "curve_kmh";
  toggle: SpeedLimitKey;
  name: string;
  stroke: string;
  dash: string;
}[] = [
  {
    key: "env_kmh",
    toggle: "envelope",
    name: "V enveloppe",
    stroke: "#2563eb",
    dash: "4 3",
  },
  {
    key: "legal_kmh",
    toggle: "legal",
    name: "V légal",
    stroke: "#64748b",
    dash: "2 2",
  },
  {
    key: "traffic_kmh",
    toggle: "traffic",
    name: "V trafic",
    stroke: "#ea580c",
    dash: "4 2",
  },
  {
    key: "curve_kmh",
    toggle: "curve",
    name: "V virage",
    stroke: "#7c3aed",
    dash: "3 3",
  },
];

const DEFAULT_SPEED_LIMITS: SpeedLimitFlags = {
  envelope: true,
  legal: true,
  traffic: false,
  curve: false,
};

const ROLL_PRESETS = [5, 10, 30, 60] as const;

function nearestIndex(times: number[], t: number): number {
  if (!times.length) return 0;
  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  return Math.abs(times[hi] - t) < Math.abs(times[lo] - t) ? hi : lo;
}

function Spark({
  data,
  color,
  active,
  onClick,
  label,
  unit,
}: {
  data: { t: number; v: number }[];
  color: string;
  active: boolean;
  onClick: (e: MouseEvent) => void;
  label: string;
  unit: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${label} (${unit}) — clic = focus · Shift+clic = overlay`}
      className={`flex h-[72px] w-[112px] shrink-0 flex-col overflow-hidden rounded-md border text-left transition ${
        active
          ? "border-brand bg-brand/5 ring-1 ring-brand"
          : "border-slate-200 bg-white hover:border-slate-300"
      }`}
    >
      <div className="flex items-center gap-1 px-1.5 pt-1">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: color }}
        />
        <span className="truncate text-[9px] font-semibold text-slate-700">
          {label}
        </span>
      </div>
      <div className="min-h-0 flex-1 px-0.5 pb-0.5">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 2, right: 2, left: 2, bottom: 0 }}>
            <Line
              type="monotone"
              dataKey="v"
              stroke={color}
              strokeWidth={1.2}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </button>
  );
}

type SelectAxis = "x" | "y" | null;

function seriesYExtent(
  data: ChartPoint[],
  key: InspectSeriesId
): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const row of data) {
    const v = row[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (lo === hi) return [lo - 1, hi + 1];
  return [lo, hi];
}

function FocusChart({
  data,
  primary,
  secondary,
  xDomain,
  yDomain,
  cursors,
  placeMode,
  selectAxis,
  onPlace,
  showRolling,
  rollingLabel,
  windowBand,
  hoverT,
  highlightT = null,
  followPlayhead = false,
  onHoverT,
  meanLabel,
  onBrushX,
  onBrushY,
  speedLimits,
  onWheelZoom,
}: {
  data: ChartPoint[];
  primary: InspectSeriesId;
  secondary: InspectSeriesId | null;
  xDomain: [number, number];
  yDomain: [number, number] | null;
  cursors: VertCursor[];
  placeMode: boolean;
  selectAxis: SelectAxis;
  onPlace: (t: number) => void;
  showRolling: boolean;
  rollingLabel: string;
  windowBand: [number, number] | null;
  hoverT: number | null;
  /** Playback playhead time (s); takes precedence over hover when set. */
  highlightT?: number | null;
  /** When true, pan the time window so the playhead stays visible. */
  followPlayhead?: boolean;
  onHoverT: (t: number | null) => void;
  meanLabel?: string;
  onBrushX: (t0: number, t1: number) => void;
  onBrushY: (y0: number, y1: number) => void;
  speedLimits?: SpeedLimitFlags | null;
  onWheelZoom?: (anchorT: number, deltaY: number) => void;
}) {
  const cursorT = highlightT ?? hoverT;
  const playheadOn = Boolean(followPlayhead && highlightT != null);
  const pMeta = inspectSeriesMeta(primary);
  const sMeta = secondary ? inspectSeriesMeta(secondary) : null;
  const dual = Boolean(secondary && secondary !== primary);
  const showSpeedLimits = primary === "v_kmh" && Boolean(speedLimits);
  const [dragX0, setDragX0] = useState<number | null>(null);
  const [dragX1, setDragX1] = useState<number | null>(null);
  const [dragY0, setDragY0] = useState<number | null>(null);
  const [dragY1, setDragY1] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);

  /** Visible Y scale used to invert pointer → value for Zone Y cursors. */
  const yScaleDomain = useMemo((): [number, number] => {
    if (yDomain) return yDomain;
    return seriesYExtent(data, primary);
  }, [yDomain, data, primary]);

  const clientYToValue = useCallback(
    (clientY: number): number | null => {
      const el = plotRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      // Match LineChart margins: top 8, bottom 2
      const top = rect.top + 8;
      const bottom = rect.bottom - 2;
      const h = bottom - top;
      if (h < 8) return null;
      const t = Math.max(0, Math.min(1, (clientY - top) / h));
      const [yMin, yMax] = yScaleDomain;
      return yMax - t * (yMax - yMin);
    },
    [yScaleDomain]
  );

  const clientXToT = useCallback(
    (clientX: number): number | null => {
      const el = plotRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const left = rect.left + 4;
      const right = rect.right - (dual ? 44 : 12);
      const w = right - left;
      if (w < 8) return null;
      const u = Math.max(0, Math.min(1, (clientX - left) / w));
      const [x0, x1] = xDomain;
      return x0 + u * (x1 - x0);
    },
    [xDomain, dual]
  );

  useEffect(() => {
    const el = plotRef.current;
    if (!el || !onWheelZoom) return;
    const onWheel = (e: WheelEvent) => {
      const dy = e.ctrlKey
        ? e.deltaY
        : Math.abs(e.deltaY) >= Math.abs(e.deltaX)
          ? e.deltaY
          : 0;
      if (dy === 0) return;
      e.preventDefault();
      const anchor =
        clientXToT(e.clientX) ??
        hoverT ??
        (xDomain[0] + xDomain[1]) / 2;
      onWheelZoom(anchor, dy);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheelZoom, clientXToT, hoverT, xDomain]);

  const draggingX = selectAxis === "x" && dragX0 != null;
  const draggingY = selectAxis === "y" && dragY0 != null;
  const cursor =
    placeMode
      ? "crosshair"
      : selectAxis === "x"
        ? "col-resize"
        : selectAxis === "y"
          ? "row-resize"
          : "default";

  const finishDragX = () => {
    if (selectAxis === "x" && dragX0 != null && dragX1 != null) {
      const a = Math.min(dragX0, dragX1);
      const b = Math.max(dragX0, dragX1);
      if (b - a > 0.5) onBrushX(a, b);
    }
    setDragX0(null);
    setDragX1(null);
  };

  const finishDragY = () => {
    if (dragY0 != null && dragY1 != null) {
      const a = Math.min(dragY0, dragY1);
      const b = Math.max(dragY0, dragY1);
      const span = yScaleDomain[1] - yScaleDomain[0];
      if (b - a > Math.max(span * 0.01, 1e-6)) onBrushY(a, b);
    }
    setDragY0(null);
    setDragY1(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col rounded-md border border-slate-200 bg-white">
      <div className="flex shrink-0 items-baseline justify-between gap-2 border-b border-slate-100 px-2 py-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: pMeta.color }}
          />
          <span className="text-[11px] font-semibold text-slate-800">
            {pMeta.defaultLabel}
          </span>
          <span className="text-[9px] text-slate-400">{pMeta.unit}</span>
          {dual && sMeta && (
            <>
              <span className="text-slate-300">+</span>
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: sMeta.color }}
              />
              <span className="text-[11px] font-semibold text-slate-800">
                {sMeta.defaultLabel}
              </span>
              <span className="text-[9px] text-slate-400">{sMeta.unit}</span>
            </>
          )}
        </div>
        {meanLabel && (
          <span className="shrink-0 text-[10px] tabular-nums text-slate-600">
            {meanLabel}
          </span>
        )}
      </div>
      <div
        ref={plotRef}
        className="relative min-h-0 flex-1"
        style={{ cursor }}
        onPointerDown={(e) => {
          if (placeMode || selectAxis !== "y") return;
          if (e.button !== 0) return;
          const v = clientYToValue(e.clientY);
          if (v == null) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          setDragY0(v);
          setDragY1(v);
        }}
        onPointerMove={(e) => {
          if (selectAxis !== "y" || dragY0 == null) return;
          const v = clientYToValue(e.clientY);
          if (v != null) setDragY1(v);
        }}
        onPointerUp={() => {
          if (selectAxis === "y" && dragY0 != null) finishDragY();
        }}
        onPointerCancel={() => {
          setDragY0(null);
          setDragY1(null);
        }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{ top: 8, right: dual ? 44 : 12, left: 4, bottom: 2 }}
            onMouseDown={(state) => {
              if (placeMode || selectAxis !== "x") return;
              if (state?.activeLabel != null) {
                const t = Number(state.activeLabel);
                if (Number.isFinite(t)) {
                  setDragX0(t);
                  setDragX1(t);
                }
              }
            }}
            onMouseMove={(state) => {
              const t =
                state?.activeLabel != null ? Number(state.activeLabel) : NaN;
              onHoverT(Number.isFinite(t) ? t : null);
              if (selectAxis === "x" && dragX0 != null && Number.isFinite(t)) {
                setDragX1(t);
              }
            }}
            onMouseUp={() => {
              if (draggingX) finishDragX();
            }}
            onMouseLeave={() => {
              onHoverT(null);
              if (draggingX) finishDragX();
            }}
            onClick={(state) => {
              if (!placeMode || state?.activeLabel == null) return;
              const t = Number(state.activeLabel);
              if (Number.isFinite(t)) onPlace(t);
            }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              dataKey="t"
              type="number"
              domain={xDomain}
              allowDataOverflow
              tick={{ fontSize: 10, fill: "#64748b" }}
              tickFormatter={(v) => formatTimeTick(Number(v))}
            />
            <YAxis
              yAxisId="left"
              width={48}
              domain={yDomain ?? ["auto", "auto"]}
              allowDataOverflow={yDomain != null}
              tick={{ fontSize: 10, fill: "#64748b" }}
              tickFormatter={(v) => Number(v).toFixed(1)}
              stroke={pMeta.color}
            />
            {dual && (
              <YAxis
                yAxisId="right"
                orientation="right"
                width={44}
                tick={{ fontSize: 10, fill: "#64748b" }}
                tickFormatter={(v) => Number(v).toFixed(1)}
                stroke={sMeta!.color}
              />
            )}
            {selectAxis !== "y" && (
              <Tooltip
                contentStyle={{ fontSize: 11, padding: "4px 8px" }}
                labelFormatter={(x) => formatTimeLabel(Number(x))}
                formatter={(v, name) => {
                  const n = String(name);
                  const unit =
                    n === seriesShort(primary) || n === pMeta.defaultLabel
                      ? pMeta.unit
                      : dual &&
                          sMeta &&
                          (n === seriesShort(secondary!) ||
                            n === sMeta.defaultLabel)
                        ? sMeta.unit
                        : pMeta.unit;
                  return [
                    typeof v === "number"
                      ? `${v.toFixed(2)} ${unit}`
                      : String(v ?? ""),
                    n,
                  ];
                }}
              />
            )}
            {windowBand && windowBand[1] > windowBand[0] && (
              <ReferenceArea
                x1={windowBand[0]}
                x2={windowBand[1]}
                yAxisId="left"
                fill="#0ea5e9"
                fillOpacity={0.06}
                strokeOpacity={0}
              />
            )}
            {selectAxis === "x" &&
              dragX0 != null &&
              dragX1 != null &&
              dragX0 !== dragX1 && (
                <ReferenceArea
                  x1={dragX0}
                  x2={dragX1}
                  yAxisId="left"
                  fill="#38bdf8"
                  fillOpacity={0.2}
                  stroke="#0ea5e9"
                  strokeOpacity={0.5}
                />
              )}
            {selectAxis === "y" &&
              dragY0 != null &&
              dragY1 != null &&
              dragY0 !== dragY1 && (
                <ReferenceArea
                  y1={dragY0}
                  y2={dragY1}
                  yAxisId="left"
                  x1={xDomain[0]}
                  x2={xDomain[1]}
                  fill="#a78bfa"
                  fillOpacity={0.18}
                  stroke="#8b5cf6"
                  strokeOpacity={0.5}
                />
              )}
            {selectAxis === "y" && dragY0 != null && (
              <ReferenceLine
                yAxisId="left"
                y={dragY0}
                stroke="#7c3aed"
                strokeWidth={1.5}
                strokeDasharray="5 3"
                label={{
                  value: `Y1 ${dragY0.toFixed(2)}`,
                  position: "insideTopLeft",
                  fill: "#7c3aed",
                  fontSize: 9,
                }}
              />
            )}
            {selectAxis === "y" && dragY1 != null && (
              <ReferenceLine
                yAxisId="left"
                y={dragY1}
                stroke="#7c3aed"
                strokeWidth={1.5}
                strokeDasharray="5 3"
                label={{
                  value: `Y2 ${dragY1.toFixed(2)}`,
                  position: "insideBottomLeft",
                  fill: "#7c3aed",
                  fontSize: 9,
                }}
              />
            )}
            {cursors.map((c) => (
              <ReferenceLine
                key={c.id}
                yAxisId="left"
                x={c.t}
                stroke={c.color}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                label={{
                  value: c.label,
                  position: "top",
                  fill: c.color,
                  fontSize: 9,
                }}
              />
            ))}
            {cursorT != null && !draggingY && (
              <ReferenceLine
                yAxisId="left"
                x={cursorT}
                stroke={playheadOn ? "#4338ca" : highlightT != null ? "#0f172a" : "#94a3b8"}
                strokeWidth={playheadOn ? 2 : highlightT != null ? 1.5 : 1}
                strokeDasharray={playheadOn ? undefined : highlightT != null ? "4 3" : "2 2"}
                ifOverflow="extendDomain"
                label={
                  playheadOn
                    ? {
                        value: formatTimeLabel(cursorT),
                        position: "insideTopLeft",
                        fill: "#4338ca",
                        fontSize: 10,
                        fontWeight: 700,
                      }
                    : undefined
                }
              />
            )}
            {showSpeedLimits &&
              speedLimits &&
              SPEED_LIMIT_OVERLAYS.map((s) => {
                if (!speedLimits[s.toggle]) return null;
                if (!data.some((r) => Number.isFinite(r[s.key]))) return null;
                return (
                  <Line
                    key={s.key}
                    yAxisId="left"
                    type="stepAfter"
                    dataKey={s.key}
                    name={s.name}
                    stroke={s.stroke}
                    strokeWidth={1.25}
                    strokeDasharray={s.dash}
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                );
              })}
            <Line
              yAxisId="left"
              type="monotone"
              dataKey={primary}
              name={seriesShort(primary)}
              stroke={pMeta.color}
              strokeWidth={1.8}
              dot={false}
              isAnimationActive={false}
            />
            {showRolling && (
              <Line
                yAxisId="left"
                type="monotone"
                dataKey="rolling"
                name={rollingLabel}
                stroke={pMeta.color}
                strokeWidth={1.4}
                strokeDasharray="5 4"
                dot={false}
                isAnimationActive={false}
              />
            )}
            {dual && secondary && (
              <Line
                yAxisId="right"
                type="monotone"
                dataKey={secondary}
                name={seriesShort(secondary)}
                stroke={sMeta!.color}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function CompareCell({
  data,
  seriesId,
  xDomain,
  cursors,
  showRolling,
  rollingLabel,
  onHoverT,
  placeMode,
  onPlace,
  selectAxis,
  onBrushX,
  speedLimits,
  onWheelZoom,
  highlightT = null,
  followPlayhead = false,
}: {
  data: ChartPoint[];
  seriesId: InspectSeriesId;
  xDomain: [number, number];
  cursors: VertCursor[];
  showRolling: boolean;
  rollingLabel: string;
  onHoverT: (t: number | null) => void;
  placeMode: boolean;
  onPlace: (t: number) => void;
  selectAxis: SelectAxis;
  onBrushX: (t0: number, t1: number) => void;
  speedLimits?: SpeedLimitFlags | null;
  onWheelZoom?: (anchorT: number, deltaY: number) => void;
  highlightT?: number | null;
  followPlayhead?: boolean;
}) {
  const m = inspectSeriesMeta(seriesId);
  const [dragX0, setDragX0] = useState<number | null>(null);
  const [dragX1, setDragX1] = useState<number | null>(null);
  const showSpeedLimits = seriesId === "v_kmh" && Boolean(speedLimits);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const playheadOn = Boolean(followPlayhead && highlightT != null);
  const cursorT = highlightT;

  const clientXToT = useCallback(
    (clientX: number): number | null => {
      const el = plotRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const left = rect.left + 0;
      const right = rect.right - 8;
      const w = right - left;
      if (w < 8) return null;
      const u = Math.max(0, Math.min(1, (clientX - left) / w));
      const [x0, x1] = xDomain;
      return x0 + u * (x1 - x0);
    },
    [xDomain]
  );

  useEffect(() => {
    const el = plotRef.current;
    if (!el || !onWheelZoom) return;
    const onWheel = (e: WheelEvent) => {
      const dy = e.ctrlKey
        ? e.deltaY
        : Math.abs(e.deltaY) >= Math.abs(e.deltaX)
          ? e.deltaY
          : 0;
      if (dy === 0) return;
      e.preventDefault();
      const anchor = clientXToT(e.clientX) ?? (xDomain[0] + xDomain[1]) / 2;
      onWheelZoom(anchor, dy);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheelZoom, clientXToT, xDomain]);

  const finishDrag = () => {
    if (selectAxis === "x" && dragX0 != null && dragX1 != null) {
      const a = Math.min(dragX0, dragX1);
      const b = Math.max(dragX0, dragX1);
      if (b - a > 0.5) onBrushX(a, b);
    }
    setDragX0(null);
    setDragX1(null);
  };

  return (
    <div className="flex min-h-0 flex-col rounded-md border border-slate-200 bg-white">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-slate-100 px-2 py-0.5">
        <span className="h-2 w-2 rounded-full" style={{ background: m.color }} />
        <span className="truncate text-[10px] font-semibold text-slate-800">
          {m.defaultLabel}
        </span>
        <span className="text-[9px] text-slate-400">{m.unit}</span>
      </div>
      <div ref={plotRef} className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
            onMouseDown={(state) => {
              if (placeMode || selectAxis !== "x") return;
              if (state?.activeLabel == null) return;
              const t = Number(state.activeLabel);
              if (Number.isFinite(t)) {
                setDragX0(t);
                setDragX1(t);
              }
            }}
            onMouseMove={(state) => {
              const t =
                state?.activeLabel != null ? Number(state.activeLabel) : NaN;
              onHoverT(Number.isFinite(t) ? t : null);
              if (dragX0 != null && Number.isFinite(t)) setDragX1(t);
            }}
            onMouseUp={finishDrag}
            onMouseLeave={() => {
              onHoverT(null);
              if (dragX0 != null) finishDrag();
            }}
            onClick={(state) => {
              if (!placeMode || state?.activeLabel == null) return;
              const t = Number(state.activeLabel);
              if (Number.isFinite(t)) onPlace(t);
            }}
            style={{
              cursor: placeMode
                ? "crosshair"
                : selectAxis === "x"
                  ? "col-resize"
                  : "default",
            }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              dataKey="t"
              type="number"
              domain={xDomain}
              allowDataOverflow
              tick={{ fontSize: 9, fill: "#94a3b8" }}
              tickFormatter={(v) => formatTimeTick(Number(v))}
              height={22}
            />
            <YAxis
              width={36}
              tick={{ fontSize: 9, fill: "#94a3b8" }}
              tickFormatter={(v) => Number(v).toFixed(0)}
            />
            <Tooltip
              contentStyle={{ fontSize: 10, padding: "2px 6px" }}
              labelFormatter={(x) => formatTimeLabel(Number(x))}
              formatter={(v) =>
                typeof v === "number"
                  ? [`${v.toFixed(2)} ${m.unit}`, seriesShort(seriesId)]
                  : [String(v ?? ""), seriesShort(seriesId)]
              }
            />
            {dragX0 != null && dragX1 != null && dragX0 !== dragX1 && (
              <ReferenceArea
                x1={dragX0}
                x2={dragX1}
                fill="#38bdf8"
                fillOpacity={0.2}
              />
            )}
            {cursors.map((c) => (
              <ReferenceLine
                key={c.id}
                x={c.t}
                stroke={c.color}
                strokeDasharray="3 2"
                strokeWidth={1}
              />
            ))}
            {cursorT != null && (
              <ReferenceLine
                x={cursorT}
                stroke={playheadOn ? "#4338ca" : "#0f172a"}
                strokeWidth={playheadOn ? 2 : 1.25}
                strokeDasharray={playheadOn ? undefined : "4 3"}
                ifOverflow="extendDomain"
              />
            )}
            {showSpeedLimits &&
              speedLimits &&
              SPEED_LIMIT_OVERLAYS.map((s) => {
                if (!speedLimits[s.toggle]) return null;
                if (!data.some((r) => Number.isFinite(r[s.key]))) return null;
                return (
                  <Line
                    key={s.key}
                    type="stepAfter"
                    dataKey={s.key}
                    name={s.name}
                    stroke={s.stroke}
                    strokeWidth={1.1}
                    strokeDasharray={s.dash}
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                );
              })}
            <Line
              type="monotone"
              dataKey={seriesId}
              stroke={m.color}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
            {showRolling && (
              <Line
                type="monotone"
                dataKey="rolling"
                stroke={m.color}
                strokeDasharray="4 3"
                strokeWidth={1.2}
                dot={false}
                isAnimationActive={false}
                name={rollingLabel}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export type ResultsAnalyseStudioProps = {
  rows: InspectRow[];
  profile: ConsolidatedProfile;
  corridor: SpatialCorridor | null;
  onCorridorChange?: (c: SpatialCorridor) => void;
  runMeta?: InspectRunMeta | null;
  slopeUnit: SlopeUnit;
  onSlopeUnitChange: (u: SlopeUnit) => void;
  syncEnabled?: boolean;
  onCursorS?: (s_m: number | null) => void;
  onBrushRangeS?: (range: { s0: number; s1: number } | null) => void;
  /** Playback playhead time (s) — drives the vertical cursor on analyse charts. */
  highlightT?: number | null;
  /** Pan zoom window to keep the playhead in view while replaying. */
  followPlayhead?: boolean;
  warnings?: CycleGenWarning[];
  noGps?: boolean;
  hasVehicle?: boolean;
  elevationMeta?: ElevationProfileMeta | null;
  /** Register figure export actions for the parent Exporter menu. */
  onFigureExportsChange?: (
    api: {
      exportJpeg: () => void;
      exportCsv: () => void;
      busy: boolean;
      disabled: boolean;
    } | null
  ) => void;
};

export default function ResultsAnalyseStudio({
  rows,
  profile,
  corridor,
  onCorridorChange,
  runMeta = null,
  slopeUnit,
  onSlopeUnitChange,
  syncEnabled = true,
  onCursorS,
  onBrushRangeS,
  highlightT = null,
  followPlayhead = false,
  warnings = [],
  noGps = false,
  hasVehicle = true,
  elevationMeta = null,
  onFigureExportsChange,
}: ResultsAnalyseStudioProps) {
  const [tab, setTab] = useState<"analyse" | "corridor">("analyse");
  const [viewMode, setViewMode] = useState<"focus" | "compare">("focus");
  const [primary, setPrimary] = useState<InspectSeriesId>("v_kmh");
  const [secondary, setSecondary] = useState<InspectSeriesId | null>(null);
  const [recent, setRecent] = useState<InspectSeriesId[]>([
    "v_kmh",
    "slope",
    "a_lon",
    "p_regen_kw",
  ]);
  const [linkCharts, setLinkCharts] = useState(true);
  const [selectAxis, setSelectAxis] = useState<SelectAxis>("x");
  const [yDomain, setYDomain] = useState<[number, number] | null>(null);
  const [displayWidth, setDisplayWidth] = useState(60);
  const [windowStartT, setWindowStartT] = useState(0);
  const [zoomMode, setZoomMode] = useState<"full" | "window">("full");
  const [rollingOn, setRollingOn] = useState(true);
  const [rollingMode, setRollingMode] = useState<RollingMode>("rms");
  const [rollTau, setRollTau] = useState(10);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [speedLimitsOn, setSpeedLimitsOn] =
    useState<SpeedLimitFlags>(DEFAULT_SPEED_LIMITS);
  const [metaOpen, setMetaOpen] = useState(false);
  const [exporting, setExporting] = useState<"jpeg" | "csv" | null>(null);
  const [selectedFeu, setSelectedFeu] = useState<number | null>(null);
  const [microOpen, setMicroOpen] = useState(false);
  const [inspectS, setInspectS] = useState(0);
  const [inspectMeta, setInspectMeta] = useState<{
    t: number;
    speedKmh: number;
  } | null>(null);
  const [tableOpen, setTableOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement | null>(null);

  const availableSeries = useMemo(
    () =>
      INSPECT_SERIES.filter((s) => !s.needsVehicle || hasVehicle),
    [hasVehicle]
  );

  const [tMin, tMax] = useMemo((): [number, number] => {
    if (!rows.length) return [0, 1];
    return [rows[0].t, rows[rows.length - 1].t];
  }, [rows]);
  const tripSpan = Math.max(0, tMax - tMin);

  const clampedWidth = useMemo(() => {
    return Math.min(Math.max(5, displayWidth), Math.max(5, tripSpan || displayWidth));
  }, [displayWidth, tripSpan]);

  const clampedStart = useMemo(() => {
    const maxStart = Math.max(tMin, tMax - clampedWidth);
    return Math.min(Math.max(windowStartT, tMin), maxStart);
  }, [windowStartT, tMin, tMax, clampedWidth]);

  const winT0 = clampedStart;
  const winT1 = clampedStart + clampedWidth;

  /** Visible x domain for charts. */
  const xDomain = useMemo((): [number, number] => {
    if (!linkCharts && viewMode === "compare") return [tMin, tMax];
    if (zoomMode === "window") return [winT0, winT1];
    return [tMin, tMax];
  }, [linkCharts, viewMode, zoomMode, winT0, winT1, tMin, tMax]);

  // Keep the playhead inside the visible time window while replaying.
  useEffect(() => {
    if (!followPlayhead || highlightT == null || !Number.isFinite(highlightT)) {
      return;
    }
    const span = Math.max(5, clampedWidth);
    const [x0, x1] =
      zoomMode === "window" ? [winT0, winT1] : [tMin, tMax];
    // If full-trip view and playhead is on-screen, nothing to do.
    if (zoomMode !== "window") {
      // Auto-engage a sliding window for long trips so the cursor "animates"
      // through a readable zoom rather than a static full-span line.
      const reduce =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!reduce && tripSpan > 90) {
        const w = Math.min(60, Math.max(20, tripSpan * 0.15));
        const start = Math.min(
          Math.max(tMin, highlightT - w * 0.35),
          Math.max(tMin, tMax - w)
        );
        setDisplayWidth(w);
        setWindowStartT(start);
        setZoomMode("window");
      }
      return;
    }
    const margin = (x1 - x0) * 0.2;
    if (highlightT >= x0 + margin && highlightT <= x1 - margin) return;
    const nextStart = Math.min(
      Math.max(tMin, highlightT - span * 0.35),
      Math.max(tMin, tMax - span)
    );
    setWindowStartT(nextStart);
  }, [
    followPlayhead,
    highlightT,
    zoomMode,
    winT0,
    winT1,
    tMin,
    tMax,
    clampedWidth,
    tripSpan,
  ]);

  /** Stats / legend window = display window when zoomed, else full trip. */
  const statsRange = useMemo((): [number, number] => {
    if (zoomMode === "window") return [winT0, winT1];
    return [tMin, tMax];
  }, [zoomMode, winT0, winT1, tMin, tMax]);

  const effectiveRoll = Math.min(
    Math.max(0.1, rollTau),
    Math.max(0.1, tripSpan || rollTau)
  );
  const rollIsFull = tripSpan > 0 && effectiveRoll >= tripSpan - 1e-6;
  const rollingLabel = `${rollingMode === "rms" ? "RMS" : "Moy."} ${
    rollIsFull ? "trajet" : `${effectiveRoll.toFixed(0)} s`
  }`;

  const moments = useMemo(() => findKeyMoments(rows), [rows]);

  const applyBrushX = useCallback(
    (t0: number, t1: number) => {
      const a = Math.max(tMin, Math.min(t0, t1));
      const b = Math.min(tMax, Math.max(t0, t1));
      const w = Math.max(5, b - a);
      // Always apply shared X zoom when linkCharts; otherwise still zoom focus via shared state
      // (single shared timebase — compare cells follow if linkCharts).
      if (linkCharts || viewMode === "focus") {
        setDisplayWidth(w);
        setWindowStartT(a);
        setZoomMode("window");
      }
    },
    [tMin, tMax, linkCharts, viewMode]
  );

  const applyBrushY = useCallback((y0: number, y1: number) => {
    const lo = Math.min(y0, y1);
    const hi = Math.max(y0, y1);
    if (!(hi > lo)) return;
    const pad = (hi - lo) * 0.05 || 0.1;
    setYDomain([lo - pad, hi + pad]);
  }, []);

  /** Molette / trackpad : zoom X centré sur le pointeur (facteur via deltaY). */
  const applyWheelZoom = useCallback(
    (anchorT: number, deltaY: number) => {
      if (!Number.isFinite(deltaY) || deltaY === 0) return;
      if (!(linkCharts || viewMode === "focus")) return;

      const curW = zoomMode === "window" ? clampedWidth : Math.max(tripSpan, 5);
      const curStart = zoomMode === "window" ? clampedStart : tMin;
      const anchor = Math.max(tMin, Math.min(anchorT, tMax));

      // deltaY > 0 → dézoom ; sensibilité douce (molette + pinch trackpad)
      const factor = Math.exp(Math.min(80, Math.max(-80, deltaY)) * 0.0022);
      let newW = Math.min(Math.max(5, curW * factor), Math.max(5, tripSpan || 5));

      if (newW >= tripSpan - 0.5) {
        setZoomMode("full");
        setWindowStartT(tMin);
        setDisplayWidth(Math.min(60, Math.max(5, tripSpan || 60)));
        return;
      }

      const rel = curW > 1e-6 ? (anchor - curStart) / curW : 0.5;
      const maxStart = Math.max(tMin, tMax - newW);
      const newStart = Math.min(Math.max(anchor - rel * newW, tMin), maxStart);

      setDisplayWidth(newW);
      setWindowStartT(newStart);
      setZoomMode("window");
    },
    [
      linkCharts,
      viewMode,
      zoomMode,
      clampedWidth,
      clampedStart,
      tripSpan,
      tMin,
      tMax,
    ]
  );

  const resetZoom = useCallback(() => {
    setZoomMode("full");
    setWindowStartT(tMin);
    setDisplayWidth(Math.min(60, Math.max(5, tripSpan || 60)));
    setYDomain(null);
  }, [tMin, tripSpan]);

  const pushRecent = useCallback((id: InspectSeriesId) => {
    setRecent((prev) => {
      const next = [id, ...prev.filter((x) => x !== id)];
      return next.slice(0, 4);
    });
  }, []);

  const selectPrimary = useCallback(
    (id: InspectSeriesId, e?: MouseEvent) => {
      if (e?.shiftKey) {
        setSecondary((prev) => (prev === id ? null : id === primary ? null : id));
        return;
      }
      setPrimary(id);
      pushRecent(id);
      if (secondary === id) setSecondary(null);
    },
    [primary, secondary, pushRecent]
  );

  const emitCursorFromT = useCallback(
    (t: number | null) => {
      if (!syncEnabled || !onCursorS) return;
      if (t == null || !Number.isFinite(t)) {
        onCursorS(null);
        return;
      }
      const i = nearestIndex(profile.time, t);
      onCursorS(profile.position[i] ?? null);
    },
    [syncEnabled, onCursorS, profile.time, profile.position]
  );

  const handleHoverT = useCallback(
    (t: number | null) => {
      setHoverT(t);
      emitCursorFromT(t);
    },
    [emitCursorFromT]
  );

  // Map brush from zoom window
  useEffect(() => {
    if (!onBrushRangeS || noGps) return;
    if (zoomMode !== "window" || clampedWidth >= tripSpan - 1e-6) {
      onBrushRangeS(null);
      return;
    }
    const i0 = nearestIndex(profile.time, winT0);
    const i1 = nearestIndex(profile.time, winT1);
    const s0 = profile.position[i0] ?? 0;
    const s1 = profile.position[i1] ?? 0;
    onBrushRangeS({ s0: Math.min(s0, s1), s1: Math.max(s0, s1) });
  }, [
    zoomMode,
    winT0,
    winT1,
    clampedWidth,
    tripSpan,
    profile.time,
    profile.position,
    onBrushRangeS,
    noGps,
  ]);

  const addCursorAt = (_t: number) => {
    /* cursors retirés — zoom Zone X / Y à la place */
  };

  const jumpToMoment = (t: number) => {
    const start = Math.max(tMin, Math.min(t - clampedWidth / 2, tMax - clampedWidth));
    setWindowStartT(start);
    setZoomMode("window");
    handleHoverT(t);
  };

  const chartSeriesIds = useMemo(() => {
    if (viewMode === "compare") {
      return recent.slice(0, 4);
    }
    const ids: InspectSeriesId[] = [primary];
    if (secondary && secondary !== primary) ids.push(secondary);
    return ids;
  }, [viewMode, recent, primary, secondary]);

  const limitSamples = useMemo(
    () => sampleLimitsAlongProfile(profile, corridor),
    [profile, corridor]
  );

  const hasSpeedLimits = Boolean(limitSamples);
  const speedChartVisible =
    primary === "v_kmh" ||
    secondary === "v_kmh" ||
    (viewMode === "compare" && chartSeriesIds.includes("v_kmh"));

  const chartDataBySeries = useMemo(() => {
    const map = new Map<InspectSeriesId, ChartPoint[]>();
    const [a, b] = xDomain;
    for (const id of chartSeriesIds) {
      const overlay = rollingOn
        ? withRollingOverlay(rows, id, effectiveRoll, rollingMode)
        : rows.map((r) => ({ ...r, rolling: r[id] }));
      let sliced = overlay.filter((r) => r.t >= a - 1e-6 && r.t <= b + 1e-6);
      if (id === "v_kmh" && limitSamples) {
        sliced = sliced.map((r) => {
          const i = nearestIndex(profile.time, r.t);
          return {
            ...r,
            env_kmh: limitSamples.envelope_kmh[i],
            legal_kmh: limitSamples.legal_kmh[i],
            traffic_kmh: limitSamples.traffic_kmh[i],
            curve_kmh: limitSamples.curve_kmh[i],
          };
        });
      }
      map.set(id, sliced);
    }
    return map;
  }, [
    chartSeriesIds,
    rows,
    rollingOn,
    effectiveRoll,
    rollingMode,
    xDomain,
    limitSamples,
    profile.time,
  ]);

  const focusData = useMemo(() => {
    const base = chartDataBySeries.get(primary) ?? [];
    if (!secondary || secondary === primary) return base;
    return base.map((r) => ({
      ...r,
      [secondary]: nearestRow(rows, r.t)?.[secondary] ?? 0,
    }));
  }, [chartDataBySeries, primary, secondary, rows]);

  const legendMeans = useMemo(() => {
    const [a, b] = statsRange;
    const slice = rows.filter((r) => r.t >= a - 1e-6 && r.t <= b + 1e-6);
    const src = slice.length ? slice : rows;
    return chartSeriesIds.map((id) => {
      const st = sliceStats(src, src[0]?.t ?? 0, src[src.length - 1]?.t ?? 0, id);
      const m = inspectSeriesMeta(id);
      return {
        id,
        mean: st?.mean ?? null,
        rms: st?.rms ?? null,
        meanActive: st?.meanActive ?? null,
        duty: st?.duty ?? null,
        energyKwh: st?.energyKwh ?? null,
        unit: m.unit,
        color: m.color,
        label: m.defaultLabel,
        zeroInflated: isZeroInflatedSeries(id),
      };
    });
  }, [rows, statsRange, chartSeriesIds]);

  const hoverHud = useMemo(() => {
    if (hoverT == null) return null;
    const row = nearestRow(rows, hoverT);
    if (!row) return null;
    const bits = chartSeriesIds.map((id) => {
      const m = inspectSeriesMeta(id);
      return `${m.short}=${row[id].toFixed(2)} ${m.unit}`;
    });
    if (limitSamples && speedChartVisible) {
      const i = nearestIndex(profile.time, hoverT);
      for (const s of SPEED_LIMIT_OVERLAYS) {
        if (!speedLimitsOn[s.toggle]) continue;
        const arr =
          s.toggle === "envelope"
            ? limitSamples.envelope_kmh
            : s.toggle === "legal"
              ? limitSamples.legal_kmh
              : s.toggle === "traffic"
                ? limitSamples.traffic_kmh
                : limitSamples.curve_kmh;
        const v = arr[i];
        if (Number.isFinite(v)) bits.push(`${s.name}=${v.toFixed(1)}`);
      }
    }
    return `t=${row.t.toFixed(1)} s · ${bits.join(" · ")}`;
  }, [
    hoverT,
    rows,
    chartSeriesIds,
    limitSamples,
    speedChartVisible,
    speedLimitsOn,
    profile.time,
  ]);

  const primaryMean = legendMeans.find((m) => m.id === primary);
  const meanLabel =
    primaryMean?.mean != null
      ? primaryMean.zeroInflated && primaryMean.meanActive != null
        ? `ȳ ${primaryMean.mean.toFixed(2)} ${primaryMean.unit} · actif ${primaryMean.meanActive.toFixed(1)}`
        : `ȳ ${primaryMean.mean.toFixed(2)} ${primaryMean.unit}`
      : undefined;

  const sparkData = useMemo(() => {
    const step = Math.max(1, Math.ceil(rows.length / 80));
    const out = new Map<InspectSeriesId, { t: number; v: number }[]>();
    for (const s of availableSeries) {
      const pts: { t: number; v: number }[] = [];
      for (let i = 0; i < rows.length; i += step) {
        pts.push({ t: rows[i].t, v: rows[i][s.id] });
      }
      out.set(s.id, pts);
    }
    return out;
  }, [rows, availableSeries]);

  const windowBand: [number, number] | null =
    zoomMode === "full" && tripSpan > clampedWidth + 1e-6
      ? [winT0, winT1]
      : null;

  const exportJpeg = useCallback(async () => {
    if (!exportRef.current) return;
    setExporting("jpeg");
    try {
      const dataUrl = await toJpeg(exportRef.current, {
        quality: 0.95,
        pixelRatio: 2,
        backgroundColor: "#ffffff",
        cacheBust: true,
      });
      const seriesSlug =
        viewMode === "focus"
          ? seriesShort(primary)
          : chartSeriesIds.map(seriesShort).join("-").slice(0, 40);
      const a = document.createElement("a");
      a.download = `cyclegen_${seriesSlug || "figure"}.jpg`;
      a.href = dataUrl;
      a.click();
    } catch (e) {
      console.error(e);
      window.alert("Export JPEG échoué.");
    } finally {
      setExporting(null);
    }
  }, [viewMode, primary, chartSeriesIds]);

  const exportCsv = useCallback(() => {
    setExporting("csv");
    try {
      const [a, b] = statsRange;
      const slice = rows.filter((r) => r.t >= a - 1e-6 && r.t <= b + 1e-6);
      const series = chartSeriesIds;
      const sep = ";";
      const esc = (v: string | number) => {
        const s = String(v);
        if (/[;"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
      };
      const num = (v: number) =>
        Number.isFinite(v) ? String(v).replace(".", ",") : "";
      const header = [
        "T_s",
        "S_m",
        ...series.map((id) => `${seriesShort(id)}_${inspectSeriesMeta(id).unit}`),
        ...(rollingOn
          ? series.map(
              (id) =>
                `${seriesShort(id)}_${rollingMode === "rms" ? "RMS" : "Moy"}_${effectiveRoll.toFixed(0)}s`
            )
          : []),
      ];
      const lines: string[] = [
        esc("# Analyse CycleGen"),
        ...metaLinesForCsv(runMeta).map(esc),
        esc(`# t0=${a.toFixed(3)}s t1=${b.toFixed(3)}s`),
        header.map(esc).join(sep),
      ];
      const overlays = rollingOn
        ? series.map((id) =>
            withRollingOverlay(rows, id, effectiveRoll, rollingMode)
          )
        : null;
      for (const r of slice) {
        const cells = [num(r.t), num(r.s), ...series.map((id) => num(r[id]))];
        if (overlays) {
          for (const ov of overlays) {
            const hit = nearestRow(ov, r.t) as
              | (InspectRow & { rolling?: number })
              | null;
            cells.push(num(hit?.rolling ?? Number.NaN));
          }
        }
        lines.push(cells.map(esc).join(sep));
      }
      const blob = new Blob(["\uFEFF" + lines.join("\r\n")], {
        type: "text/csv;charset=utf-8;",
      });
      const url = URL.createObjectURL(blob);
      const aEl = document.createElement("a");
      aEl.href = url;
      aEl.download = "cyclegen_analyse.csv";
      aEl.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
      window.alert("Export CSV échoué.");
    } finally {
      setExporting(null);
    }
  }, [
    statsRange,
    rows,
    chartSeriesIds,
    rollingOn,
    rollingMode,
    effectiveRoll,
    runMeta,
  ]);

  useEffect(() => {
    if (!onFigureExportsChange) return;
    onFigureExportsChange({
      exportJpeg: () => {
        void exportJpeg();
      },
      exportCsv,
      busy: exporting != null,
      disabled: tab !== "analyse",
    });
    return () => onFigureExportsChange(null);
  }, [
    onFigureExportsChange,
    exportJpeg,
    exportCsv,
    exporting,
    tab,
  ]);

  const openInspect = (s_m: number, meta?: { t: number; speedKmh: number }) => {
    setInspectS(s_m);
    setInspectMeta(meta ?? null);
    setMicroOpen(true);
    setTab("corridor");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Tabs — hide Corridor for energy / no-GPS traces */}
      {!noGps && (
      <div className="flex shrink-0 items-center gap-1 border-b border-slate-100 px-2 pt-1">
        {(
          [
            ["analyse", "Analyse"],
            ["corridor", "Corridor"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`rounded-t px-2.5 py-1 text-[11px] font-semibold ${
              tab === id
                ? "bg-white text-slate-900 ring-1 ring-slate-200 ring-b-white"
                : "text-slate-500 hover:text-slate-800"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      )}

      {!noGps && tab === "corridor" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
          {warnings.length > 0 && <WarningsPanel warnings={warnings} />}
          {corridor &&
            (corridor.elevations_m?.length ||
              corridor.slope_profile?.km_segments?.length) && (
              <ElevationProfileChart
                corridor={corridor}
                tall
                meta={elevationMeta}
              />
            )}
          {corridor && onCorridorChange && (
            <TrafficLightsEditor
              corridor={corridor}
              selectedIndex={selectedFeu}
              onSelect={setSelectedFeu}
              onChangeFeux={(S_feux) =>
                onCorridorChange(withUpdatedFeux(corridor, S_feux))
              }
              onChangeCorridor={onCorridorChange}
              onInspect={(s) => openInspect(s)}
              defaultOpen
            />
          )}
          {corridor && (
            <MicroInspectPanel
              open={microOpen}
              onClose={() => setMicroOpen(false)}
              corridor={corridor}
              inspectS={inspectS}
              onInspectSChange={setInspectS}
              selectedFeuIndex={selectedFeu}
              onAddFeuAtInspect={() => {
                if (!onCorridorChange) return;
                const next = [...(corridor.S_feux ?? []), inspectS];
                onCorridorChange(withUpdatedFeux(corridor, next));
                setSelectedFeu(next.length - 1);
              }}
              onMoveSelectedFeuHere={() => {
                if (selectedFeu == null || !onCorridorChange) return;
                const next = [...(corridor.S_feux ?? [])];
                next[selectedFeu] = inspectS;
                onCorridorChange(withUpdatedFeux(corridor, next));
              }}
              speedKmh={inspectMeta?.speedKmh ?? null}
              contextLabel={
                inspectMeta
                  ? `Depuis analyse à t=${inspectMeta.t.toFixed(0)} s`
                  : "Micro-inspection"
              }
            />
          )}
          <div>
            <button
              type="button"
              onClick={() => setTableOpen((v) => !v)}
              className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500"
            >
              {tableOpen ? "▾" : "▸"} Table profil
            </button>
            {tableOpen && (
              <ProfileTable
                profile={profile}
                maxRows={40}
                slopeUnit={slopeUnit}
              />
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-slate-500">Unité pente</span>
            <SlopeUnitToggle value={slopeUnit} onChange={onSlopeUnitChange} />
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Rail */}
          <div
            className={`flex shrink-0 flex-col gap-2 overflow-y-auto border-r border-slate-100 bg-slate-50/70 p-2 ${
              noGps ? "w-[160px]" : "w-[220px]"
            }`}
          >
            {runMeta && runMeta.entries.length > 0 && !noGps && (
              <div>
                <button
                  type="button"
                  onClick={() => setMetaOpen((v) => !v)}
                  className="mb-1 flex w-full items-center justify-between px-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400"
                >
                  <span>Traçabilité</span>
                  <span>{metaOpen ? "▾" : "▸"}</span>
                </button>
                {metaOpen && (
                  <dl className="max-h-36 space-y-0.5 overflow-y-auto rounded border border-slate-200 bg-white px-1.5 py-1 text-[9px] text-slate-600">
                    {runMeta.entries.slice(0, 24).map((e) => (
                      <div key={`${e.group}.${e.key}`} className="flex justify-between gap-1">
                        <dt className="shrink-0 text-slate-400">{e.label}</dt>
                        <dd className="truncate text-right font-semibold text-slate-800">
                          {e.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            )}

            <div>
              <p className="mb-1 px-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                Séries
              </p>
              <div className="flex flex-wrap gap-1">
                {availableSeries.map((s) => {
                  const isP = primary === s.id;
                  const isS = secondary === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={(e) => selectPrimary(s.id, e)}
                      className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${
                        isP
                          ? "bg-slate-900 text-white"
                          : isS
                            ? "bg-brand/15 text-brand ring-1 ring-brand/40"
                            : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      {s.short}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 px-1 text-[9px] text-slate-400">
                Clic = focus · Shift+clic = overlay
              </p>
            </div>

            <div className="space-y-1 rounded border border-slate-200 bg-white px-2 py-1.5">
              <label className="flex items-center justify-between gap-2 text-[10px] font-semibold text-slate-700">
                <span>Lier les graphes (X)</span>
                <input
                  type="checkbox"
                  checked={linkCharts}
                  onChange={(e) => setLinkCharts(e.target.checked)}
                  className="accent-brand"
                />
              </label>
              <p className="text-[9px] leading-snug text-slate-400">
                Si ON, une sélection X sur un graphe zoome tous les graphes.
              </p>
              <p className="text-[9px] text-slate-400">
                Sync map : {syncEnabled ? "ON" : "OFF"} (commande carte)
              </p>
            </div>

            {hasSpeedLimits && speedChartVisible && (
              <div className="space-y-1.5 rounded border border-slate-200 bg-white px-2 py-1.5">
                <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                  Limites vitesse
                </p>
                <p className="text-[9px] leading-snug text-slate-400">
                  Afficher / masquer sur le graphique vitesse.
                </p>
                <div className="flex flex-wrap gap-1">
                  {(
                    [
                      ["envelope", "Enveloppe", "#2563eb"],
                      ["legal", "Légal", "#64748b"],
                      ["traffic", "Trafic", "#ea580c"],
                      ["curve", "Virage", "#7c3aed"],
                    ] as const
                  ).map(([key, label, color]) => {
                    const on = speedLimitsOn[key];
                    return (
                      <button
                        key={key}
                        type="button"
                        role="checkbox"
                        aria-checked={on}
                        title={`Afficher / masquer ${label}`}
                        onClick={() =>
                          setSpeedLimitsOn((prev) => ({
                            ...prev,
                            [key]: !prev[key],
                          }))
                        }
                        className={`inline-flex min-h-[26px] items-center gap-1 rounded-md px-2 text-[10px] font-semibold transition ${
                          on
                            ? "text-white shadow-sm"
                            : "bg-slate-50 text-slate-500 ring-1 ring-slate-200"
                        }`}
                        style={on ? { backgroundColor: color } : undefined}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="space-y-1.5 rounded border border-slate-200 bg-white px-2 py-1.5">
              <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                Moyenne glissante
              </p>
              <label className="flex items-center justify-between gap-2 text-[10px] font-semibold text-slate-700">
                <span>Activer</span>
                <input
                  type="checkbox"
                  checked={rollingOn}
                  onChange={(e) => setRollingOn(e.target.checked)}
                  className="accent-brand"
                />
              </label>
              <div className="flex rounded border border-slate-200 bg-slate-50 p-0.5">
                {(
                  [
                    ["mean", "Moy."],
                    ["rms", "RMS"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    disabled={!rollingOn}
                    onClick={() => setRollingMode(id)}
                    className={`flex-1 rounded px-1.5 py-0.5 text-[10px] font-semibold disabled:opacity-40 ${
                      rollingMode === id
                        ? "bg-slate-900 text-white"
                        : "text-slate-600"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-1.5 text-[10px] text-slate-600">
                <span className="shrink-0 font-semibold">τ</span>
                <input
                  type="number"
                  min={1}
                  value={Math.round(rollTau)}
                  onChange={(e) =>
                    setRollTau(Math.max(1, Number(e.target.value) || 1))
                  }
                  disabled={!rollingOn}
                  className="w-full rounded border border-slate-200 px-1 py-0.5 tabular-nums disabled:opacity-40"
                />
                <span className="shrink-0">s</span>
              </label>
              <div className="flex flex-wrap gap-1">
                {ROLL_PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    disabled={!rollingOn}
                    onClick={() => setRollTau(p)}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold disabled:opacity-40 ${
                      Math.round(rollTau) === p
                        ? "bg-slate-800 text-white"
                        : "border border-slate-200 text-slate-600"
                    }`}
                  >
                    {p}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={!rollingOn}
                  onClick={() => setRollTau(Math.max(tripSpan, 1))}
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold disabled:opacity-40 ${
                    rollIsFull
                      ? "bg-slate-800 text-white"
                      : "border border-slate-200 text-slate-600"
                  }`}
                >
                  Trajet
                </button>
              </div>
              {rollingOn && (
                <p className="text-[9px] leading-snug text-slate-400">
                  Overlay {rollingMode === "rms" ? "RMS" : "moyenne"} · τ{" "}
                  {rollIsFull ? "trajet" : `${Math.round(effectiveRoll)} s`}
                </p>
              )}
            </div>

            <div className="space-y-1 rounded border border-slate-200 bg-white px-2 py-1.5">
              <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                Vue X
              </p>
              <div className="flex rounded border border-slate-200 bg-slate-50 p-0.5">
                {(
                  [
                    ["full", "Plein"],
                    ["window", "Zoom"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setZoomMode(id)}
                    className={`flex-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      zoomMode === id
                        ? "bg-slate-900 text-white"
                        : "text-slate-600"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="text-[9px] leading-snug text-slate-400">
                Molette / pad sur le graphe pour zoomer · Zone X pour cadrer ·
                Reset zoom en haut.
              </p>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between px-1">
                <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                  Stats fenêtre
                </p>
                <button
                  type="button"
                  onClick={() =>
                    setViewMode((v) => (v === "focus" ? "compare" : "focus"))
                  }
                  className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${
                    viewMode === "compare"
                      ? "bg-slate-900 text-white"
                      : "border border-slate-200 text-slate-600"
                  }`}
                >
                  {viewMode === "compare" ? "Focus" : "Comparer"}
                </button>
              </div>
              <ul className="space-y-1">
                {legendMeans.map((m) => (
                  <li
                    key={m.id}
                    className="rounded border border-slate-200 bg-white px-1.5 py-1 text-[10px] tabular-nums text-slate-600"
                  >
                    <div className="flex items-center gap-1">
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ background: m.color }}
                      />
                      <span className="font-semibold text-slate-800">
                        {m.label}
                      </span>
                    </div>
                    <div>
                      ȳ <strong>{m.mean?.toFixed(2) ?? "—"}</strong> {m.unit}
                      {" · "}RMS {m.rms?.toFixed(2) ?? "—"} {m.unit}
                    </div>
                    {m.zeroInflated && m.meanActive != null && (
                      <div className="text-emerald-800">
                        ȳ actif {m.meanActive.toFixed(1)} {m.unit}
                        {m.duty != null
                          ? ` · ${(m.duty * 100).toFixed(0)} %`
                          : ""}
                      </div>
                    )}
                    {m.energyKwh != null && Number.isFinite(m.energyKwh) && (
                      <div className="text-slate-400">
                        E ≈ {m.energyKwh.toFixed(3)} kWh
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>

            {moments.length > 0 && (
              <div>
                <p className="mb-1 px-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                  Moments
                </p>
                <div className="flex flex-wrap gap-1">
                  {moments.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => jumpToMoment(m.t)}
                      className="rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[9px] font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Main */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 flex-col gap-1.5 bg-white p-2">
              <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-[10px]">
                <span className="font-semibold uppercase tracking-wide text-slate-400">
                  Sélection
                </span>
                {(
                  [
                    ["x", "Zone X"],
                    ["y", "Zone Y"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      setSelectAxis((prev) => (prev === id ? null : id));
                    }}
                    className={`rounded px-1.5 py-0.5 font-semibold ${
                      selectAxis === id
                        ? "bg-sky-600 text-white"
                        : "border border-slate-200 text-slate-600"
                    }`}
                    title={
                      id === "x"
                        ? "Glisser horizontalement pour zoomer le temps"
                        : "Glisser verticalement : deux curseurs Y (Y1/Y2) pour zoomer l’axe"
                    }
                  >
                    {label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={resetZoom}
                  className="rounded border border-slate-200 px-1.5 py-0.5 font-semibold text-slate-600 hover:bg-slate-50"
                >
                  Reset zoom
                </button>
                {yDomain && (
                  <span className="tabular-nums text-slate-400">
                    Y [{yDomain[0].toFixed(1)}…{yDomain[1].toFixed(1)}]
                  </span>
                )}
                <span
                  className="ml-auto min-w-0 max-w-[min(100%,28rem)] truncate text-right tabular-nums text-slate-600"
                  title={hoverHud ?? undefined}
                  aria-live="polite"
                >
                  {hoverHud ?? "—"}
                </span>
              </div>

              <div
                ref={exportRef}
                className={`min-h-0 flex-1 ${
                  viewMode === "compare"
                    ? "grid grid-cols-2 grid-rows-2 gap-1.5"
                    : ""
                }`}
              >
                {viewMode === "focus" ? (
                  <FocusChart
                    data={focusData}
                    primary={primary}
                    secondary={secondary}
                    xDomain={xDomain}
                    yDomain={yDomain}
                    cursors={[]}
                    placeMode={false}
                    selectAxis={selectAxis}
                    onPlace={addCursorAt}
                    showRolling={rollingOn}
                    rollingLabel={rollingLabel}
                    windowBand={windowBand}
                    hoverT={hoverT}
                    highlightT={highlightT}
                    followPlayhead={followPlayhead}
                    onHoverT={handleHoverT}
                    meanLabel={meanLabel}
                    onBrushX={applyBrushX}
                    onBrushY={applyBrushY}
                    speedLimits={hasSpeedLimits ? speedLimitsOn : null}
                    onWheelZoom={applyWheelZoom}
                  />
                ) : (
                  chartSeriesIds.map((id) => (
                    <CompareCell
                      key={id}
                      data={chartDataBySeries.get(id) ?? []}
                      seriesId={id}
                      xDomain={
                        linkCharts ? xDomain : ([tMin, tMax] as [number, number])
                      }
                      cursors={[]}
                      showRolling={rollingOn}
                      rollingLabel={rollingLabel}
                      onHoverT={handleHoverT}
                      placeMode={false}
                      onPlace={addCursorAt}
                      selectAxis={selectAxis}
                      onBrushX={applyBrushX}
                      speedLimits={
                        id === "v_kmh" && hasSpeedLimits ? speedLimitsOn : null
                      }
                      onWheelZoom={applyWheelZoom}
                      highlightT={highlightT}
                      followPlayhead={followPlayhead}
                    />
                  ))
                )}
              </div>

              {/* Miniatures */}
              <div className="flex shrink-0 gap-1.5 overflow-x-auto pb-0.5">
                {availableSeries.map((s) => (
                  <Spark
                    key={s.id}
                    data={sparkData.get(s.id) ?? []}
                    color={s.color}
                    active={primary === s.id || secondary === s.id}
                    label={s.short}
                    unit={s.unit}
                    onClick={(e) => selectPrimary(s.id, e)}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
