"use client";

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
import type { LivePoint } from "@/components/simulation/LiveCharts";
import SimProgress from "@/components/simulation/SimProgress";
import TrafficLightsEditor from "@/components/corridor/TrafficLightsEditor";
import { withUpdatedFeux } from "@/lib/corridorEdit";
import type { SpatialCorridor } from "@/lib/types";
import type { VehicleCard } from "@/lib/vehicleLibrary";
import {
  lateralAccelApprox,
  mechanicalPowerSample,
} from "@/lib/vehiclePower";
import { slopeFromRad, type SlopeUnit } from "@/lib/units";
import SlopeUnitToggle from "@/components/SlopeUnitToggle";

export type LiveAnalysisPanelProps = {
  series: LivePoint[];
  simT: number;
  simS: number;
  totalS: number;
  corridor: SpatialCorridor | null;
  onCorridorChange?: (c: SpatialCorridor) => void;
  vehicle: VehicleCard | null;
  aY: number;
  engineLabel: string;
  starting?: boolean;
  stopping?: boolean;
  error?: string | null;
  onStop?: () => void;
  slopeUnit?: SlopeUnit;
  onSlopeUnitChange?: (u: SlopeUnit) => void;
};

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
  p_mech_kw: number;
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

function MiniChart({
  data,
  xKey,
  yKey,
  color,
  label,
  unit,
  xMode,
  xDomain,
  window,
  cursorX,
}: {
  data: Row[];
  xKey: "x";
  yKey: keyof Row;
  color: string;
  label: string;
  unit: string;
  xMode: XMode;
  xDomain: [number, number];
  window: { x0: number; x1: number } | null;
  cursorX: number | null;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-baseline justify-between px-0.5">
        <h4 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          {label}
        </h4>
        <span className="text-[9px] text-slate-400">{unit}</span>
      </div>
      <div className="h-20 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 6, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              dataKey={xKey}
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
              width={36}
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
            {cursorX != null && (
              <ReferenceLine x={cursorX} stroke="#0f172a" strokeDasharray="3 3" />
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

export default function LiveAnalysisPanel({
  series,
  simT,
  simS,
  totalS,
  corridor,
  onCorridorChange,
  vehicle,
  aY,
  engineLabel,
  starting = false,
  stopping = false,
  error = null,
  onStop,
  slopeUnit = "percent",
  onSlopeUnitChange,
}: LiveAnalysisPanelProps) {
  const [xMode, setXMode] = useState<XMode>("time");
  const [windowWidth, setWindowWidth] = useState(30);
  const [selectedFeu, setSelectedFeu] = useState<number | null>(null);
  const [tlsOpen, setTlsOpen] = useState(false);

  const rows = useMemo(() => {
    const out: Row[] = [];
    let sAcc = 0;
    for (let i = 0; i < series.length; i++) {
      const p = series[i];
      const prev = series[i - 1];
      if (prev) {
        const dt = Math.max(0, p.t - prev.t);
        sAcc += 0.5 * (p.v + prev.v) * dt;
      }
      const sUse =
        p.s != null && Number.isFinite(p.s) ? p.s : Number.isFinite(sAcc) ? sAcc : 0;
      const vc = sampleVcurve(corridor, sUse);
      const a_lat = lateralAccelApprox(p.v, vc, aY);
      const pow = vehicle
        ? mechanicalPowerSample({
            v_mps: p.v,
            a_lon_mps2: p.a,
            alpha_rad: p.alpha,
            vehicle,
          })
        : null;
      out.push({
        x: xMode === "time" ? p.t : sUse,
        t: p.t,
        s: sUse,
        v_kmh: p.v * 3.6,
        a_lon: p.a,
        a_lat,
        slope: slopeFromRad(p.alpha ?? 0, slopeUnit),
        p_trac_kw: pow?.p_trac_kw ?? 0,
        p_regen_kw: pow?.p_regen_kw ?? 0,
        p_mech_kw: pow ? pow.p_mech_w / 1000 : 0,
      });
    }
    return out;
  }, [series, corridor, vehicle, aY, xMode, slopeUnit]);

  // Prefer simS from frame when available for progress / cursor
  const cursorX = useMemo(() => {
    if (!rows.length) return null;
    if (xMode === "time") return simT;
    // map simS if we have total; else last row s
    return simS > 0 ? simS : rows[rows.length - 1]?.s ?? null;
  }, [rows, xMode, simT, simS]);

  const xDomain = useMemo((): [number, number] => {
    if (!rows.length) return [0, xMode === "time" ? 60 : Math.max(totalS, 100)];
    const xmax = rows[rows.length - 1].x;
    return [0, Math.max(xmax, xMode === "time" ? 10 : 50)];
  }, [rows, xMode, totalS]);

  const window = useMemo(() => {
    if (cursorX == null || !(windowWidth > 0)) return null;
    const half = windowWidth / 2;
    const x0 = Math.max(xDomain[0], cursorX - half);
    const x1 = Math.min(xDomain[1], cursorX + half);
    return { x0, x1 };
  }, [cursorX, windowWidth, xDomain]);

  const windowStats = useMemo(() => {
    if (!window || !rows.length) return null;
    const slice = rows.filter((r) => r.x >= window.x0 && r.x <= window.x1);
    if (!slice.length) return null;
    const mean = (k: keyof Row) =>
      slice.reduce((a, r) => a + (Number(r[k]) || 0), 0) / slice.length;
    const maxP = Math.max(...slice.map((r) => r.p_trac_kw));
    const maxR = Math.max(...slice.map((r) => r.p_regen_kw));
    return {
      n: slice.length,
      v: mean("v_kmh"),
      a: mean("a_lon"),
      pTrac: maxP,
      pRegen: maxR,
    };
  }, [window, rows]);

  return (
    <aside className="flex h-full min-w-0 flex-1 flex-col border-l border-slate-200 bg-white">
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-slate-200 px-3 py-2.5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-900">
            Analyse live
          </h2>
          <p className="truncate text-[10px] text-slate-500">
            {(engineLabel || "IDM").toUpperCase()}
            {vehicle ? ` · ${vehicle.code}` : " · pas de véhicule"}
          </p>
        </div>
        {onStop && (
          <button
            type="button"
            onClick={onStop}
            disabled={stopping || starting}
            className="shrink-0 rounded-md bg-brand px-2.5 py-1 text-[10px] font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
          >
            {stopping ? "Arrêt…" : "Consolider"}
          </button>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2">
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
        {onSlopeUnitChange && (
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

      {error ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-red-600">
          {error}
        </div>
      ) : starting && series.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <span className="h-7 w-7 animate-spin rounded-full border-2 border-brand border-t-transparent" />
          <p className="text-xs text-slate-500">Démarrage simulation…</p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <div className="min-w-[12rem] flex-1">
              <SimProgress t={simT} s={simS} totalS={totalS} compact />
            </div>
            {windowStats && (
              <span className="text-[10px] tabular-nums text-slate-500">
                plage v̄{windowStats.v.toFixed(0)} km/h · ā
                {windowStats.a.toFixed(1)} m/s² · P↑
                {windowStats.pTrac.toFixed(0)} / P↓
                {windowStats.pRegen.toFixed(0)} kW
              </span>
            )}
          </div>
          {!vehicle && (
            <p className="text-[10px] text-amber-700">
              Choisissez un véhicule (étape 3) pour P traction / freinage.
            </p>
          )}
          {series.length === 0 ? (
            <p className="py-6 text-center text-xs text-slate-400">
              En attente des trames…
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
              <MiniChart
                data={rows}
                xKey="x"
                yKey="v_kmh"
                color="#0ea5e9"
                label="Vitesse"
                unit="km/h"
                xMode={xMode}
                xDomain={xDomain}
                window={window}
                cursorX={cursorX}
              />
              <MiniChart
                data={rows}
                xKey="x"
                yKey="slope"
                color="#16a34a"
                label="Pente"
                unit={slopeUnit === "percent" ? "%" : slopeUnit}
                xMode={xMode}
                xDomain={xDomain}
                window={window}
                cursorX={cursorX}
              />
              <MiniChart
                data={rows}
                xKey="x"
                yKey="a_lon"
                color="#f59e0b"
                label="Accel. longitudinale"
                unit="m/s²"
                xMode={xMode}
                xDomain={xDomain}
                window={window}
                cursorX={cursorX}
              />
              <MiniChart
                data={rows}
                xKey="x"
                yKey="a_lat"
                color="#a855f7"
                label="Accel. latérale"
                unit="m/s²"
                xMode={xMode}
                xDomain={xDomain}
                window={window}
                cursorX={cursorX}
              />
              <MiniChart
                data={rows}
                xKey="x"
                yKey="p_trac_kw"
                color="#2563eb"
                label="Puissance traction"
                unit="kW"
                xMode={xMode}
                xDomain={xDomain}
                window={window}
                cursorX={cursorX}
              />
              <MiniChart
                data={rows}
                xKey="x"
                yKey="p_regen_kw"
                color="#059669"
                label="Puissance freinage |P|"
                unit="kW"
                xMode={xMode}
                xDomain={xDomain}
                window={window}
                cursorX={cursorX}
              />
            </div>
          )}

          {corridor && onCorridorChange && (
            <div className="mt-1 border-t border-slate-100 pt-2">
              <button
                type="button"
                onClick={() => setTlsOpen((v) => !v)}
                className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-800"
              >
                {tlsOpen ? "▾" : "▸"} Feux tricolores
              </button>
              {tlsOpen && (
                <TrafficLightsEditor
                  corridor={corridor}
                  selectedIndex={selectedFeu}
                  onSelect={setSelectedFeu}
                  onChangeFeux={(S_feux) =>
                    onCorridorChange(withUpdatedFeux(corridor, S_feux))
                  }
                  onChangeCorridor={onCorridorChange}
                  onInspect={() => undefined}
                  defaultOpen
                />
              )}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
