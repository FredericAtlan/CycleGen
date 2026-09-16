"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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
import { ApiError, getBenchmarkSource, listBenchmarkSources, runBenchmark } from "@/lib/api";
import {
  formatTimeLabel,
  formatTimeTick,
  resampleUniform,
} from "@/lib/chartTime";
import { groupBenchmarkSources } from "@/lib/corpusGroups";
import {
  defaultTripName,
  deleteSavedTrip,
  listSavedTrips,
  type SavedTripSnapshot,
} from "@/lib/tripStore";
import {
  defaultCycleName,
  packCycle,
  stashCyclesForCompare,
  type SavedCycle,
} from "@/lib/cycleLibrary";
import {
  computeCycleStats,
  enrichSeriesFromGps,
} from "@/lib/cycleMetrics";
import type {
  BenchmarkAlign,
  BenchmarkRunResponse,
  BenchmarkSourceMeta,
  ConsolidatedProfile,
  LatLon,
} from "@/lib/types";

export type WorkspaceTab =
  | "current"
  | "saved"
  | "corpus"
  | "compare";

export type InjectedCycle = {
  id: string;
  name: string;
  origin: "corpus" | "saved";
  time: number[];
  velocity: number[];
  lat?: number[] | null;
  lon?: number[] | null;
};

type CycleWorkspaceBarProps = {
  profile: ConsolidatedProfile | null;
  canSave: boolean;
  departureLabel: string;
  destinationLabel: string;
  onSaveTrip: (name: string) => void;
  onLoadTrip: (trip: SavedTripSnapshot) => void;
  onOpenHelp?: () => void;
  /** Inject GPS trace + fill sidebar departure/arrival from endpoints. */
  onInjectGeometry?: (
    payload: {
      points: LatLon[] | null;
      origin?: LatLon | null;
      destination?: LatLon | null;
      originLabel?: string | null;
      destinationLabel?: string | null;
    } | null
  ) => void;
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  injected: InjectedCycle | null;
  onInjectedChange: (cycle: InjectedCycle | null) => void;
};

async function fetchCorpusSeries(referenceId: string): Promise<{
  time: number[];
  velocity: number[];
  lat?: number[] | null;
  lon?: number[] | null;
  name: string;
}> {
  const res = await getBenchmarkSource(referenceId);
  return {
    time: res.time,
    velocity: res.velocity,
    lat: res.lat,
    lon: res.lon,
    name: res.name,
  };
}

function savedFromSeries(args: {
  name: string;
  source: string;
  origin: SavedCycle["origin"];
  time: number[];
  velocity: number[];
  lat?: number[] | null;
  lon?: number[] | null;
  acceleration?: number[] | null;
  slope?: number[] | null;
  position?: number[] | null;
}): SavedCycle {
  const enriched = enrichSeriesFromGps({
    time: args.time,
    velocity: args.velocity,
    acceleration: args.acceleration,
    slope: args.slope,
    position: args.position,
    lat: args.lat,
    lon: args.lon,
  });
  const stats = computeCycleStats({
    time: args.time,
    velocity: args.velocity,
    acceleration: enriched.acceleration,
    slope: enriched.slope,
    position: enriched.position,
    a_lat: enriched.a_lat,
  });
  return packCycle({
    name: args.name,
    source: args.source,
    origin: args.origin,
    stats,
    time: args.time,
    velocity: args.velocity,
    acceleration: enriched.acceleration,
    slope: enriched.slope,
    a_lat: enriched.a_lat,
    position: enriched.position,
    geometry: enriched.geometry,
  });
}

