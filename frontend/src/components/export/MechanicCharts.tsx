"use client";

/**
 * @deprecated Mini mechanic grid replaced by ResultsAnalyseStudio spark strip + focus.
 * Kept for FinalProfilesPanel legacy path only.
 */

import { useMemo, useState } from "react";
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
import type { ConsolidatedProfile, SpatialCorridor } from "@/lib/types";
import type { VehicleCard } from "@/lib/vehicleLibrary";
import {
  lateralAccelApprox,
  mechanicalPowerSample,
} from "@/lib/vehiclePower";
import { slopeFromRad, type SlopeUnit } from "@/lib/units";
import SlopeUnitToggle from "@/components/SlopeUnitToggle";

type XMode = "time" | "distance";

type Row = {
  x: number;
  t: number;
  s: number;
  v_kmh: number;
  a_lon: number;
  a_lat: number;
  slope: number;
  p_trac_kw: number;
  p_regen_kw: number;
  p_wheel_kw: number;
  wheel_torque_nm: number;
  wheel_rpm: number;
};

function sampleVcurve(corridor: SpatialCorridor | null, s: number): number | null {
  const S = corridor?.S;
  const Vc = corridor?.V_curve;
  if (!S?.length || !Vc?.length) return null;
  if (s <= S[0]) return Vc[0];
  if (s >= S[S.length - 1]) return Vc[Vc.length - 1];
  let lo = 0;
  let hi = S.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (S[mid] <= s) lo = mid;
    else hi = mid;
  }
  const ds = S[hi] - S[lo];
  if (ds < 1e-9) return Vc[lo];
  const u = (s - S[lo]) / ds;
  return Vc[lo] + u * (Vc[hi] - Vc[lo]);
}

