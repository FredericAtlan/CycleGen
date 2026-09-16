"use client";

import { useMemo, useState } from "react";
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
import {
  ApiError,
  analyzeRoute,
  buildCorridor,
  runScenario,
} from "@/lib/api";
import { TIME_X_AXIS_PROPS, formatTimeLabel } from "@/lib/chartTime";
import type { DriverPhysics } from "@/lib/driverPresets";
import {
  compareModeById,
  computeClientProfileKpis,
  type ClientProfileKpis,
  type CompareMode,
} from "@/lib/scenarios";
import type {
  ConsolidatedProfile,
  DriverProfile,
  LatLon,
  RoutingProfile,
  ScenarioArmRequest,
  SpatialCorridor,
  WaypointDraft,
} from "@/lib/types";

const SEED = 42;
const COLORS = ["#059669", "#2563eb", "#dc2626", "#7c3aed", "#ca8a04"];

export type VariantComparePanelProps = {
  mode: CompareMode;
  corridor: SpatialCorridor | null;
  pointA: LatLon | null;
  pointB: LatLon | null;
  waypoints?: WaypointDraft[];
  departureLabel: string;
  destinationLabel: string;
  routingProfile: RoutingProfile;
  aY: number;
  driverProfile: DriverProfile;
  physics: DriverPhysics;
  maxSpeedKmh: number | null;
  peakDepartAt: string;
  nightDepartAt: string;
  onFocusWarnings?: () => void;
};

type RunRow = {
  id: string;
  label: string;
  profile: ConsolidatedProfile;
  kpis: ClientProfileKpis;
};

function toIso(local: string): string {
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

function interp(xs: number[], ys: number[], x: number): number {
  if (!xs.length) return 0;
  if (x <= xs[0]) return ys[0] ?? 0;
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1] ?? 0;
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const x0 = xs[lo];
  const x1 = xs[hi];
  const y0 = ys[lo] ?? 0;
  const y1 = ys[hi] ?? 0;
  if (x1 <= x0) return y0;
  const u = (x - x0) / (x1 - x0);
  return y0 + u * (y1 - y0);
}

function buildOverlay(rows: RunRow[]) {
  if (!rows.length) return [] as Record<string, number>[];
  const tMax = Math.min(
    ...rows.map((r) => r.profile.time[r.profile.time.length - 1] ?? 0)
  );
  const out: Record<string, number>[] = [];
  for (let t = 0; t <= Math.floor(tMax); t += 1) {
    const row: Record<string, number> = { t };
    rows.forEach((r, i) => {
      row[`v_${i}`] =
        interp(r.profile.time, r.profile.velocity, t) * 3.6;
    });
    out.push(row);
  }
  return out;
}

function physicsParams(physics: DriverPhysics) {
  return {
    a_max: physics.a_max,
    b_comf: physics.b_comf,
    speed_factor: physics.speed_factor,
    T: physics.T,
    T_h: physics.T_h,
    s0: physics.s0,
    jerk_max: physics.jerk_max,
    jerk_brake_max: physics.jerk_brake_max,
  };
}