export default function CycleWorkspaceBar({
  profile,
  canSave,
  departureLabel,
  destinationLabel,
  onSaveTrip,
  onLoadTrip,
  onOpenHelp,
  onInjectGeometry,
  activeTab,
  onTabChange,
  injected,
  onInjectedChange,
}: CycleWorkspaceBarProps) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(true);
  /** Ligne haute (contrôles) repliable — Actuel / Sauvé / Corpus */
  const [controlsOpen, setControlsOpen] = useState(true);
  const [trips, setTrips] = useState<SavedTripSnapshot[]>([]);
  const [sources, setSources] = useState<BenchmarkSourceMeta[]>([]);
  const [saveName, setSaveName] = useState("");
  const [selectedCorpus, setSelectedCorpus] = useState("");
  const [selectedSavedId, setSelectedSavedId] = useState("");
  const [viewer, setViewer] = useState<{
    name: string;
    time: number[];
    velocity: number[];
  } | null>(null);
  const [compare, setCompare] = useState<BenchmarkRunResponse | null>(null);
  const [align, setAlign] = useState<BenchmarkAlign>("time");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoverPoint, setHoverPoint] = useState<{
    t: number;
    v_gen?: number;
    v_ref?: number;
  } | null>(null);
  /** null = full trip ; otherwise visible [t0, t1] in seconds */
  const [xZoom, setXZoom] = useState<[number, number] | null>(null);
  const chartWrapRef = useRef<HTMLDivElement>(null);
  const hoverTRef = useRef<number | null>(null);

  const refreshTrips = () => setTrips(listSavedTrips());

  const previewCorpus = useCallback(async (id: string) => {
    if (!id) {
      setViewer(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const series = await fetchCorpusSeries(id);
      const meta = sources.find((s) => s.id === id);
      setViewer({
        name: meta?.name ?? series.name,
        time: series.time,
        velocity: series.velocity,
      });
      setCompare(null);
    } catch (err: unknown) {
      setError(
        err instanceof ApiError ? err.message : "Prévisualisation corpus échouée"
      );
    } finally {
      setBusy(false);
    }
  }, [sources]);

  const openCompare = useCallback(() => {
    const stash: SavedCycle[] = [];
    if (profile && profile.time.length > 1) {
      const route = [departureLabel, destinationLabel]
        .filter(Boolean)
        .join(" → ");
      stash.push(
        savedFromSeries({
          name: defaultCycleName(route || "Cycle actuel"),
          source: "CycleGen · actuel",
          origin: "cyclegen",
          time: profile.time,
          velocity: profile.velocity,
          acceleration: profile.acceleration,
          slope: profile.slope,
          position: profile.position,
        })
      );
    }
    if (injected && injected.time.length > 1) {
      stash.push(
        savedFromSeries({
          name: injected.name,
          source: injected.origin === "corpus" ? "corpus" : "référence",
          origin: injected.origin === "corpus" ? "corpus" : "import",
          time: injected.time,
          velocity: injected.velocity,
          lat: injected.lat,
          lon: injected.lon,
        })
      );
    }
    stashCyclesForCompare(stash);
    router.push("/compare");
  }, [profile, injected, departureLabel, destinationLabel, router]);

  useEffect(() => {
    refreshTrips();
    setSaveName(defaultTripName(departureLabel, destinationLabel));
  }, [departureLabel, destinationLabel, profile]);

  useEffect(() => {
    listBenchmarkSources()
      .then((s) => {
        if (!Array.isArray(s)) {
          setError("Catalogue corpus invalide (réponse API inattendue).");
          return;
        }
        setSources(s);
        if (s.length) setSelectedCorpus(s[0].id);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError
            ? err.message
            : "Impossible de charger le corpus externe."
        );
      });
  }, []);

  // Sélection corpus → viewer immédiat (plus besoin de « Prévisualiser »)
  useEffect(() => {
    if (activeTab !== "corpus" || !selectedCorpus) return;
    void previewCorpus(selectedCorpus);
  }, [activeTab, selectedCorpus, previewCorpus]);

  // Sélection sauvegarde → viewer immédiat si profil présent
  useEffect(() => {
    if (activeTab !== "saved" || !selectedSavedId) return;
    const trip = trips.find((t) => t.id === selectedSavedId);
    if (!trip?.profile) {
      setViewer(null);
      return;
    }
    setViewer({
      name: trip.name,
      time: trip.profile.time,
      velocity: trip.profile.velocity,
    });
    setCompare(null);
  }, [activeTab, selectedSavedId, trips]);

  const chartData = useMemo(() => {
    type Row = { t: number; v_gen?: number; v_ref?: number };
    let rows: Row[] = [];
    if (activeTab === "compare" && compare) {
      rows = compare.times.map((t, i) => ({
        t,
        v_gen: (compare.v_gen[i] ?? 0) * 3.6,
        v_ref: (compare.v_ref[i] ?? 0) * 3.6,
      }));
    } else if (viewer) {
      rows = viewer.time.map((t, i) => ({
        t,
        v_ref: (viewer.velocity[i] ?? 0) * 3.6,
      }));
    } else if (profile?.time?.length && profile?.velocity?.length) {
      const n = Math.min(profile.time.length, profile.velocity.length);
      for (let i = 0; i < n; i++) {
        rows.push({
          t: profile.time[i],
          v_gen: (profile.velocity[i] ?? 0) * 3.6,
        });
      }
    }
    return resampleUniform(rows, "t", { maxPoints: 500, dtPrefer: 1 });
  }, [activeTab, compare, viewer, profile]);

  const fullXRange = useMemo((): [number, number] => {
    if (chartData.length < 2) return [0, 1];
    const t0 = chartData[0]?.t ?? 0;
    const t1 = chartData[chartData.length - 1]?.t ?? 1;
    return [t0, Math.max(t0 + 1, t1)];
  }, [chartData]);

  const xDomain = xZoom ?? fullXRange;

  const yDomain = useMemo((): [number, number] => {
    const [t0, t1] = xDomain;
    let vmin = Infinity;
    let vmax = -Infinity;
    for (const row of chartData) {
      if (row.t < t0 || row.t > t1) continue;
      for (const key of ["v_gen", "v_ref"] as const) {
        const v = row[key];
        if (typeof v === "number" && Number.isFinite(v)) {
          vmin = Math.min(vmin, v);
          vmax = Math.max(vmax, v);
        }
      }
    }
    if (!Number.isFinite(vmin) || !Number.isFinite(vmax)) return [0, 80];
    if (vmax - vmin < 1) {
      const mid = (vmin + vmax) / 2;
      return [Math.max(0, mid - 5), mid + 5];
    }
    const pad = Math.max(2, (vmax - vmin) * 0.1);
    return [Math.max(0, Math.floor(vmin - pad)), Math.ceil(vmax + pad)];
  }, [chartData, xDomain]);

  useEffect(() => {
    setHoverPoint(null);
    hoverTRef.current = null;
    setXZoom(null);
  }, [chartData]);

  useEffect(() => {
    const el = chartWrapRef.current;
    if (!el || chartData.length < 2) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const [full0, full1] = fullXRange;
      const fullSpan = full1 - full0;
      if (fullSpan <= 0) return;

      const [cur0, cur1] = xZoom ?? fullXRange;
      const span = cur1 - cur0;
      const zoomOut = e.deltaY > 0;
      const factor = zoomOut ? 1.18 : 1 / 1.18;
      const minSpan = Math.max(8, fullSpan * 0.02);
      let newSpan = Math.min(fullSpan, Math.max(minSpan, span * factor));

      const anchor =
        hoverTRef.current != null &&
        hoverTRef.current >= cur0 &&
        hoverTRef.current <= cur1
          ? hoverTRef.current
          : (cur0 + cur1) / 2;
      const ratio = span > 0 ? (anchor - cur0) / span : 0.5;
      let n0 = anchor - ratio * newSpan;
      let n1 = n0 + newSpan;
      if (n0 < full0) {
        n0 = full0;
        n1 = n0 + newSpan;
      }
      if (n1 > full1) {
        n1 = full1;
        n0 = n1 - newSpan;
      }
      n0 = Math.max(full0, n0);
      n1 = Math.min(full1, n1);

      if (newSpan >= fullSpan * 0.98) {
        setXZoom(null);
      } else {
        setXZoom([n0, n1]);
      }
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [chartData.length, fullXRange, xZoom]);

  const handleSave = () => {
    const n = saveName.trim() || defaultTripName(departureLabel, destinationLabel);
    onSaveTrip(n);
    refreshTrips();
  };

  const injectSaved = (trip: SavedTripSnapshot) => {
    if (!trip.profile) {
      setError("Impossible d’injecter : pas de profil v(t).");
      return;
    }
    setError(null);
    onInjectedChange({
      id: trip.id,
      name: trip.name,
      origin: "saved",
      time: trip.profile.time,
      velocity: trip.profile.velocity,
    });
    const geom =
      trip.geometry && trip.geometry.length >= 2 ? trip.geometry : null;
    const origin = trip.pointA ?? geom?.[0] ?? null;
    const destination =
      trip.pointB ?? (geom ? geom[geom.length - 1] : null) ?? null;
    onInjectGeometry?.({
      points: geom,
      origin,
      destination,
      originLabel: trip.departureLabel || null,
      destinationLabel: trip.destinationLabel || null,
    });
  };

  const injectCorpus = async () => {
    if (!selectedCorpus) {
      setError("Choisissez une référence corpus.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const series = await fetchCorpusSeries(selectedCorpus);
      const meta = sources.find((s) => s.id === selectedCorpus);
      onInjectedChange({
        id: selectedCorpus,
        name: meta?.name ?? series.name,
        origin: "corpus",
        time: series.time,
        velocity: series.velocity,
        lat: series.lat,
        lon: series.lon,
      });
      if (
        series.lat &&
        series.lon &&
        series.lat.length === series.lon.length &&
        series.lat.length >= 2
      ) {
        const points = series.lat.map((lat, i) => ({
          lat,
          lon: series.lon![i],
        }));
        onInjectGeometry?.({
          points,
          origin: points[0],
          destination: points[points.length - 1],
        });
      } else {
        onInjectGeometry?.(null);
        setError(
          meta?.has_geo === false
            ? "Référence sans GPS (réglementaire) — départ/arrivée non remplis."
            : "Pas de coordonnées GPS dans cette référence."
        );
      }
      setViewer({
        name: meta?.name ?? series.name,
        time: series.time,
        velocity: series.velocity,
      });
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : "Injection échouée");
    } finally {
      setBusy(false);
    }
  };

  const runCompare = async () => {
    if (!profile) {
      setError("Aucun cycle généré à comparer.");
      return;
    }
    const refId =
      injected?.origin === "corpus"
        ? injected.id
        : selectedCorpus || sources[0]?.id;
    if (!refId && !injected) {
      setError("Choisissez une référence corpus ou injectez un cycle.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (injected?.origin === "saved") {
        // Local compare without API: resample naive overlay
        const tMax = Math.min(
          profile.time[profile.time.length - 1] ?? 0,
          injected.time[injected.time.length - 1] ?? 0
        );
        const times: number[] = [];
        const v_gen: number[] = [];
        const v_ref: number[] = [];
        for (let t = 0; t <= Math.floor(tMax); t += 1) {
          times.push(t);
          v_gen.push(interp(profile.time, profile.velocity, t));
          v_ref.push(interp(injected.time, injected.velocity, t));
        }
        const diff = v_gen.map((g, i) => g - v_ref[i]);
        const rmse = Math.sqrt(
          diff.reduce((a, b) => a + b * b, 0) / Math.max(diff.length, 1)
        );
        setCompare({
          reference_id: injected.id,
          align: "time",
          ref_has_geo: false,
          times,
          v_gen,
          v_ref,
          kpis: {
            rmse_v: rmse,
            mae_v: diff.reduce((a, b) => a + Math.abs(b), 0) / Math.max(diff.length, 1),
            bias_v: diff.reduce((a, b) => a + b, 0) / Math.max(diff.length, 1),
            delta_duration_pct: 0,
            delta_duration_s:
              (profile.time.at(-1) ?? 0) - (injected.time.at(-1) ?? 0),
            delta_distance_pct: 0,
            delta_distance_m: 0,
            stops_gen: 0,
            stops_ref: 0,
            stop_time_ratio_gen: 0,
            stop_time_ratio_ref: 0,
            mean_abs_accel_gen: 0,
            mean_abs_accel_ref: 0,
            p95_abs_accel_gen: 0,
            p95_abs_accel_ref: 0,
          },
          recalibration_hints: [
            "Comparaison locale (cycle sauvegardé). Pour KPIs complets, utilisez une référence corpus via l’API.",
          ],
          warnings: [],
        });
      } else {
        const res = await runBenchmark({
          profile,
          referenceId: refId!,
          align,
        });
        setCompare(res);
        if (res.ref_has_geo && res.lat_ref && res.lon_ref) {
          const points = res.lat_ref.map((lat, i) => ({
            lat,
            lon: res.lon_ref![i],
          }));
          onInjectGeometry?.({
            points,
            origin: points[0],
            destination: points[points.length - 1],
          });
        }
      }
      onTabChange("compare");
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : "Comparaison échouée");
    } finally {
      setBusy(false);
    }
  };

  const tabs: { id: WorkspaceTab; label: string; title: string }[] = [
    { id: "current", label: "Actuel", title: "Cycle courant / sauvegarde" },
    { id: "saved", label: "Sauvé", title: "Trajets sauvegardés" },
    { id: "corpus", label: "Corpus", title: "Corpus externe de référence" },
  ];

  const selectedTrip = trips.find((t) => t.id === selectedSavedId);
  const selectedCorpusMeta = sources.find((s) => s.id === selectedCorpus);

  const viewerPanel = (
    <div className="flex h-44 flex-col rounded-md border border-slate-200 bg-slate-50 p-2">
      <div className="mb-1 flex shrink-0 items-center justify-between gap-2">
        <div className="min-w-0 truncate text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Viewer{" "}
          {viewer
            ? viewer.name
            : profile
              ? "cycle courant"
              : "—"}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {xZoom && (
            <button
              type="button"
              onClick={() => setXZoom(null)}
              className="rounded bg-white px-1.5 py-0.5 text-[9px] font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100"
              title="Réinitialiser le zoom"
            >
              Zoom 1:1
            </button>
          )}
          <span className="text-[9px] text-slate-400">molette = zoom</span>
        </div>
      </div>
      {chartData.length < 2 ? (
        <p className="flex min-h-0 flex-1 items-center justify-center text-[11px] text-slate-400">
          Aucune série à afficher
        </p>
      ) : (
        <>
          <div
            ref={chartWrapRef}
            className="relative min-h-0 flex-1 overflow-hidden"
            onDoubleClick={() => setXZoom(null)}
            title="Molette : zoom temps · double-clic : tout afficher"
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={chartData}
                margin={{ top: 4, right: 8, left: 0, bottom: 2 }}
                onMouseMove={(state) => {
                  const row = (
                    state as {
                      activePayload?: Array<{
                        payload?: { t?: number; v_gen?: number; v_ref?: number };
                      }>;
                    }
                  ).activePayload?.[0]?.payload;
                  if (row && typeof row.t === "number") {
                    hoverTRef.current = row.t;
                    setHoverPoint({
                      t: row.t,
                      v_gen:
                        typeof row.v_gen === "number" ? row.v_gen : undefined,
                      v_ref:
                        typeof row.v_ref === "number" ? row.v_ref : undefined,
                    });
                  } else if (
                    typeof state?.activeLabel === "number" ||
                    (typeof state?.activeLabel === "string" &&
                      state.activeLabel !== "")
                  ) {
                    const t = Number(state.activeLabel);
                    if (!Number.isFinite(t)) return;
                    hoverTRef.current = t;
                    let best = chartData[0];
                    let bestD = Infinity;
                    for (const r of chartData) {
                      const d = Math.abs(r.t - t);
                      if (d < bestD) {
                        bestD = d;
                        best = r;
                      }
                    }
                    if (best) {
                      setHoverPoint({
                        t: best.t,
                        v_gen:
                          typeof best.v_gen === "number"
                            ? best.v_gen
                            : undefined,
                        v_ref:
                          typeof best.v_ref === "number"
                            ? best.v_ref
                            : undefined,
                      });
                    }
                  }
                }}
                onMouseLeave={() => {
                  setHoverPoint(null);
                  hoverTRef.current = null;
                }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis
                  dataKey="t"
                  type="number"
                  scale="linear"
                  domain={xDomain}
                  allowDataOverflow
                  allowDecimals={false}
                  tickFormatter={formatTimeTick}
                  tick={{ fontSize: 9 }}
                />
                <YAxis
                  tick={{ fontSize: 9 }}
                  unit=" km/h"
                  width={40}
                  domain={yDomain}
                  allowDataOverflow
                />
                <Tooltip
                  content={() => null}
                  cursor={{
                    stroke: "#94a3b8",
                    strokeWidth: 1,
                    strokeDasharray: "3 3",
                  }}
                />
                <Legend
                  verticalAlign="top"
                  align="right"
                  height={18}
                  wrapperStyle={{ fontSize: 10, paddingTop: 0 }}
                  iconSize={8}
                />
                {"v_gen" in (chartData[0] ?? {}) &&
                  chartData[0]?.v_gen != null && (
                    <Line
                      type="monotone"
                      dataKey="v_gen"
                      name="CycleGen"
                      stroke="#2563eb"
                      dot={false}
                      strokeWidth={2}
                      isAnimationActive={false}
                    />
                  )}
                {"v_ref" in (chartData[0] ?? {}) &&
                  chartData[0]?.v_ref != null && (
                    <Line
                      type="monotone"
                      dataKey="v_ref"
                      name="Référence"
                      stroke="#059669"
                      strokeDasharray="4 3"
                      dot={false}
                      strokeWidth={2}
                      isAnimationActive={false}
                    />
                  )}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="relative z-10 mt-1 flex h-6 shrink-0 items-center justify-center gap-3 rounded border border-slate-200 bg-white px-2 text-[11px] font-semibold tabular-nums text-slate-800 shadow-sm">
            {hoverPoint ? (
              <>
                <span className="text-slate-500">
                  {formatTimeLabel(hoverPoint.t)}
                </span>
                {typeof hoverPoint.v_gen === "number" && (
                  <span className="text-blue-700">
                    CycleGen{" "}
                    <span className="tabular-nums">
                      {hoverPoint.v_gen.toFixed(1)}
                    </span>{" "}
                    km/h
                  </span>
                )}
                {typeof hoverPoint.v_ref === "number" && (
                  <span className="text-emerald-700">
                    Réf{" "}
                    <span className="tabular-nums">
                      {hoverPoint.v_ref.toFixed(1)}
                    </span>{" "}
                    km/h
                  </span>
                )}
                {typeof hoverPoint.v_gen !== "number" &&
                  typeof hoverPoint.v_ref !== "number" && (
                    <span className="text-slate-400">—</span>
                  )}
              </>
            ) : (
              <span className="font-normal text-slate-400">
                Survolez · molette = zoom X (Y auto)
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );

  return (
    <div className="z-20 shrink-0 border-b border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Cycles
        </span>
        <div className="flex rounded-md border border-slate-200 bg-slate-50 p-0.5">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              title={t.title}
              onClick={() => {
                onTabChange(t.id);
                setExpanded(true);
                setControlsOpen(true);
              }}
              className={`rounded px-2 py-1 text-[11px] font-semibold ${
                activeTab === t.id
                  ? "bg-white text-brand shadow-sm ring-1 ring-slate-200"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={openCompare}
          title="Envoyer le cycle actuel (et la référence injectée) vers Versus"
          className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
        >
          → Versus
        </button>

        {injected && (
          <span className="inline-flex max-w-[160px] items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
            <span className="truncate" title={injected.name}>
              {injected.name}
            </span>
            <button
              type="button"
              className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-emerald-100"
              title="Retirer la référence"
              aria-label="Retirer la référence"
              onClick={() => {
                onInjectedChange(null);
                onInjectGeometry?.(null);
              }}
            >
              ×
            </button>
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? "Replier le bandeau Cycles" : "Déplier le bandeau Cycles"}
            aria-label={expanded ? "Replier" : "Déplier"}
            className="inline-flex h-7 w-7 items-center justify-center rounded border border-slate-200 text-slate-600 hover:bg-slate-50"
          >
            {expanded ? "▾" : "▸"}
          </button>
          <button
            type="button"
            onClick={() => onOpenHelp?.()}
            title="Aide scientifique"
            aria-label="Aide scientifique"
            className="inline-flex h-7 w-7 items-center justify-center rounded bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-40"
            disabled={!onOpenHelp}
          >
            ?
          </button>
        </div>
      </div>

      {expanded && activeTab !== "compare" && (
        <div className="flex flex-col border-t border-slate-100">
          {/* Ligne 1 — contrôles (repliable) */}
          <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-1">
            <button
              type="button"
              onClick={() => setControlsOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-50"
              title={controlsOpen ? "Replier les contrôles" : "Déplier les contrôles"}
            >
              <span aria-hidden>{controlsOpen ? "▾" : "▸"}</span>
              Contrôles
            </button>
            {!controlsOpen && (
              <span className="truncate text-[10px] text-slate-400">
                {activeTab === "current"
                  ? "Actuel"
                  : activeTab === "saved"
                    ? "Sauvegardes"
                    : "Corpus"}
              </span>
            )}
          </div>

          {controlsOpen && (
            <div className="space-y-2 border-b border-slate-100 px-3 py-2">
              {error && (
                <div className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-700">
                  {error}
                </div>
              )}

              {activeTab === "current" && (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="min-w-[200px] flex-1 text-[10px] font-medium text-slate-600">
                    Nom de sauvegarde
                    <input
                      value={saveName}
                      onChange={(e) => setSaveName(e.target.value)}
                      className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1.5 text-xs"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={!canSave}
                    onClick={handleSave}
                    className="rounded bg-slate-900 px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-40"
                  >
                    Sauver trajet + cycle
                  </button>
                  <p className="basis-full text-[10px] text-slate-500">
                    {profile?.time?.length
                      ? `Cycle courant : ${(profile.total_duration_s ?? 0).toFixed(0)} s · ${(profile.average_speed_kmh ?? 0).toFixed(1)} km/h`
                      : "Pas encore de cycle généré — la sauvegarde stocke A/B et params."}
                  </p>
                </div>
              )}

              {activeTab === "saved" && (
                <div className="max-h-36 space-y-1 overflow-y-auto">
                  {trips.length === 0 && (
                    <p className="text-[11px] text-slate-400">Aucune sauvegarde.</p>
                  )}
                  {trips.map((t) => (
                    <div
                      key={t.id}
                      className={`flex flex-wrap items-center gap-1 rounded border px-2 py-1.5 ${
                        selectedSavedId === t.id
                          ? "border-brand bg-brand/5"
                          : "border-slate-100 bg-slate-50"
                      }`}
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold text-slate-800"
                        onClick={() => setSelectedSavedId(t.id)}
                      >
                        {t.name}
                        <span className="ml-1 font-normal text-slate-400">
                          {t.profile ? "· cycle" : t.corridor ? "· cycle" : ""}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="text-[10px] font-semibold text-brand"
                        onClick={() => {
                          onLoadTrip(t);
                          refreshTrips();
                        }}
                      >
                        Charger
                      </button>
                      <button
                        type="button"
                        className="text-[10px] font-semibold text-emerald-700"
                        onClick={() => injectSaved(t)}
                        disabled={!t.profile}
                        title="Utiliser ce cycle comme référence de comparaison"
                      >
                        Utiliser
                      </button>
                      <button
                        type="button"
                        className="text-[10px] text-slate-400 hover:text-red-600"
                        onClick={() => {
                          deleteSavedTrip(t.id);
                          refreshTrips();
                        }}
                      >
                        Del
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === "corpus" && (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="min-w-[220px] flex-1 text-[10px] font-medium text-slate-600">
                    Référence corpus
                    <select
                      value={selectedCorpus}
                      onChange={(e) => setSelectedCorpus(e.target.value)}
                      className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1.5 text-xs"
                    >
                      {groupBenchmarkSources(sources).map((g) => (
                        <optgroup key={g.family} label={g.label}>
                          {g.items.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                              {s.has_geo ? " · geo" : ""} ·{" "}
                              {Math.round(s.duration_s)}s
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={busy || !selectedCorpus}
                    onClick={() => void injectCorpus()}
                    className="rounded bg-emerald-700 px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-40"
                  >
                    {busy ? "…" : "Utiliser ce cycle"}
                  </button>
                  <p className="basis-full text-[10px] text-slate-500">
                    La sélection charge le viewer. « Utiliser ce cycle » pose la
                    référence sur la carte / le graphe.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Ligne 2 — 2 colonnes : contexte | viewer */}
          <div className="grid gap-3 px-3 py-3 lg:grid-cols-2">
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
              {activeTab === "current" && (
                <div className="space-y-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    Cycle actuel
                  </div>
                  {profile?.time?.length ? (
                    <ul className="space-y-0.5 tabular-nums">
                      <li>Durée {(profile.total_duration_s ?? 0).toFixed(0)} s</li>
                      <li>v̄ {(profile.average_speed_kmh ?? 0).toFixed(1)} km/h</li>
                      <li>{profile.time.length} points</li>
                    </ul>
                  ) : (
                    <p className="text-slate-400">Aucun profil généré.</p>
                  )}
                  {injected && (
                    <p className="pt-1 text-[10px] text-emerald-700">
                      Réf injectée : {injected.name}
                    </p>
                  )}
                </div>
              )}
              {activeTab === "saved" && (
                <div className="space-y-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    Sélection
                  </div>
                  {selectedTrip ? (
                    <>
                      <p className="font-semibold text-slate-800">{selectedTrip.name}</p>
                      <p className="text-[10px] text-slate-500">
                        {selectedTrip.profile
                          ? `${(selectedTrip.profile.total_duration_s ?? 0).toFixed(0)} s · ${(selectedTrip.profile.average_speed_kmh ?? 0).toFixed(1)} km/h`
                          : "Pas de cycle enregistré sur ce trajet"}
                      </p>
                    </>
                  ) : (
                    <p className="text-slate-400">Choisissez une sauvegarde ci-dessus.</p>
                  )}
                </div>
              )}
              {activeTab === "corpus" && (
                <div className="space-y-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    Corpus
                  </div>
                  {selectedCorpusMeta ? (
                    <>
                      <p className="font-semibold text-slate-800">
                        {selectedCorpusMeta.name}
                      </p>
                      <p className="text-[10px] text-slate-500">
                        {Math.round(selectedCorpusMeta.duration_s)} s
                        {selectedCorpusMeta.has_geo ? " · geo" : " · sans geo"}
                        {selectedCorpusMeta.n_points
                          ? ` · ${selectedCorpusMeta.n_points} pts`
                          : ""}
                      </p>
                      {selectedCorpusMeta.license && (
                        <p className="text-[10px] text-slate-400">
                          {selectedCorpusMeta.license}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-slate-400">Sélectionnez une référence.</p>
                  )}
                </div>
              )}
            </div>
            {viewerPanel}
          </div>
        </div>
      )}
    </div>
  );
}

function interp(xs: number[], ys: number[], x: number): number {
  if (xs.length === 0) return 0;
  if (x <= xs[0]) return ys[0] ?? 0;
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1] ?? 0;
  let i = 1;
  while (i < xs.length && xs[i] < x) i += 1;
  const x0 = xs[i - 1];
  const x1 = xs[i];
  const y0 = ys[i - 1];
  const y1 = ys[i];
  const u = (x - x0) / Math.max(x1 - x0, 1e-9);
  return y0 + u * (y1 - y0);
}