function Mini({
  data,
  yKey,
  color,
  label,
  unit,
  xMode,
  xDomain,
  window,
  onExpand,
}: {
  data: Row[];
  yKey: keyof Row;
  color: string;
  label: string;
  unit: string;
  xMode: XMode;
  xDomain: [number, number];
  window: { x0: number; x1: number } | null;
  onExpand?: () => void;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-baseline justify-between px-0.5">
        <button
          type="button"
          onClick={onExpand}
          disabled={!onExpand}
          className={`text-[10px] font-semibold uppercase tracking-wide text-slate-500 ${
            onExpand ? "hover:text-brand" : ""
          }`}
          title={onExpand ? "Agrandir" : undefined}
        >
          {label}
          {onExpand && (
            <span className="ml-1 text-[9px] font-normal normal-case text-brand">
              →
            </span>
          )}
        </button>
        <span className="text-[9px] text-slate-400">{unit}</span>
      </div>
      <div
        className={`h-20 w-full ${onExpand ? "cursor-pointer" : ""}`}
        onDoubleClick={onExpand}
        title={onExpand ? "Double-clic pour agrandir" : undefined}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              dataKey="x"
              type="number"
              domain={xDomain}
              tick={{ fontSize: 9, fill: "#94a3b8" }}
              tickFormatter={(v) => {
                const n = Number(v);
                if (xMode === "time") return `${Math.round(n)} s`;
                if (n >= 1000) return `${(n / 1000).toFixed(1)} km`;
                return `${Math.round(n)} m`;
              }}
            />
            <YAxis
              width={40}
              tick={{ fontSize: 9, fill: "#94a3b8" }}
              tickFormatter={(v) => Number(v).toFixed(1)}
            />
            <Tooltip
              contentStyle={{ fontSize: 11 }}
              formatter={(v) => [
                typeof v === "number"
                  ? `${v.toFixed(2)} ${unit}`
                  : String(v ?? ""),
                label,
              ]}
              labelFormatter={(x) => {
                const n = Number(x);
                if (xMode === "time") return `t = ${n.toFixed(1)} s`;
                if (n >= 1000) return `s = ${(n / 1000).toFixed(2)} km`;
                return `s = ${n.toFixed(0)} m`;
              }}
            />
            {window && (
              <ReferenceArea
                x1={window.x0}
                x2={window.x1}
                fill="#0ea5e9"
                fillOpacity={0.08}
                strokeOpacity={0}
              />
            )}
            {window && (
              <ReferenceLine x={(window.x0 + window.x1) / 2} stroke="#0f172a" strokeDasharray="3 3" />
            )}
            <Line
              type="monotone"
              dataKey={yKey as string}
              stroke={color}
              dot={false}
              strokeWidth={1.5}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export type MechanicChartsProps = {
  profile: ConsolidatedProfile;
  vehicle: VehicleCard | null;
  corridor?: SpatialCorridor | null;
  aY?: number;
  slopeUnit?: SlopeUnit;
  onSlopeUnitChange?: (u: SlopeUnit) => void;
  onExpandChart?: (
    series:
      | "a_lon"
      | "a_lat"
      | "slope"
      | "p_trac_kw"
      | "p_regen_kw"
      | "p_wheel_kw"
      | "wheel_torque_nm"
      | "wheel_rpm"
  ) => void;
  /**
   * `vehicle_power`: only P/couple/traction/regen from vehicle road-load
   * (no fake a_lat / corridor-dependent series). Used for sans-GPS bases.
   */
  mode?: "full" | "vehicle_power";
};

export default function MechanicCharts({
  profile,
  vehicle,
  corridor = null,
  aY = 3,
  slopeUnit = "percent",
  onSlopeUnitChange,
  onExpandChart,
  mode = "full",
}: MechanicChartsProps) {
  const [xMode, setXMode] = useState<XMode>("time");
  const [windowWidth, setWindowWidth] = useState(30);
  const [cursorX, setCursorX] = useState<number | null>(null);

  const rows = useMemo(() => {
    const n = Math.min(
      profile.time.length,
      profile.velocity.length,
      profile.position.length
    );
    const out: Row[] = [];
    for (let i = 0; i < n; i++) {
      const t = profile.time[i];
      const s = profile.position[i] ?? 0;
      const v = profile.velocity[i] ?? 0;
      const a =
        profile.acceleration?.[i] ??
        (i > 0
          ? (v - (profile.velocity[i - 1] ?? 0)) /
            Math.max(1e-3, t - profile.time[i - 1])
          : 0);
      const alpha = profile.slope?.[i] ?? 0;
      const vc = sampleVcurve(corridor, s);
      const a_lat = lateralAccelApprox(v, vc, aY);
      const pow = vehicle
        ? mechanicalPowerSample({
            v_mps: v,
            a_lon_mps2: a,
            alpha_rad: alpha,
            vehicle,
          })
        : null;
      out.push({
        x: xMode === "time" ? t : s,
        t,
        s,
        v_kmh: v * 3.6,
        a_lon: a,
        a_lat,
        slope: slopeFromRad(alpha, slopeUnit),
        p_trac_kw: pow?.p_trac_kw ?? 0,
        p_regen_kw: pow?.p_regen_kw ?? 0,
        p_wheel_kw: pow ? pow.p_mech_w / 1000 : 0,
        wheel_torque_nm: pow?.wheel_torque_nm ?? 0,
        wheel_rpm: pow?.wheel_rpm ?? 0,
      });
    }
    // Downsample for chart perf
    if (out.length <= 900) return out;
    const step = Math.ceil(out.length / 800);
    return out.filter((_, i) => i % step === 0 || i === out.length - 1);
  }, [profile, corridor, vehicle, aY, xMode, slopeUnit]);

  const xDomain = useMemo((): [number, number] => {
    if (!rows.length) return [0, 1];
    return [rows[0].x, rows[rows.length - 1].x];
  }, [rows]);

  const effectiveCursor =
    cursorX != null
      ? cursorX
      : rows.length
        ? (xDomain[0] + xDomain[1]) / 2
        : null;

  const window = useMemo(() => {
    if (effectiveCursor == null || !(windowWidth > 0)) return null;
    const half = windowWidth / 2;
    const x0 = Math.max(xDomain[0], effectiveCursor - half);
    const x1 = Math.min(xDomain[1], effectiveCursor + half);
    return { x0, x1 };
  }, [effectiveCursor, windowWidth, xDomain]);

  if (rows.length < 2) return null;

  return (
    <section className="space-y-3 border-t border-slate-100 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {mode === "vehicle_power"
            ? "Puissance / couple véhicule"
            : "Mécanique véhicule"}
        </h3>
        <div className="flex rounded-md border border-slate-200 p-0.5">
          {(
            [
              ["time", "Temps"],
              ["distance", "Distance"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setXMode(id);
                setCursorX(null);
                setWindowWidth(id === "time" ? 30 : 200);
              }}
              className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                xMode === id
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {onSlopeUnitChange && mode === "full" && (
          <SlopeUnitToggle value={slopeUnit} onChange={onSlopeUnitChange} />
        )}
        <label className="ml-auto flex items-center gap-1 text-[10px] text-slate-600">
          Fenêtre
          <input
            type="number"
            min={5}
            max={xMode === "time" ? 600 : 5000}
            step={xMode === "time" ? 5 : 50}
            value={windowWidth}
            onChange={(e) =>
              setWindowWidth(Math.max(1, Number(e.target.value) || 30))
            }
            className="w-14 rounded border border-slate-200 px-1 py-0.5 tabular-nums"
          />
          {xMode === "time" ? "s" : "m"}
        </label>
      </div>
      <p className="text-[10px] text-slate-400">
        {vehicle
          ? `${vehicle.code} · m=${Math.round(vehicle.mass_kg)} kg · F0=${vehicle.f0_n.toFixed(1)} N · F1=${vehicle.f1_n_per_kph.toFixed(3)} N/(km/h) · F2=${vehicle.f2_n_per_kph2.toFixed(4)} N/(km/h)² · r_dyn=${vehicle.r_dyn_m.toFixed(3)} m`
          : "Sélectionnez un véhicule (étape 3) pour P / couple aux roues (F0·F1·F2, r_dyn)."}
      </p>
      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
        {mode === "full" && (
          <>
            <Mini
              data={rows}
              yKey="a_lon"
              color="#f59e0b"
              label="Accel. longitudinale"
              unit="m/s²"
              xMode={xMode}
              xDomain={xDomain}
              window={window}
              onExpand={
                onExpandChart ? () => onExpandChart("a_lon") : undefined
              }
            />
            <Mini
              data={rows}
              yKey="a_lat"
              color="#a855f7"
              label="Accel. latérale (approx.)"
              unit="m/s²"
              xMode={xMode}
              xDomain={xDomain}
              window={window}
              onExpand={
                onExpandChart ? () => onExpandChart("a_lat") : undefined
              }
            />
            <Mini
              data={rows}
              yKey="slope"
              color="#16a34a"
              label="Pente"
              unit={slopeUnit === "percent" ? "%" : slopeUnit}
              xMode={xMode}
              xDomain={xDomain}
              window={window}
              onExpand={
                onExpandChart ? () => onExpandChart("slope") : undefined
              }
            />
          </>
        )}
        {vehicle && (
          <>
            <Mini
              data={rows}
              yKey="wheel_torque_nm"
              color="#7c3aed"
              label="Couple à la roue"
              unit="N·m"
              xMode={xMode}
              xDomain={xDomain}
              window={window}
              onExpand={
                onExpandChart
                  ? () => onExpandChart("wheel_torque_nm")
                  : undefined
              }
            />
            <Mini
              data={rows}
              yKey="p_wheel_kw"
              color="#0ea5e9"
              label="Puissance mécanique"
              unit="kW"
              xMode={xMode}
              xDomain={xDomain}
              window={window}
              onExpand={
                onExpandChart ? () => onExpandChart("p_wheel_kw") : undefined
              }
            />
            <Mini
              data={rows}
              yKey="p_trac_kw"
              color="#2563eb"
              label="Puissance traction"
              unit="kW"
              xMode={xMode}
              xDomain={xDomain}
              window={window}
              onExpand={
                onExpandChart ? () => onExpandChart("p_trac_kw") : undefined
              }
            />
            <Mini
              data={rows}
              yKey="p_regen_kw"
              color="#059669"
              label="Puissance freinage |P|"
              unit="kW"
              xMode={xMode}
              xDomain={xDomain}
              window={window}
              onExpand={
                onExpandChart ? () => onExpandChart("p_regen_kw") : undefined
              }
            />
          </>
        )}
      </div>
      <label className="flex items-center gap-2 text-[10px] text-slate-600">
        Centre fenêtre
        <input
          type="range"
          min={xDomain[0]}
          max={xDomain[1]}
          step={(xDomain[1] - xDomain[0]) / 200 || 1}
          value={effectiveCursor ?? xDomain[0]}
          onChange={(e) => setCursorX(Number(e.target.value))}
          className="flex-1"
        />
      </label>
    </section>
  );
}
