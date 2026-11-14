"use client";

/**
 * Preview: speed limits vs time, assuming free-flow along V_envelope
 * (dt = ds / V). Not the IDM trajectory — live constraint impact before sim.
 */

import { useMemo } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SpatialCorridor } from "@/lib/types";
import type { EnvelopeMask } from "@/lib/corridorEdit";
import { snapPostedSpeedKmh } from "@/lib/cycleMetrics";

type Props = {
  corridor: SpatialCorridor;
  envelopeMask?: EnvelopeMask;
  maxSpeedKmh?: number | null;
  speedFactor?: number;
  tall?: boolean;
};

type Row = {
  t_min: number;
  envelope_kmh: number;
  desired_kmh: number | null;
  legal_kmh: number | null;
  traffic_kmh: number | null;
  curve_kmh: number | null;
};

function mpsToKmh(v: number | undefined | null): number | null {
  if (v == null || !Number.isFinite(v) || v <= 0) return null;
  const kmh = v * 3.6;
  if (kmh > 160) return null;
  return kmh;
}

function buildRows(
  corridor: SpatialCorridor,
  speedFactor?: number,
  maxSpeedKmh?: number | null
): Row[] {
  const envSrc =
    corridor.V_envelope?.length === corridor.S.length
      ? corridor.V_envelope
      : corridor.V_limite;
  const n = Math.min(corridor.S.length, envSrc.length);
  if (n < 2) return [];

  const legal = corridor.V_limite_legal ?? [];
  const traffic = corridor.V_traffic ?? [];
  const curve = corridor.V_curve ?? [];
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
  let t = 0;

  const pushAt = (i: number) => {
    const envelope_kmh = envSrc[i] * 3.6;
    const legal_kmh =
      legal.length === n
        ? (() => {
            const raw = mpsToKmh(legal[i]);
            return raw == null ? null : snapPostedSpeedKmh(raw);
          })()
        : null;
    const traffic_kmh = traffic.length === n ? mpsToKmh(traffic[i]) : null;
    const curve_kmh = curve.length === n ? mpsToKmh(curve[i]) : null;
    let desired_kmh: number | null = null;
    if (sf != null) {
      desired_kmh = envelope_kmh * sf;
      if (vmax != null) desired_kmh = Math.min(desired_kmh, vmax);
    }
    rows.push({
      t_min: t / 60,
      envelope_kmh,
      desired_kmh,
      legal_kmh,
      traffic_kmh,
      curve_kmh,
    });
  };

  pushAt(0);
  for (let i = 1; i < n; i++) {
    const ds = Math.max(0, corridor.S[i] - corridor.S[i - 1]);
    const v = Math.max(envSrc[i - 1], 0.5);
    t += ds / v;
    if (i % step === 0 || i === n - 1) pushAt(i);
  }
  return rows;
}

export default function SpeedEnvelopeTimeChart({
  corridor,
  envelopeMask,
  maxSpeedKmh,
  speedFactor,
  tall = false,
}: Props) {
  const data = useMemo(
    () => buildRows(corridor, speedFactor, maxSpeedKmh),
    [corridor, speedFactor, maxSpeedKmh]
  );

  const useLegal = !envelopeMask || envelopeMask.legal;
  const useTraffic = !envelopeMask || envelopeMask.traffic;
  const useCurve = !envelopeMask || envelopeMask.curve;

  if (data.length < 2) {
    return (
      <p className="rounded-md border border-dashed border-slate-200 px-3 py-2 text-[11px] text-slate-500">
        Profil temporel disponible après construction du corridor.
      </p>
    );
  }

  const tMax = data[data.length - 1]?.t_min ?? 1;
  const yVals = data.flatMap((r) => {
    const out = [r.envelope_kmh];
    if (r.desired_kmh != null) out.push(r.desired_kmh);
    if (useLegal && r.legal_kmh != null) out.push(r.legal_kmh);
    if (useTraffic && r.traffic_kmh != null) out.push(r.traffic_kmh);
    if (useCurve && r.curve_kmh != null && r.curve_kmh < 160) out.push(r.curve_kmh);
    return out;
  });
  const yMax = Math.max(50, Math.ceil((Math.max(...yVals, 10) * 1.1) / 5) * 5);

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Vitesse vs temps (aperçu)
        </h3>
        <span className="text-[10px] text-slate-400">
          free-flow sur V_env · {tMax.toFixed(1)} min
        </span>
      </div>
      <p className="text-[10px] leading-snug text-slate-500">
        Estimation t(s) = ∫ ds/V_envelope — pas encore le cycle IDM. Sert à
        comparer les limites dans le temps avant simulation.
      </p>
      <div className={tall ? "h-56" : "h-44"}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              dataKey="t_min"
              type="number"
              domain={[0, "auto"]}
              tick={{ fontSize: 10 }}
              tickFormatter={(v) => `${Number(v).toFixed(0)}`}
              label={{
                value: "t (min)",
                position: "insideBottomRight",
                offset: -2,
                fontSize: 10,
                fill: "#94a3b8",
              }}
            />
            <YAxis
              domain={[0, yMax]}
              tick={{ fontSize: 10 }}
              width={36}
              label={{
                value: "km/h",
                angle: -90,
                position: "insideLeft",
                fontSize: 10,
                fill: "#94a3b8",
              }}
            />
            <Tooltip
              contentStyle={{ fontSize: 11 }}
              formatter={(value) =>
                typeof value === "number"
                  ? [`${value.toFixed(1)} km/h`, ""]
                  : [String(value ?? ""), ""]
              }
              labelFormatter={(label) => `t = ${Number(label).toFixed(2)} min`}
            />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            <Line
              type="monotone"
              dataKey="envelope_kmh"
              name="V enveloppe"
              stroke="#0f172a"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            {speedFactor != null ? (
              <Line
                type="monotone"
                dataKey="desired_kmh"
                name="V désirée"
                stroke="#16a34a"
                strokeWidth={1.5}
                strokeDasharray="4 3"
                dot={false}
                isAnimationActive={false}
              />
            ) : null}
            {useLegal ? (
              <Line
                type="stepAfter"
                dataKey="legal_kmh"
                name="V légal"
                stroke="#64748b"
                strokeWidth={1.25}
                dot={false}
                isAnimationActive={false}
              />
            ) : null}
            {useTraffic ? (
              <Line
                type="monotone"
                dataKey="traffic_kmh"
                name="V trafic"
                stroke="#ea580c"
                strokeWidth={1.25}
                dot={false}
                isAnimationActive={false}
              />
            ) : null}
            {useCurve ? (
              <Line
                type="monotone"
                dataKey="curve_kmh"
                name="V virage"
                stroke="#7c3aed"
                strokeWidth={1.25}
                dot={false}
                isAnimationActive={false}
              />
            ) : null}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
