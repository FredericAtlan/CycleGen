"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ComposedChart,
  Area,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  Brush,
  Legend,
} from "recharts";
import type { SpatialCorridor } from "@/lib/types";
import type { EnvelopeMask } from "@/lib/corridorEdit";
import { snapPostedSpeedKmh } from "@/lib/cycleMetrics";

type SpeedLimitChartProps = {
  corridor: SpatialCorridor;
  tall?: boolean;
  onInspectS?: (s_m: number) => void;
  highlightS?: number | null;
  onCursorS?: (s_m: number | null) => void;
  onBrushRangeS?: (range: { s0: number; s1: number } | null) => void;
  syncEnabled?: boolean;
  envelopeMask?: EnvelopeMask;
  /** Live driver desired: min(V_env × speed_factor, Vmax). */
  speedFactor?: number;
  maxSpeedKmh?: number | null;
};

type Row = {
  s_km: number;
  s_m: number;
  envelope_kmh: number;
  desired_kmh: number | null;
  legal_kmh: number | null;
  traffic_kmh: number | null;
  curve_kmh: number | null;
  binder: string;
};

function mpsToKmh(v: number | undefined | null): number | null {
  if (v == null || !Number.isFinite(v) || v <= 0) return null;
  const kmh = v * 3.6;
  // Backend sentinel / straight-road "non-binding" curve speeds
  if (kmh > 160) return null;
  return kmh;
}

function legalMpsToKmh(v: number | undefined | null): number | null {
  const raw = mpsToKmh(v);
  if (raw == null) return null;
  return snapPostedSpeedKmh(raw);
}

function bindingSource(
  legal: number | null,
  traffic: number | null,
  curve: number | null,
  envelope: number
): string {
  const cands: { name: string; v: number }[] = [];
  if (legal != null) cands.push({ name: "légal", v: legal });
  if (traffic != null) cands.push({ name: "trafic", v: traffic });
  if (curve != null) cands.push({ name: "courbe", v: curve });
  if (!cands.length) return "enveloppe";
  cands.sort((a, b) => a.v - b.v);
  const best = cands[0];
  if (Math.abs(best.v - envelope) <= 0.5) return best.name;
  return "enveloppe";
}

function buildData(
  corridor: SpatialCorridor,
  speedFactor?: number,
  maxSpeedKmh?: number | null
): Row[] {
  const envSrc =
    corridor.V_envelope?.length === corridor.S.length
      ? corridor.V_envelope
      : corridor.V_limite;
  const n = Math.min(corridor.S.length, envSrc.length);
  if (n === 0) return [];

  const legal = corridor.V_limite_legal ?? [];
  const traffic = corridor.V_traffic ?? [];
  const curve = corridor.V_curve ?? [];
  const hasLegal = legal.length === corridor.S.length;
  const hasTraffic = traffic.length === corridor.S.length;
  const hasCurve = curve.length === corridor.S.length;
  const sf =
    speedFactor != null && Number.isFinite(speedFactor) && speedFactor > 0
      ? speedFactor
      : null;
  const vmax =
    maxSpeedKmh != null && Number.isFinite(maxSpeedKmh) && maxSpeedKmh > 0
      ? maxSpeedKmh
      : null;

  const step = Math.max(1, Math.floor(n / 400));
  const rows: Row[] = [];

  const pushAt = (i: number) => {
    const envelope_kmh = envSrc[i] * 3.6;
    const legal_kmh = hasLegal ? legalMpsToKmh(legal[i]) : null;
    const traffic_kmh = hasTraffic ? mpsToKmh(traffic[i]) : null;
    const curve_kmh = hasCurve ? mpsToKmh(curve[i]) : null;
    let desired_kmh: number | null = null;
    if (sf != null) {
      desired_kmh = envelope_kmh * sf;
      if (vmax != null) desired_kmh = Math.min(desired_kmh, vmax);
    }
    rows.push({
      s_km: corridor.S[i] / 1000,
      s_m: corridor.S[i],
      envelope_kmh,
      desired_kmh,
      legal_kmh,
      traffic_kmh,
      curve_kmh,
      binder: bindingSource(legal_kmh, traffic_kmh, curve_kmh, envelope_kmh),
    });
  };

  for (let i = 0; i < n; i += step) pushAt(i);
  if (n > 0 && (n - 1) % step !== 0) pushAt(n - 1);
  return rows;
}