export default function VariantComparePanel({
  mode,
  corridor,
  pointA,
  pointB,
  waypoints = [],
  departureLabel,
  destinationLabel,
  routingProfile,
  aY,
  driverProfile,
  physics,
  maxSpeedKmh,
  peakDepartAt,
  nightDepartAt,
  onFocusWarnings,
}: VariantComparePanelProps) {
  const def = compareModeById(mode);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<RunRow[]>([]);

  const chartData = useMemo(() => buildOverlay(rows), [rows]);
  const canRun =
    mode !== "off" &&
    (def.needsCorridor
      ? !!corridor?.S?.length
      : !!(pointA || departureLabel.trim()) &&
        !!(pointB || destinationLabel.trim()));

  const runBatch = async (arms: ScenarioArmRequest[], corr: SpatialCorridor) => {
    const res = await runScenario({
      corridor: corr,
      arms,
      reference_arm_id: arms[0]?.id,
    });
    return res.arms.map((a) => ({
      id: a.id,
      label: a.label || a.id,
      profile: a.profile,
      kpis: {
        duration_s: a.kpis.duration_s,
        mean_speed_kmh: a.kpis.mean_speed_kmh,
        stops: a.kpis.stops,
        rpa: a.kpis.rpa,
      },
    }));
  };

  const handleRun = async () => {
    setBusy(true);
    setError(null);
    setRows([]);
    try {
      if (mode === "peak_night") {
        const slots = [
          { id: "peak", label: "Pointe", depart: toIso(peakDepartAt) },
          { id: "night", label: "Nuit", depart: toIso(nightDepartAt) },
        ];
        const out: RunRow[] = [];
        for (const slot of slots) {
          setStatus(`${slot.label} — analyse…`);
          const route = await analyzeRoute({
            latA: pointA?.lat ?? null,
            lonA: pointA?.lon ?? null,
            latB: pointB?.lat ?? null,
            lonB: pointB?.lon ?? null,
            addressA: pointA ? null : departureLabel.trim() || null,
            addressB: pointB ? null : destinationLabel.trim() || null,
            waypoints: waypoints
              .filter((w) => w.lat != null && w.lon != null)
              .map((w) => ({ lat: w.lat as number, lon: w.lon as number })),
            routingProfile,
            departAt: slot.depart,
            aY,
          });
          setStatus(`${slot.label} — cycle…`);
          const built = await buildCorridor(route, { aY });
          setStatus(`${slot.label} — IDM…`);
          const batch = await runBatch(
            [
              {
                id: slot.id,
                label: slot.label,
                driver_profile: driverProfile,
                seed: SEED,
                tls_override: "auto",
                max_speed_kmh: maxSpeedKmh,
                driver_params: physicsParams(physics),
              },
            ],
            built.corridor
          );
          out.push(...batch);
        }
        setRows(out);
      } else {
        if (!corridor?.S?.length) {
          throw new Error("Cycle requis — Analysez la route d’abord.");
        }
        let arms: ScenarioArmRequest[] = [];
        if (mode === "drivers") {
          arms = (
            ["Eco", "Normal", "Agressif", "Sportif"] as DriverProfile[]
          ).map((p) => ({
              id: p,
              label: p,
              driver_profile: p,
              seed: SEED,
              tls_override: "auto",
              max_speed_kmh: maxSpeedKmh,
            })
          );
        } else if (mode === "tls") {
          arms = [
            {
              id: "green_wave",
              label: "Onde verte",
              driver_profile: driverProfile,
              seed: SEED,
              tls_override: "green_wave",
              max_speed_kmh: maxSpeedKmh,
              driver_params: physicsParams(physics),
            },
            {
              id: "stochastic",
              label: "Stochastique",
              driver_profile: driverProfile,
              seed: SEED,
              tls_override: "stochastic",
              max_speed_kmh: maxSpeedKmh,
              driver_params: physicsParams(physics),
            },
          ];
        } else if (mode === "seeds") {
          arms = [1, 2, 3].map((s) => ({
            id: `seed${s}`,
            label: `Seed ${s}`,
            driver_profile: "Normal",
            seed: s,
            tls_override: "auto",
            max_speed_kmh: maxSpeedKmh,
          }));
        } else if (mode === "speed_cap") {
          arms = [
            {
              id: "cap90",
              label: "90 km/h",
              driver_profile: driverProfile,
              seed: SEED,
              tls_override: "auto",
              max_speed_kmh: 90,
              driver_params: physicsParams(physics),
            },
            {
              id: "cap130",
              label: "130 km/h",
              driver_profile: driverProfile,
              seed: SEED,
              tls_override: "auto",
              max_speed_kmh: 130,
              driver_params: physicsParams(physics),
            },
          ];
        }
        setStatus(`Batch ${arms.length} bras…`);
        setRows(await runBatch(arms, corridor));
      }
      setStatus(null);
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Comparaison échouée"
      );
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  if (mode === "off") return null;

  return (
    <div className="space-y-3 rounded-md border border-slate-200 bg-white p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Comparer des variantes
          </h3>
          <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
            {def.hint}
          </p>
        </div>
        <button
          type="button"
          disabled={!canRun || busy}
          onClick={() => void handleRun()}
          className="shrink-0 rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-dark disabled:opacity-40"
        >
          {busy ? "…" : "Lancer"}
        </button>
      </div>

      {!canRun && (
        <p className="text-[11px] text-amber-700">
          {def.needsCorridor
            ? "Cycle requis (Analyze Route)."
            : "Renseignez départ et arrivée."}
        </p>
      )}
      {status && (
        <p className="text-[11px] text-slate-500">{status}</p>
      )}
      {error && (
        <p className="text-[11px] text-red-600">{error}</p>
      )}

      {rows.length >= 2 && (
        <>
          <div className="h-44 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis
                  dataKey="t"
                  {...TIME_X_AXIS_PROPS}
                  tick={{ fontSize: 9 }}
                />
                <YAxis tick={{ fontSize: 9 }} unit=" km/h" width={36} />
                <Tooltip
                  contentStyle={{ fontSize: 11 }}
                  labelFormatter={(l) => formatTimeLabel(Number(l))}
                />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                {rows.map((r, i) => (
                  <Line
                    key={r.id}
                    type="monotone"
                    dataKey={`v_${i}`}
                    name={r.label}
                    stroke={COLORS[i % COLORS.length]}
                    dot={false}
                    strokeWidth={2}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-[11px]">
              <thead>
                <tr className="border-b border-slate-100 text-slate-500">
                  <th className="py-1 pr-2 font-medium">Variante</th>
                  <th className="py-1 pr-2 font-medium">Durée</th>
                  <th className="py-1 pr-2 font-medium">v̄</th>
                  <th className="py-1 pr-2 font-medium">Stops</th>
                  <th className="py-1 font-medium">RPA</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-50">
                    <td className="py-1 pr-2 font-semibold text-slate-800">
                      {r.label}
                    </td>
                    <td className="py-1 pr-2 tabular-nums">
                      {Math.round(r.kpis.duration_s)} s
                    </td>
                    <td className="py-1 pr-2 tabular-nums">
                      {r.kpis.mean_speed_kmh.toFixed(1)} km/h
                    </td>
                    <td className="py-1 pr-2 tabular-nums">{r.kpis.stops}</td>
                    <td className="py-1 tabular-nums">
                      {r.kpis.rpa.toFixed(3)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {onFocusWarnings && (
        <button
          type="button"
          onClick={onFocusWarnings}
          className="text-[11px] font-medium text-brand hover:underline"
        >
          Voir imputations / warnings (scénario E)
        </button>
      )}
    </div>
  );
}
