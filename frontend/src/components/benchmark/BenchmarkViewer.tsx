"use client";

import { useEffect, useMemo, useState } from "react";
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
import { ApiError, listBenchmarkSources, runBenchmark } from "@/lib/api";
import { TIME_X_AXIS_PROPS, formatTimeLabel } from "@/lib/chartTime";
import { groupBenchmarkSources } from "@/lib/corpusGroups";
import type {
  BenchmarkAlign,
  BenchmarkRunResponse,
  BenchmarkSourceMeta,
  ConsolidatedProfile,
  LatLon,
} from "@/lib/types";

export type BenchmarkViewerProps = {
  profile: ConsolidatedProfile;
  onReferenceGeometry?: (points: LatLon[] | null) => void;
};

function KpiCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums text-slate-900">
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[10px] text-slate-500">{hint}</div>}
    </div>
  );
}

export default function BenchmarkViewer({
  profile,
  onReferenceGeometry,
}: BenchmarkViewerProps) {
  const [sources, setSources] = useState<BenchmarkSourceMeta[]>([]);
  const [selectedSource, setSelectedSource] = useState("");
  const [align, setAlign] = useState<BenchmarkAlign>("time");
  const [result, setResult] = useState<BenchmarkRunResponse | null>(null);
  const [loadingSources, setLoadingSources] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingSources(true);
    listBenchmarkSources()
      .then((data) => {
        if (cancelled) return;
        setSources(data);
        if (data.length > 0) setSelectedSource(data[0].id);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof ApiError
            ? err.message
            : "Could not load benchmark catalogue."
        );
      })
      .finally(() => {
        if (!cancelled) setLoadingSources(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      onReferenceGeometry?.(null);
    };
  }, [onReferenceGeometry]);

  const selectedMeta = sources.find((s) => s.id === selectedSource);

  const chartData = useMemo(() => {
    if (!result) return [];
    return result.times.map((t, i) => ({
      t,
      v_gen_kmh: Number(((result.v_gen[i] ?? 0) * 3.6).toFixed(2)),
      v_ref_kmh: Number(((result.v_ref[i] ?? 0) * 3.6).toFixed(2)),
    }));
  }, [result]);

  const handleRun = async () => {
    if (!selectedSource) return;
    setRunning(true);
    setError(null);
    try {
      const res = await runBenchmark({
        profile,
        referenceId: selectedSource,
        align,
      });
      setResult(res);
      if (
        res.ref_has_geo &&
        res.lat_ref &&
        res.lon_ref &&
        res.lat_ref.length === res.lon_ref.length
      ) {
        const pts: LatLon[] = res.lat_ref.map((lat, i) => ({
          lat,
          lon: res.lon_ref![i],
        }));
        onReferenceGeometry?.(pts);
      } else {
        onReferenceGeometry?.(null);
      }
    } catch (err: unknown) {
      setResult(null);
      onReferenceGeometry?.(null);
      setError(
        err instanceof ApiError ? err.message : "Benchmark run failed."
      );
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-600">
        Compare the generated cycle to a pinned reference corpus (regulatory
        proxies or GPS demos). RMSE on dissimilar routes is diagnostic only —
        use recalibration hints and distributional KPIs to retune the model.
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="min-w-0 flex-1 text-[11px] font-medium text-slate-700">
          Reference
          <select
            value={selectedSource}
            onChange={(e) => setSelectedSource(e.target.value)}
            disabled={loadingSources || sources.length === 0}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900"
          >
            {groupBenchmarkSources(sources).map((g) => (
              <optgroup key={g.family} label={g.label}>
                {g.items.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.has_geo ? " · geo" : ""} · {Math.round(s.duration_s)}s
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="text-[11px] font-medium text-slate-700">
          Align
          <select
            value={align}
            onChange={(e) => setAlign(e.target.value as BenchmarkAlign)}
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 sm:w-32"
          >
            <option value="time">Time (1 Hz)</option>
            <option value="distance">Distance</option>
          </select>
        </label>
        <button
          type="button"
          onClick={handleRun}
          disabled={running || !selectedSource}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {running ? "Computing…" : "Run analysis"}
        </button>
      </div>

      {selectedMeta && (
        <p className="text-[10px] text-slate-500">
          {selectedMeta.license}
          {selectedMeta.has_geo
            ? " — map overlay available after run."
            : " — no lat/lon (chart-only comparison)."}
        </p>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-4">
          {(result.warnings?.length ?? 0) > 0 && (
            <ul className="space-y-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
              {result.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          <div className="rounded-md border border-slate-200 bg-white p-3">
            <h3 className="mb-2 text-xs font-semibold text-slate-800">
              Speed overlay — CycleGen vs reference (km/h)
            </h3>
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} syncId="cyclegen-benchmark">
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis
                    dataKey="t"
                    {...TIME_X_AXIS_PROPS}
                    tick={{ fontSize: 10 }}
                    stroke="#94a3b8"
                  />
                  <YAxis tick={{ fontSize: 10 }} stroke="#94a3b8" unit=" km/h" />
                  <Tooltip
                    contentStyle={{
                      fontSize: 11,
                      borderRadius: 6,
                      borderColor: "#e2e8f0",
                    }}
                    labelFormatter={(label) => formatTimeLabel(Number(label))}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line
                    type="monotone"
                    dataKey="v_gen_kmh"
                    name="CycleGen"
                    stroke="#2563eb"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="v_ref_kmh"
                    name="Reference"
                    stroke="#059669"
                    strokeWidth={2}
                    strokeDasharray="4 3"
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <KpiCard
              label="RMSE speed"
              value={`${result.kpis.rmse_v.toFixed(2)} m/s`}
            />
            <KpiCard
              label="Speed bias"
              value={`${result.kpis.bias_v.toFixed(2)} m/s`}
              hint={`MAE ${result.kpis.mae_v.toFixed(2)}`}
            />
            <KpiCard
              label="Δ duration"
              value={`${result.kpis.delta_duration_s.toFixed(0)} s`}
              hint={`${result.kpis.delta_duration_pct.toFixed(1)}%`}
            />
            <KpiCard
              label="Δ distance"
              value={`${result.kpis.delta_distance_m.toFixed(0)} m`}
              hint={`${result.kpis.delta_distance_pct.toFixed(1)}%`}
            />
            <KpiCard
              label="Stops"
              value={`${result.kpis.stops_gen} vs ${result.kpis.stops_ref}`}
              hint="gen vs ref"
            />
            <KpiCard
              label="Stop time ratio"
              value={`${(result.kpis.stop_time_ratio_gen * 100).toFixed(0)}% vs ${(result.kpis.stop_time_ratio_ref * 100).toFixed(0)}%`}
            />
            <KpiCard
              label="p95 |a|"
              value={`${result.kpis.p95_abs_accel_gen.toFixed(2)} vs ${result.kpis.p95_abs_accel_ref.toFixed(2)}`}
              hint="m/s² gen vs ref"
            />
            <KpiCard
              label="mean |a|"
              value={`${result.kpis.mean_abs_accel_gen.toFixed(2)} vs ${result.kpis.mean_abs_accel_ref.toFixed(2)}`}
            />
          </div>

          {result.recalibration_hints.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
              <h4 className="text-xs font-semibold text-amber-900">
                Recalibration hints
              </h4>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-[11px] text-amber-900">
                {result.recalibration_hints.map((hint) => (
                  <li key={hint}>{hint}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