/** Y max from active sources in [i0,i1]; curve soft-capped so it doesn't explode the axis. */
function computeYDomain(
  rows: Row[],
  i0: number,
  i1: number,
  mask?: EnvelopeMask
): [number, number] {
  if (!rows.length) return [0, 50];
  const lo = Math.max(0, Math.min(i0, i1));
  const hi = Math.min(rows.length - 1, Math.max(i0, i1));
  const useLegal = !mask || mask.legal;
  const useTraffic = !mask || mask.traffic;
  const useCurve = !mask || mask.curve;

  const primary: number[] = [];
  const curveVals: number[] = [];
  for (let i = lo; i <= hi; i++) {
    const r = rows[i];
    if (Number.isFinite(r.envelope_kmh) && r.envelope_kmh > 0) {
      primary.push(r.envelope_kmh);
    }
    if (r.desired_kmh != null && r.desired_kmh > 0) {
      primary.push(r.desired_kmh);
    }
    if (useLegal && r.legal_kmh != null) primary.push(r.legal_kmh);
    if (useTraffic && r.traffic_kmh != null) primary.push(r.traffic_kmh);
    if (useCurve && r.curve_kmh != null) curveVals.push(r.curve_kmh);
  }

  let pool = [...primary];
  if (useCurve && curveVals.length) {
    if (primary.length === 0) {
      pool = curveVals;
    } else {
      const baseMax = Math.max(...primary);
      const cap = Math.max(baseMax * 1.35, 130);
      for (const c of curveVals) {
        if (c <= cap) pool.push(c);
      }
    }
  }

  if (!pool.length) return [0, 50];
  pool.sort((a, b) => a - b);
  const p98 = pool[Math.min(pool.length - 1, Math.floor((pool.length - 1) * 0.98))];
  const yMax = Math.max(10, Math.ceil((p98 * 1.12) / 5) * 5);
  return [0, yMax];
}

const SERIES = [
  {
    key: "legal_kmh" as const,
    maskKey: "legal" as const,
    name: "V légal",
    stroke: "#64748b",
  },
  {
    key: "traffic_kmh" as const,
    maskKey: "traffic" as const,
    name: "V trafic",
    stroke: "#ea580c",
  },
  {
    key: "curve_kmh" as const,
    maskKey: "curve" as const,
    name: "V virage",
    stroke: "#7c3aed",
  },
];

export default function SpeedLimitChart({
  corridor,
  tall = false,
  onInspectS,
  highlightS = null,
  onCursorS,
  onBrushRangeS,
  syncEnabled = false,
  envelopeMask,
  speedFactor,
  maxSpeedKmh = null,
}: SpeedLimitChartProps) {
  const data = useMemo(
    () => buildData(corridor, speedFactor, maxSpeedKmh),
    [corridor, speedFactor, maxSpeedKmh]
  );
  const hasDecomp = useMemo(
    () =>
      data.some(
        (r) =>
          r.legal_kmh != null ||
          r.traffic_kmh != null ||
          r.curve_kmh != null ||
          r.desired_kmh != null
      ),
    [data]
  );
  const showDesired = data.some((r) => r.desired_kmh != null);

  const [brush, setBrush] = useState<{ start: number; end: number } | null>(
    null
  );
  const hadSelectionRef = useRef(false);

  useEffect(() => {
    hadSelectionRef.current = false;
    setBrush(null);
  }, [corridor]);

  const brushStart = brush?.start ?? 0;
  const brushEnd = brush?.end ?? Math.max(0, data.length - 1);

  const yDomain = useMemo(
    () => computeYDomain(data, brushStart, brushEnd, envelopeMask),
    [data, brushStart, brushEnd, envelopeMask]
  );

  const portionLabel = useMemo(() => {
    if (!data.length) return null;
    const full = brushStart <= 0 && brushEnd >= data.length - 1;
    if (!brush || full) return null;
    const a = data[brushStart];
    const b = data[brushEnd];
    if (!a || !b) return null;
    return `${a.s_km.toFixed(2)}–${b.s_km.toFixed(2)} km`;
  }, [data, brush, brushStart, brushEnd]);

  const handleMouseMove = useCallback(
    (state: {
      isTooltipActive?: boolean;
      activeLabel?: string | number;
    } | null) => {
      if (!syncEnabled || !onCursorS) return;
      if (!state?.isTooltipActive) return;
      const s_km = Number(state.activeLabel);
      if (!Number.isFinite(s_km)) return;
      onCursorS(s_km * 1000);
    },
    [syncEnabled, onCursorS]
  );

  const applyBrushRange = useCallback(
    (range: { startIndex?: number; endIndex?: number } | null) => {
      if (
        !range ||
        range.startIndex == null ||
        range.endIndex == null ||
        data.length === 0
      ) {
        return;
      }
      const start = Math.min(range.startIndex, range.endIndex);
      const end = Math.max(range.startIndex, range.endIndex);
      setBrush({ start, end });

      const a = data[start];
      const b = data[end];
      if (!a || !b || !onBrushRangeS) return;

      const fullSpan = start <= 0 && end >= data.length - 1;
      if (fullSpan) {
        if (hadSelectionRef.current) return;
        onBrushRangeS(null);
        return;
      }
      hadSelectionRef.current = true;
      onBrushRangeS({ s0: a.s_m, s1: b.s_m });
    },
    [data, onBrushRangeS]
  );

  const clearPortion = useCallback(() => {
    hadSelectionRef.current = false;
    setBrush(null);
    onBrushRangeS?.(null);
  }, [onBrushRangeS]);

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Enveloppe de vitesse V(s)
        </h3>
        <div className="flex items-center gap-2 text-[10px] text-slate-400">
          {portionLabel && (
            <span className="rounded bg-amber-50 px-1.5 py-0.5 font-semibold text-amber-800 ring-1 ring-amber-200">
              Portion {portionLabel}
            </span>
          )}
          {portionLabel && (
            <button
              type="button"
              onClick={clearPortion}
              className="font-semibold text-slate-500 underline hover:text-slate-800"
            >
              Tout le trajet
            </button>
          )}
          <span>
            {syncEnabled ? "hover syncs map · " : ""}
            curseurs = portion
          </span>
        </div>
      </div>
      <div className={`w-full ${tall ? "h-64" : "h-48"}`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            margin={{ top: 4, right: 8, left: -8, bottom: 0 }}
            onClick={(state) => {
              if (!onInspectS) return;
              const label = state?.activeLabel;
              if (label == null) return;
              const s_km = Number(label);
              if (Number.isFinite(s_km)) {
                const s_m = s_km * 1000;
                onInspectS(s_m);
                if (syncEnabled) onCursorS?.(s_m);
              }
            }}
            onMouseMove={handleMouseMove}
            onMouseLeave={() => {
              if (syncEnabled) onCursorS?.(null);
            }}
            style={{
              cursor: onInspectS || syncEnabled ? "crosshair" : undefined,
            }}
          >
            <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
            <XAxis
              dataKey="s_km"
              type="number"
              domain={["dataMin", "dataMax"]}
              allowDataOverflow
              tick={{ fontSize: 10, fill: "#64748b" }}
              tickFormatter={(v: number) => v.toFixed(1)}
              label={{
                value: "s (km)",
                position: "insideBottom",
                offset: -2,
                style: { fontSize: 10, fill: "#94a3b8" },
              }}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "#64748b" }}
              tickFormatter={(v: number) => `${Math.round(v)}`}
              width={40}
              domain={yDomain}
              allowDataOverflow
              unit=" km/h"
            />
            <Tooltip
              contentStyle={{
                fontSize: 11,
                borderRadius: 6,
                border: "1px solid #e2e8f0",
              }}
              formatter={(value, name) => [
                typeof value === "number" ? `${Math.round(value)} km/h` : "—",
                String(name),
              ]}
              labelFormatter={(label, payload) => {
                const row = payload?.[0]?.payload as Row | undefined;
                const bind = row?.binder ? ` · borne par ${row.binder}` : "";
                return `s = ${Number(label).toFixed(2)} km${bind}`;
              }}
            />
            {hasDecomp && (
              <Legend
                wrapperStyle={{ fontSize: 10, paddingTop: 2 }}
                iconSize={8}
              />
            )}
            {corridor.S_feux.map((s, i) => (
              <ReferenceLine
                key={`feu-ref-${i}`}
                x={s / 1000}
                stroke="#dc2626"
                strokeDasharray="3 3"
                strokeWidth={1.25}
                label={
                  tall
                    ? {
                        value: `F${i + 1}`,
                        position: "insideTopRight",
                        fill: "#dc2626",
                        fontSize: 9,
                      }
                    : undefined
                }
              />
            ))}
            {highlightS != null && (
              <ReferenceLine
                x={highlightS / 1000}
                stroke="#2563eb"
                strokeWidth={1.5}
              />
            )}
            <Area
              type="stepAfter"
              dataKey="envelope_kmh"
              name="V enveloppe (min)"
              stroke="#2563eb"
              fill="#2563eb"
              fillOpacity={0.12}
              strokeWidth={2}
              isAnimationActive={false}
            />
            {showDesired && (
              <Line
                type="stepAfter"
                dataKey="desired_kmh"
                name="V désirée (conducteur)"
                stroke="#059669"
                strokeWidth={2}
                strokeDasharray="6 3"
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            )}
            {SERIES.map((s) => {
              if (!data.some((r) => r[s.key] != null)) return null;
              const active = envelopeMask ? envelopeMask[s.maskKey] : true;
              // Hide unchecked series entirely so Y stays readable
              if (!active) return null;
              return (
                <Line
                  key={s.key}
                  type="stepAfter"
                  dataKey={s.key}
                  name={s.name}
                  stroke={s.stroke}
                  strokeWidth={1.25}
                  strokeDasharray={s.key === "curve_kmh" ? "4 3" : undefined}
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              );
            })}
            <Brush
              dataKey="s_km"
              height={28}
              stroke="#f59e0b"
              fill="#fffbeb"
              travellerWidth={14}
              startIndex={brushStart}
              endIndex={brushEnd}
              onChange={applyBrushRange}
              onDragEnd={applyBrushRange}
              tickFormatter={(v: number) =>
                typeof v === "number" ? v.toFixed(1) : String(v)
              }
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[10px] leading-snug text-slate-400">
        Poignées ambre : portion du trajet (zoom graphique + carte). Axe Y
        auto selon sources cochées et portion visible. « Virage » = confort
        √(a_y·R). Trait vert = V désirée (enveloppe × V factor, plafonnée
        Vmax) — se met à jour live avec le panneau conducteur.
      </p>
    </div>
  );
}
