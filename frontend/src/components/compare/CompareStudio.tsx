"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toJpeg } from "html-to-image";
import {
  getBenchmarkSource,
  listBenchmarkSources,
} from "@/lib/api";
import {
  clearStashedCompareCycles,
  listSavedCycles,
  newCycleInstanceId,
  packCycle,
  peekStashedCompareCycles,
  type SavedCycle,
} from "@/lib/cycleLibrary";
import {
  computeCycleStats,
  enrichSeriesFromGps,
  lateralAccelFromCorridor,
  sampleLimitsAlongProfile,
  type CycleStats,
} from "@/lib/cycleMetrics";
import { groupBenchmarkSources } from "@/lib/corpusGroups";
import { parseCycleBlob } from "@/lib/parseCycleFile";
import { listSavedTrips, type SavedTripSnapshot } from "@/lib/tripStore";
import type { BenchmarkSourceMeta, ConsolidatedProfile } from "@/lib/types";
import AccordionSection from "@/components/AccordionSection";
import { useHeaderChrome } from "@/components/HeaderChromeContext";
import {
  formatDistanceLabel,
  formatDistanceTick,
  formatTimeLabel,
  formatTimeTick,
  resampleUniform,
} from "@/lib/chartTime";
import { slopeFromRad } from "@/lib/units";
import MiniRouteMap from "./MiniRouteMap";
import VersusInspectDrawer, {
  VERSUS_CYCLE_DASH,
} from "./VersusInspectDrawer";
import VersusFidelityBand from "./VersusFidelityBand";
import { buildInspectRunMeta } from "@/lib/inspectRunMeta";
import {
  INSPECT_SERIES,
  inspectSampleValue,
  type InspectSeriesId,
} from "@/lib/chartInspectData";
import {
  getVehicle,
  listVehicles,
  type VehicleCard,
} from "@/lib/vehicleLibrary";

/** Ordre d’attribution à l’ajout : bleu → rouge → vert → jaune → … */
export const COMPARE_PALETTE = [
  "#2563eb", // bleu
  "#dc2626", // rouge
  "#16a34a", // vert
  "#ca8a04", // jaune
  "#9333ea", // violet
  "#ea580c", // orange
  "#0891b2", // cyan
  "#db2777", // rose
  "#4f46e5", // indigo
  "#65a30d", // lime
] as const;

type CompareSeriesKey =
  | "v"
  | "a_lon"
  | "a_lat"
  | "slope"
  | "p_trac_kw"
  | "p_regen_kw"
  | "p_wheel_kw"
  | "wheel_torque_nm"
  | "wheel_rpm";

type CompareXMode = "time" | "distance";

const COMPARE_SERIES_TOGGLES: {
  key: CompareSeriesKey;
  label: string;
  inspectId: InspectSeriesId;
}[] = [
  { key: "v", label: "Vitesse", inspectId: "v_kmh" },
  { key: "a_lon", label: "a_lon", inspectId: "a_lon" },
  { key: "a_lat", label: "a_lat", inspectId: "a_lat" },
  { key: "slope", label: "Pente", inspectId: "slope" },
  { key: "p_trac_kw", label: "P trac.", inspectId: "p_trac_kw" },
  { key: "p_regen_kw", label: "P frein.", inspectId: "p_regen_kw" },
  { key: "p_wheel_kw", label: "P méca.", inspectId: "p_wheel_kw" },
  { key: "wheel_torque_nm", label: "Couple", inspectId: "wheel_torque_nm" },
  { key: "wheel_rpm", label: "N roue", inspectId: "wheel_rpm" },
];

type CompareCycle = SavedCycle & {
  color: string;
  /** Bibliothèque locale : id stable (≠ id instance Versus). */
  libraryCycleId: string | null;
  /** Nom affiché dans la légende / graphes (éditable). */
  label: string;
  /** Décalage sur l’axe temps (s). */
  offsetTime_s: number;
  /** Décalage sur l’axe distance (m). */
  offsetDist_m: number;
  /** Véhicule road-load pour P / couple (override de meta.vehicleId). */
  vehicleId: string | null;
};

function defaultVehicleIdForCycle(c: SavedCycle): string | null {
  if (c.meta?.vehicleId) return c.meta.vehicleId;
  const hay = `${c.corpusId || ""} ${c.name || ""} ${c.source || ""}`.toLowerCase();
  if (
    hay.includes("avl_rs") ||
    hay.includes("rs_") ||
    hay.includes("alpine") ||
    hay.includes("veleta") ||
    hay.includes("grossglockner") ||
    hay.includes("iseran") ||
    hay.includes("stelvio")
  ) {
    return "plant-rs-apr2bis";
  }
  return "plant-cspace-leapfrog-apr2bis";
}

function vehicleOf(c: CompareCycle): VehicleCard | null {
  const id = c.vehicleId || c.meta?.vehicleId || null;
  return id ? getVehicle(id) : null;
}

function xAt(c: CompareCycle, i: number, mode: CompareXMode): number {
  if (mode === "time") return (c.time[i] ?? 0) + (c.offsetTime_s || 0);
  return (c.position[i] ?? 0) + (c.offsetDist_m || 0);
}

function formatXLabel(x: number, mode: CompareXMode): string {
  return mode === "time" ? formatTimeLabel(x) : formatDistanceLabel(x);
}

function formatXTick(x: number, mode: CompareXMode): string {
  return mode === "time" ? formatTimeTick(x) : formatDistanceTick(x);
}

function formatDur(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m > 0 ? `${m} min ${r} s` : `${r} s`;
}

function statsLine(st: CycleStats): string {
  return `${formatDur(st.duration_s)} · ${(st.distance_m / 1000).toFixed(1)} km · v̄ ${st.v_mean_kmh.toFixed(0)} km/h · vmax ${st.v_max_kmh.toFixed(0)} km/h`;
}

function cycleFromSeries(args: {
  name: string;
  source: string;
  origin: SavedCycle["origin"];
  sourceUrl?: string | null;
  corpusId?: string | null;
  time: number[];
  velocity: number[];
  acceleration?: number[] | null;
  a_lat?: number[] | null;
  slope?: number[] | null;
  position?: number[] | null;
  lat?: number[] | null;
  lon?: number[] | null;
  geometry?: SavedCycle["geometry"];
  limits?: SavedCycle["limits"];
  slopeIsPercent?: boolean;
  meta?: SavedCycle["meta"];
}): SavedCycle {
  const enriched = enrichSeriesFromGps({
    time: args.time,
    velocity: args.velocity,
    acceleration: args.acceleration,
    a_lat: args.a_lat,
    slope: args.slope,
    position: args.position,
    lat: args.lat,
    lon: args.lon,
    slopeIsPercent: args.slopeIsPercent,
  });
  const stats = computeCycleStats({
    time: args.time,
    velocity: args.velocity,
    acceleration: enriched.acceleration,
    slope: enriched.slope,
    position: enriched.position,
    a_lat: enriched.a_lat,
  });
  return packCycle(
    {
      id: newCycleInstanceId(args.origin),
      name: args.name,
      source: args.source,
      sourceUrl: args.sourceUrl ?? null,
      origin: args.origin,
      corpusId: args.corpusId ?? null,
      stats,
      time: args.time,
      velocity: args.velocity,
      acceleration: enriched.acceleration,
      slope: enriched.slope,
      a_lat: enriched.a_lat,
      position: enriched.position,
      geometry:
        args.geometry && args.geometry.length >= 2
          ? args.geometry
          : enriched.geometry,
      limits: args.limits ?? null,
      meta: args.meta,
    },
    { maxPoints: 2500 }
  );
}

function cycleFromProfile(
  name: string,
  profile: ConsolidatedProfile,
  extra?: {
    source?: string;
    corridor?: SavedTripSnapshot["corridor"];
    geometry?: SavedCycle["geometry"];
    driverProfile?: string;
    trafficSource?: string | null;
    routeLabel?: string;
    aY?: number;
    meta?: SavedCycle["meta"];
  }
): SavedCycle {
  const corridor = extra?.corridor ?? null;
  const aY =
    extra?.aY ??
    extra?.meta?.aY ??
    corridor?.a_y_mps2 ??
    2.5;
  const a_lat = lateralAccelFromCorridor(profile, corridor, aY);
  const limits = sampleLimitsAlongProfile(profile, corridor);
  const geometry =
    extra?.geometry && extra.geometry.length >= 2
      ? extra.geometry
      : corridor?.geometry ?? [];
  return cycleFromSeries({
    name,
    source: extra?.source ?? "CycleGen",
    origin: "cyclegen",
    time: profile.time,
    velocity: profile.velocity,
    acceleration: profile.acceleration,
    a_lat,
    slope: profile.slope,
    position: profile.position,
    lat: geometry.map((g) => g.lat),
    lon: geometry.map((g) => g.lon),
    geometry,
    limits,
    meta: {
      ...extra?.meta,
      driverProfile: extra?.driverProfile ?? extra?.meta?.driverProfile,
      trafficSource: extra?.trafficSource ?? extra?.meta?.trafficSource,
      routeLabel: extra?.routeLabel ?? extra?.meta?.routeLabel,
      aY,
    },
  });
}

function Spark({
  time,
  values,
  color,
  unit = "",
  digits = 0,
}: {
  time: number[];
  values: number[];
  color: string;
  unit?: string;
  digits?: number;
}) {
  const [hover, setHover] = useState<{ t: number; y: number } | null>(null);
  const data = useMemo(() => {
    const raw = time.map((t, i) => ({ t, y: values[i] ?? 0 }));
    return resampleUniform(raw, "t", { maxPoints: 80, dtPrefer: 2 });
  }, [time, values]);

  const fmt = (y: number) =>
    `${y.toFixed(digits)}${unit ? ` ${unit}` : ""}`;

  if (data.length < 2) {
    return <div className="h-14 rounded bg-slate-50" />;
  }

  const yMin = Math.min(...data.map((d) => d.y));
  const yMax = Math.max(...data.map((d) => d.y));

  return (
    <div className="flex h-[3.25rem] w-full flex-col">
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{ top: 2, right: 2, left: 2, bottom: 0 }}
            onMouseMove={(state) => {
              const payload = (
                state as { activePayload?: Array<{ payload?: { t?: number; y?: number } }> }
              ).activePayload?.[0]?.payload;
              const row = payload;
              if (
                row &&
                typeof row.t === "number" &&
                typeof row.y === "number"
              ) {
                setHover({ t: row.t, y: row.y });
              }
            }}
            onMouseLeave={() => setHover(null)}
          >
            <Tooltip content={() => null} cursor={{ stroke: "#94a3b8", strokeWidth: 1 }} />
            <Line
              type="monotone"
              dataKey="y"
              stroke={color}
              strokeWidth={1.25}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div
        className="h-3.5 shrink-0 truncate text-center text-[9px] font-semibold tabular-nums leading-none"
        style={{ color }}
      >
        {hover ? (
          <span title={formatTimeLabel(hover.t)}>
            {fmt(hover.y)}
            <span className="ml-1 font-normal text-slate-400">
              {formatTimeLabel(hover.t).replace(/^t\s*=\s*/, "")}
            </span>
          </span>
        ) : (
          <span className="font-normal text-slate-400">
            {fmt(yMin)}…{fmt(yMax)}
          </span>
        )}
      </div>
    </div>
  );
}

function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (c: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        title="Changer la couleur"
        onClick={() => setOpen((v) => !v)}
        className="h-4 w-4 rounded-sm ring-1 ring-slate-300 ring-offset-1"
        style={{ backgroundColor: value }}
        aria-label="Couleur"
      />
      {open && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 cursor-default"
            aria-label="Fermer palette"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 top-6 z-50 grid grid-cols-5 gap-1 rounded-md border border-slate-200 bg-white p-2 shadow-lg">
            {COMPARE_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                title={c}
                onClick={() => {
                  onChange(c);
                  setOpen(false);
                }}
                className={`h-5 w-5 rounded-sm ring-1 ${
                  value === c ? "ring-slate-900 ring-offset-1" : "ring-slate-200"
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 28 ? `${u.pathname.slice(0, 26)}…` : u.pathname;
    return `${u.hostname}${path === "/" ? "" : path}`;
  } catch {
    return url.length > 40 ? `${url.slice(0, 38)}…` : url;
  }
}

function TraceabilityBlock({ cycle }: { cycle: SavedCycle }) {
  const url = cycle.sourceUrl || cycle.meta?.sourceUrl || null;
  const citation = cycle.meta?.citation || cycle.meta?.notes || null;
  const st = cycle.stats;
  const summary = [
    cycle.origin,
    cycle.source,
    `${st.duration_s.toFixed(0)} s`,
    `${(st.distance_m / 1000).toFixed(2)} km`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <AccordionSection title="Traçabilité" summary={summary} defaultOpen={false}>
    <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] leading-snug text-slate-600">
      <div>
        Origine{" "}
        <span className="font-semibold text-slate-800">{cycle.origin}</span>
      </div>
      <div>
        Date{" "}
        <span className="font-semibold tabular-nums text-slate-800">
          {new Date(cycle.savedAt).toLocaleString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </div>
      <div className="col-span-2 truncate" title={cycle.source}>
        Source{" "}
        <span className="font-semibold text-slate-800">{cycle.source}</span>
      </div>
      {url && (
        <div className="col-span-2 truncate">
          Site{" "}
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-brand underline-offset-2 hover:underline"
            title={url}
          >
            {shortUrl(url)}
          </a>
        </div>
      )}
      {cycle.corpusId && (
        <div className="col-span-2 truncate">
          Corpus ID{" "}
          <span className="font-mono font-semibold text-slate-800">
            {cycle.corpusId}
          </span>
        </div>
      )}
      {cycle.meta?.license && (
        <div className="col-span-2 truncate" title={cycle.meta.license}>
          Licence{" "}
          <span className="font-semibold text-slate-800">
            {cycle.meta.license}
          </span>
        </div>
      )}
      {cycle.meta?.driverProfile && (
        <div>
          Conducteur{" "}
          <span className="font-semibold text-slate-800">
            {cycle.meta.driverProfile}
          </span>
        </div>
      )}
      {cycle.meta?.routeLabel && (
        <div className="col-span-2 truncate" title={cycle.meta.routeLabel}>
          Trajet{" "}
          <span className="font-semibold text-slate-800">
            {cycle.meta.routeLabel}
          </span>
        </div>
      )}
      <div>
        Durée{" "}
        <span className="font-semibold tabular-nums text-slate-800">
          {(st.duration_s ?? 0).toFixed(0)} s
        </span>
      </div>
      <div>
        Dist.{" "}
        <span className="font-semibold tabular-nums text-slate-800">
          {((st.distance_m ?? 0) / 1000).toFixed(2)} km
        </span>
      </div>
      <div>
        v̄{" "}
        <span className="font-semibold tabular-nums text-slate-800">
          {(st.v_mean_kmh ?? 0).toFixed(1)}
        </span>
        {" / max "}
        <span className="font-semibold tabular-nums text-slate-800">
          {(st.v_max_kmh ?? 0).toFixed(1)}
        </span>{" "}
        km/h
      </div>
      <div>
        a_lon{" "}
        <span className="font-semibold tabular-nums text-slate-800">
          {(st.a_lon_min_mps2 ?? 0).toFixed(1)}…
          {(st.a_lon_max_mps2 ?? 0).toFixed(1)} m/s²
        </span>
      </div>
      {st.slope_min_pct != null && st.slope_max_pct != null && (
        <div className="col-span-2">
          Pente{" "}
          <span className="font-semibold tabular-nums text-slate-800">
            {st.slope_min_pct.toFixed(1)}…{st.slope_max_pct.toFixed(1)} %
          </span>
          {st.slope_mean_pct != null && (
            <span className="text-slate-500">
              {" "}
              (moy {st.slope_mean_pct.toFixed(1)} %)
            </span>
          )}
        </div>
      )}
      {citation && (
        <div className="col-span-2 line-clamp-2 text-slate-500" title={citation}>
          {citation}
        </div>
      )}
    </dl>
    </AccordionSection>
  );
}

function CycleCard({
  cycle,
  onRemove,
  onColor,
  onLabel,
  onOffset,
  onVehicle,
}: {
  cycle: CompareCycle;
  onRemove: () => void;
  onColor: (color: string) => void;
  onLabel: (label: string) => void;
  onOffset: (patch: Partial<Pick<CompareCycle, "offsetTime_s" | "offsetDist_m">>) => void;
  onVehicle: (vehicleId: string | null) => void;
}) {
  const slopePct = cycle.slope.map((r) => slopeFromRad(r, "percent"));
  const vehicles = listVehicles();
  return (
    <article
      className="flex w-full flex-col gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-sm"
      style={{ borderTopColor: cycle.color, borderTopWidth: 3 }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <ColorPicker value={cycle.color} onChange={onColor} />
            <input
              value={cycle.label}
              onChange={(e) => onLabel(e.target.value)}
              className="min-w-0 flex-1 truncate rounded border border-transparent bg-transparent px-1 text-sm font-semibold text-slate-900 outline-none hover:border-slate-200 focus:border-slate-300 focus:bg-white"
              title="Nom de légende (éditable)"
            />
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="rounded px-1.5 text-xs font-bold text-slate-400 hover:bg-red-50 hover:text-red-600"
          title="Retirer de la comparaison"
        >
          ×
        </button>
      </div>

      <label className="flex flex-col gap-0.5 rounded-md border border-slate-100 bg-slate-50 px-2 py-1.5">
        <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
          Véhicule · P / couple
        </span>
        <select
          value={cycle.vehicleId || ""}
          onChange={(e) => onVehicle(e.target.value || null)}
          className="w-full truncate rounded border border-slate-200 bg-white px-1.5 py-1 text-[11px] font-medium text-slate-800"
          title="Road load pour puissance et couple à la roue"
        >
          <option value="">— aucun —</option>
          {vehicles.map((v) => (
            <option key={v.id} value={v.id}>
              {v.code} · {v.name}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-slate-50 px-2 py-1.5 text-[10px] text-slate-600">
        <span className="font-semibold uppercase tracking-wide text-slate-400">
          Offset
        </span>
        <label className="inline-flex items-center gap-1">
          t
          <input
            type="number"
            step={1}
            value={cycle.offsetTime_s}
            onChange={(e) =>
              onOffset({ offsetTime_s: Number(e.target.value) || 0 })
            }
            className="w-14 rounded border border-slate-200 bg-white px-1 py-0.5 tabular-nums text-slate-800"
            title="Décalage temps (s)"
          />
          s
        </label>
        <label className="inline-flex items-center gap-1">
          s
          <input
            type="number"
            step={10}
            value={cycle.offsetDist_m}
            onChange={(e) =>
              onOffset({ offsetDist_m: Number(e.target.value) || 0 })
            }
            className="w-16 rounded border border-slate-200 bg-white px-1 py-0.5 tabular-nums text-slate-800"
            title="Décalage distance (m)"
          />
          m
        </label>
        {(cycle.offsetTime_s !== 0 || cycle.offsetDist_m !== 0) && (
          <button
            type="button"
            onClick={() => onOffset({ offsetTime_s: 0, offsetDist_m: 0 })}
            className="text-[9px] font-semibold text-slate-400 hover:text-slate-700"
          >
            reset
          </button>
        )}
      </div>

      <TraceabilityBlock cycle={cycle} />

      <div className="grid grid-cols-[120px_1fr] gap-2">
        <MiniRouteMap geometry={cycle.geometry} className="h-16 w-full" />
        <div className="grid grid-cols-2 gap-x-2 gap-y-1">
          <div>
            <div className="text-[9px] font-medium uppercase text-slate-400">
              v
            </div>
            <Spark
              time={cycle.time}
              values={cycle.velocity.map((v) => v * 3.6)}
              color={cycle.color}
              unit="km/h"
              digits={0}
            />
          </div>
          <div>
            <div className="text-[9px] font-medium uppercase text-slate-400">
              pente %
            </div>
            <Spark
              time={cycle.time}
              values={slopePct}
              color={cycle.color}
              unit="%"
              digits={1}
            />
          </div>
          <div>
            <div className="text-[9px] font-medium uppercase text-slate-400">
              a_lon
            </div>
            <Spark
              time={cycle.time}
              values={cycle.acceleration}
              color={cycle.color}
              unit="m/s²"
              digits={1}
            />
          </div>
          <div>
            <div className="text-[9px] font-medium uppercase text-slate-400">
              a_lat
            </div>
            <Spark
              time={cycle.time}
              values={cycle.a_lat}
              color={cycle.color}
              unit="m/s²"
              digits={1}
            />
          </div>
        </div>
      </div>
    </article>
  );
}

type AddModalProps = {
  open: boolean;
  onClose: () => void;
  onAdd: (cycle: SavedCycle) => void;
  addedKeys: Set<string>;
};

function AddCycleModal({ open, onClose, onAdd, addedKeys }: AddModalProps) {
  const [tab, setTab] = useState<"lib" | "corpus" | "file">("lib");
  const [saved, setSaved] = useState<SavedCycle[]>([]);
  const [trips, setTrips] = useState<SavedTripSnapshot[]>([]);
  const [corpus, setCorpus] = useState<BenchmarkSourceMeta[]>([]);
  const [query, setQuery] = useState("");
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setSaved(listSavedCycles());
    setTrips(listSavedTrips());
    setError("");
    setQuery("");
    void listBenchmarkSources()
      .then(setCorpus)
      .catch(() => setCorpus([]));
  }, [open]);

  const q = query.trim().toLowerCase();
  const filteredSaved = q
    ? saved.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.source.toLowerCase().includes(q)
      )
    : saved;
  const tripsWithCycle = trips.filter(
    (t) => t.profile && t.profile.time.length > 1
  );
  const filteredTrips = q
    ? tripsWithCycle.filter((t) => t.name.toLowerCase().includes(q))
    : tripsWithCycle;
  const filteredCorpus = q
    ? corpus.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          (m.family || "").toLowerCase().includes(q)
      )
    : corpus;
  const groups = groupBenchmarkSources(filteredCorpus);

  const addCorpus = async (meta: BenchmarkSourceMeta) => {
    setLoadingId(meta.id);
    setError("");
    try {
      const series = await getBenchmarkSource(meta.id);
      const cycle = cycleFromSeries({
        name: meta.name,
        source: meta.source || meta.family || "corpus",
        origin: "corpus",
        sourceUrl: meta.url || series.url || null,
        corpusId: meta.id,
        time: series.time,
        velocity: series.velocity,
        acceleration: series.acceleration,
        a_lat: series.a_lat,
        slope: series.slope,
        position: series.position,
        lat: series.lat,
        lon: series.lon,
        meta: {
          notes: meta.citation || series.citation || undefined,
          citation: meta.citation || series.citation || undefined,
          license: meta.license || series.license || undefined,
          sourceUrl: meta.url || series.url || undefined,
        },
      });
      onAdd(cycle);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chargement corpus échoué");
    } finally {
      setLoadingId(null);
    }
  };

  const addTrip = (trip: SavedTripSnapshot) => {
    if (!trip.profile) return;
    const cycle = cycleFromProfile(trip.name, trip.profile, {
      source: `Trajet · ${trip.driverProfile}`,
      corridor: trip.corridor,
      geometry: trip.geometry?.length
        ? trip.geometry
        : trip.corridor?.geometry,
      driverProfile: trip.driverProfile,
      trafficSource: trip.trafficSource,
      routeLabel: `${trip.departureLabel} → ${trip.destinationLabel}`,
      aY: trip.aY,
    });
    onAdd(cycle);
  };

  const addFiles = async (files: FileList | File[]) => {
    setError("");
    const list = Array.from(files);
    if (!list.length) return;
    setLoadingId("file");
    try {
      for (const file of list) {
        const parsed = await parseCycleBlob(file);
        const cycle = cycleFromSeries({
          name: parsed.name,
          source: parsed.source,
          origin: "import",
          time: parsed.time,
          velocity: parsed.velocity,
          acceleration: parsed.acceleration,
          a_lat: parsed.a_lat,
          slope: parsed.slope,
          position: parsed.position,
          lat: parsed.lat,
          lon: parsed.lon,
          slopeIsPercent: parsed.slopeIsPercent,
          meta: { notes: file.name },
        });
        onAdd(cycle);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import fichier échoué");
    } finally {
      setLoadingId(null);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[1400] flex items-center justify-center bg-slate-900/45 p-4"
      role="dialog"
      aria-modal
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-slate-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-900">
            Ajouter un cycle
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700"
          >
            ×
          </button>
        </div>
        <div className="flex gap-1 border-b border-slate-100 px-3 pt-2">
          {(
            [
              ["lib", "Bibliothèque"],
              ["corpus", "Corpus"],
              ["file", "Fichier"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`rounded-t-md px-3 py-1.5 text-xs font-semibold ${
                tab === id
                  ? "bg-slate-100 text-slate-900"
                  : "text-slate-500 hover:text-slate-800"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {tab !== "file" && (
          <div className="border-b border-slate-100 px-3 py-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                tab === "corpus" ? "Filtrer le corpus…" : "Filtrer…"
              }
              className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs text-slate-800 outline-none focus:border-slate-400"
            />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {error && (
            <p className="mb-2 text-[11px] text-red-600">{error}</p>
          )}
          {tab === "lib" && (
            <div className="space-y-3">
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  Cycles enregistrés
                </div>
                <ul className="space-y-1">
                  {filteredSaved.length === 0 && (
                    <li className="rounded-md border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-400">
                      Aucun cycle enregistré — Enregistrer dans le studio, ou
                      importez un fichier.
                    </li>
                  )}
                  {filteredSaved.map((c) => {
                    const already = addedKeys.has(`lib:${c.id}`);
                    return (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => onAdd(c)}
                          className="flex w-full flex-col rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-left hover:bg-white"
                        >
                          <span className="text-xs font-semibold text-slate-900">
                            {c.name}
                            {already && (
                              <span className="ml-1 font-normal text-slate-400">
                                · déjà dans VS
                              </span>
                            )}
                          </span>
                          <span className="text-[10px] text-slate-500">
                            {c.source} · {statsLine(c.stats)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  Trajets sauvés (avec cycle)
                </div>
                <ul className="space-y-1">
                  {filteredTrips.length === 0 && (
                    <li className="rounded-md border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-400">
                      Aucun trajet avec profil généré.
                    </li>
                  )}
                  {filteredTrips.map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => addTrip(t)}
                        className="flex w-full flex-col rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-left hover:bg-white"
                      >
                        <span className="text-xs font-semibold text-slate-900">
                          {t.name}
                        </span>
                        <span className="text-[10px] text-slate-500">
                          {t.driverProfile} · {t.departureLabel} →{" "}
                          {t.destinationLabel}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {tab === "corpus" && (
            <div className="space-y-3">
              {groups.length === 0 && (
                <p className="py-6 text-center text-xs text-slate-400">
                  {corpus.length === 0
                    ? "Corpus indisponible (API)."
                    : "Aucun résultat."}
                </p>
              )}
              {groups.map((g) => (
                <div key={g.family}>
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    {g.label}
                  </div>
                  <ul className="space-y-1">
                    {g.items.map((m) => {
                      const already = addedKeys.has(`corpus:${m.id}`);
                      return (
                        <li key={m.id}>
                          <button
                            type="button"
                            disabled={loadingId === m.id}
                            onClick={() => void addCorpus(m)}
                            className="flex w-full items-center justify-between gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-left hover:bg-white disabled:opacity-40"
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-xs font-semibold text-slate-900">
                                {m.name}
                                {already && (
                                  <span className="ml-1 font-normal text-slate-400">
                                    · déjà dans VS
                                  </span>
                                )}
                              </span>
                              <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-slate-500">
                                <span>
                                  {m.n_points} pts · {formatDur(m.duration_s)}
                                </span>
                                {m.has_geo ? (
                                  <span className="rounded bg-emerald-50 px-1 py-0.5 font-semibold text-emerald-800">
                                    Avec GPS
                                  </span>
                                ) : (
                                  <span className="rounded bg-slate-200/80 px-1 py-0.5 font-semibold text-slate-600">
                                    Sans GPS
                                  </span>
                                )}
                              </span>
                            </span>
                            {loadingId === m.id && (
                              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
          {tab === "file" && (
            <div>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.tsv,.txt,.xml,.gpx,text/csv,application/gpx+xml,application/xml"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) void addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                disabled={loadingId === "file"}
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (e.dataTransfer.files.length) {
                    void addFiles(e.dataTransfer.files);
                  }
                }}
                className="flex min-h-[160px] w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 text-center text-sm text-slate-600 hover:border-brand hover:text-brand disabled:opacity-50"
              >
                {loadingId === "file" ? (
                  <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
                ) : (
                  <>
                    <span className="text-2xl font-light">↑</span>
                    Déposer CSV, XML CycleGen ou GPX
                    <span className="text-[11px] text-slate-400">
                      ou cliquer pour parcourir — plusieurs fichiers OK
                    </span>
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CompareTooltip({
  active,
  payload,
  label,
  unit,
  xMode,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{
    name?: string;
    value?: number;
    color?: string;
  }>;
  label?: string | number;
  unit: string;
  xMode: CompareXMode;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded border border-slate-200 bg-white/95 px-2 py-1.5 text-[10px] shadow-sm">
      <div className="mb-1 font-semibold tabular-nums text-slate-500">
        {formatXLabel(Number(label), xMode)}
      </div>
      <ul className="space-y-0.5">
        {payload.map((p) => (
          <li
            key={String(p.name)}
            className="flex items-center gap-1.5 tabular-nums text-slate-800"
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: p.color }}
            />
            <span className="max-w-[140px] truncate text-slate-500">
              {p.name}
            </span>
            {Number(p.value).toFixed(unit === "km/h" || unit === "%" ? 1 : 2)}{" "}
            {unit}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function CompareStudio() {
  const [cycles, setCycles] = useState<CompareCycle[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [chartTitle, setChartTitle] = useState("Comparaison de cycles");
  const [exporting, setExporting] = useState(false);
  const [inspectOpen, setInspectOpen] = useState(false);
  const [inspectSeries, setInspectSeries] =
    useState<InspectSeriesId>("v_kmh");
  const chartsRef = useRef<HTMLDivElement>(null);
  const [xMode, setXMode] = useState<CompareXMode>("time");
  const [show, setShow] = useState<Record<CompareSeriesKey, boolean>>({
    v: true,
    a_lon: true,
    a_lat: true,
    slope: true,
    p_trac_kw: true,
    p_regen_kw: true,
    p_wheel_kw: true,
    wheel_torque_nm: true,
    wheel_rpm: true,
  });
  const [showLimits, setShowLimits] = useState({
    legal: false,
    traffic: false,
    curve: false,
  });
  const [enabledIds, setEnabledIds] = useState<Set<string>>(new Set());
  /** Largeur de fenêtre (0 = entier). Unité = s ou m selon xMode. */
  const [windowWidth, setWindowWidth] = useState(0);
  const [windowStart, setWindowStart] = useState(0);
  const didHydrateRef = useRef(false);

  const addedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const c of cycles) {
      if (c.corpusId) keys.add(`corpus:${c.corpusId}`);
      if (c.libraryCycleId) keys.add(`lib:${c.libraryCycleId}`);
    }
    return keys;
  }, [cycles]);

  const addCycle = useCallback((c: SavedCycle) => {
    const libraryCycleId = c.corpusId ? null : c.id;
    const instanceId = newCycleInstanceId(c.origin || "vs");
    setCycles((prev) => {
      const sameName = prev.filter(
        (x) => x.name === c.name || x.label === c.name
      ).length;
      const color = COMPARE_PALETTE[prev.length % COMPARE_PALETTE.length];
      const geo = Array.isArray(c.geometry) ? c.geometry : [];
      const enriched = enrichSeriesFromGps({
        time: c.time,
        velocity: c.velocity,
        acceleration: c.acceleration,
        a_lat: c.a_lat,
        slope: c.slope,
        position: c.position,
        lat: geo.map((g) => g.lat),
        lon: geo.map((g) => g.lon),
      });
      const stats = computeCycleStats({
        time: c.time,
        velocity: c.velocity,
        acceleration: enriched.acceleration,
        slope: enriched.slope,
        position: enriched.position,
        a_lat: enriched.a_lat,
      });
      const label =
        sameName > 0 ? `${c.name} (${sameName + 1})` : c.name;
      return [
        ...prev,
        {
          ...c,
          id: instanceId,
          libraryCycleId,
          stats,
          acceleration: enriched.acceleration,
          slope: enriched.slope,
          position: enriched.position,
          a_lat: enriched.a_lat,
          geometry: geo.length >= 2 ? geo : enriched.geometry,
          color,
          label,
          offsetTime_s: 0,
          offsetDist_m: 0,
          vehicleId: defaultVehicleIdForCycle(c),
        },
      ];
    });
    setEnabledIds((prev) => new Set([...prev, instanceId]));
  }, []);

  useEffect(() => {
    if (didHydrateRef.current) return;
    const batch = peekStashedCompareCycles();
    if (!batch.length) return;
    didHydrateRef.current = true;
    for (const c of batch) addCycle(c);
  }, [addCycle]);

  useEffect(() => {
    if (cycles.length === 0) return;
    const t = window.setTimeout(() => clearStashedCompareCycles(), 1500);
    return () => window.clearTimeout(t);
  }, [cycles.length]);

  const removeCycle = (id: string) => {
    setCycles((prev) => prev.filter((c) => c.id !== id));
    setEnabledIds((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
  };

  const updateCycle = (
    id: string,
    patch: Partial<
      Pick<
        CompareCycle,
        "color" | "label" | "offsetTime_s" | "offsetDist_m" | "vehicleId"
      >
    >
  ) => {
    setCycles((prev) =>
      prev.map((c) => (c.id === id ? { ...c, ...patch } : c))
    );
  };

  const active = cycles.filter((c) => enabledIds.has(c.id));

  const versusInputs = useMemo(
    () =>
      active.map((c) => ({
        id: c.id,
        label: c.label || c.name,
        time: c.time,
        velocity: c.velocity,
        acceleration: c.acceleration,
        a_lat: c.a_lat,
        slope: c.slope,
        position: c.position,
        meta: c.meta,
        source: c.source,
        origin: c.origin,
        vehicleId: c.vehicleId,
      })),
    [active]
  );

  const versusRunMetaList = useMemo(
    () =>
      active.map((c) =>
        buildInspectRunMeta({
          routeLabel: c.meta?.routeLabel ?? c.name,
          trafficSource: c.meta?.trafficSource ?? c.source,
          driverProfile: c.meta?.driverProfile,
          physics: c.meta?.physics,
          aY: c.meta?.aY,
          maxSpeedKmh: c.meta?.maxSpeedKmh,
          envelopeMask: c.meta?.envelopeMask,
          includeTrafficLights: c.meta?.includeTrafficLights,
          feuxCount: c.corridor?.S_feux?.length ?? undefined,
          slopeAlgo: c.meta?.slopeAlgo,
          routingProfile: c.meta?.routingProfile,
          departAt: c.meta?.departAt,
          driverZonesEnabled: c.meta?.driverZonesEnabled,
          driverZonesCount: c.meta?.driverZones?.length,
          distanceM: c.stats.distance_m,
          durationS: c.stats.duration_s,
          avgSpeedKmh: c.stats.v_mean_kmh,
          generatedAt: c.savedAt,
          profileStatus: c.origin,
          originLat: c.meta?.origin_lat,
          originLon: c.meta?.origin_lon,
          destLat: c.meta?.destination_lat,
          destLon: c.meta?.destination_lon,
          saveTitle: c.meta?.saveTitle,
          vehicle: vehicleOf(c),
        })
      ),
    [active]
  );

  const openVersusInspect = (series: InspectSeriesId) => {
    setInspectSeries(series);
    setInspectOpen(true);
  };

  const xExtent = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of active) {
      const n = c.time.length;
      if (n < 1) continue;
      const x0 = xAt(c, 0, xMode);
      const x1 = xAt(c, n - 1, xMode);
      lo = Math.min(lo, x0, x1);
      hi = Math.max(hi, x0, x1);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
      return { lo: 0, hi: 1 };
    }
    return { lo, hi };
  }, [active, xMode]);

  const domain: [number, number] = useMemo(() => {
    const span = xExtent.hi - xExtent.lo;
    if (windowWidth <= 0 || span <= 0) return [xExtent.lo, xExtent.hi];
    const w = Math.min(windowWidth, span);
    const maxStart = Math.max(xExtent.lo, xExtent.hi - w);
    const x0 = Math.min(Math.max(xExtent.lo, windowStart), maxStart);
    return [x0, x0 + w];
  }, [windowWidth, windowStart, xExtent]);

  const buildChart = useCallback(
    (
      pick: (c: CompareCycle, i: number) => number,
      extras?: {
        key: string;
        color: string;
        dash?: string;
        values: { x: number; y: number }[];
      }[]
    ) => {
      const x0 = domain[0];
      const x1 = domain[1];
      const dx = Math.max(
        xMode === "time" ? 0.5 : 2,
        (x1 - x0) / 400
      );
      const rows: Record<string, number>[] = [];
      for (let x = x0; x <= x1 + 1e-6; x += dx) {
        const row: Record<string, number> = { x };
        for (const c of active) {
          let best = 0;
          let bestD = Infinity;
          for (let i = 0; i < c.time.length; i++) {
            const d = Math.abs(xAt(c, i, xMode) - x);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
          // Hors domaine de la courbe (après offset) → NaN pour ne pas extrapoler
          const xFirst = xAt(c, 0, xMode);
          const xLast = xAt(c, c.time.length - 1, xMode);
          const inRange =
            x >= Math.min(xFirst, xLast) - dx &&
            x <= Math.max(xFirst, xLast) + dx;
          row[c.id] = inRange ? pick(c, best) : Number.NaN;
        }
        for (const ex of extras ?? []) {
          let best = 0;
          let bestD = Infinity;
          for (let i = 0; i < ex.values.length; i++) {
            const d = Math.abs(ex.values[i].x - x);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
          row[ex.key] = ex.values[best]?.y ?? Number.NaN;
        }
        rows.push(row);
      }
      return rows;
    },
    [active, domain, xMode]
  );

  const limitExtras = useMemo(() => {
    const out: {
      key: string;
      color: string;
      dash?: string;
      values: { x: number; y: number }[];
      kind: "legal" | "traffic" | "curve";
    }[] = [];
    for (const c of active) {
      if (!c.limits) continue;
      const toXY = (yArr: number[]) =>
        c.time.map((_, i) => ({
          x: xAt(c, i, xMode),
          y: yArr[i] ?? Number.NaN,
        }));
      if (showLimits.legal) {
        out.push({
          key: `${c.id}__legal`,
          color: "#64748b",
          dash: "2 2",
          kind: "legal",
          values: toXY(c.limits.legal_kmh),
        });
      }
      if (showLimits.traffic) {
        out.push({
          key: `${c.id}__traffic`,
          color: "#ea580c",
          dash: "4 2",
          kind: "traffic",
          values: toXY(c.limits.traffic_kmh),
        });
      }
      if (showLimits.curve) {
        out.push({
          key: `${c.id}__curve`,
          color: "#7c3aed",
          dash: "3 3",
          kind: "curve",
          values: toXY(c.limits.curve_kmh),
        });
      }
    }
    return out;
  }, [active, showLimits, xMode]);

  const hasCyclegenLimits = active.some((c) => !!c.limits);

  const chartV = useMemo(
    () =>
      buildChart(
        (c, i) => (c.velocity[i] ?? 0) * 3.6,
        show.v ? limitExtras : []
      ),
    [buildChart, limitExtras, show.v]
  );
  const chartALon = useMemo(
    () => buildChart((c, i) => c.acceleration[i] ?? 0),
    [buildChart]
  );
  const chartALat = useMemo(
    () => buildChart((c, i) => c.a_lat[i] ?? 0),
    [buildChart]
  );
  const chartSlope = useMemo(
    () => buildChart((c, i) => slopeFromRad(c.slope[i] ?? 0, "percent")),
    [buildChart]
  );

  const buildVehicleChart = useCallback(
    (series: InspectSeriesId) =>
      buildChart((c, i) =>
        inspectSampleValue({
          series,
          v_mps: c.velocity[i] ?? 0,
          a_lon_mps2: c.acceleration[i] ?? 0,
          a_lat_mps2: c.a_lat[i] ?? 0,
          alpha_rad: c.slope[i] ?? 0,
          vehicle: vehicleOf(c),
          slopeUnit: "percent",
        })
      ),
    [buildChart]
  );

  const chartPTrac = useMemo(
    () => buildVehicleChart("p_trac_kw"),
    [buildVehicleChart]
  );
  const chartPRegen = useMemo(
    () => buildVehicleChart("p_regen_kw"),
    [buildVehicleChart]
  );
  const chartPWheel = useMemo(
    () => buildVehicleChart("p_wheel_kw"),
    [buildVehicleChart]
  );
  const chartTorque = useMemo(
    () => buildVehicleChart("wheel_torque_nm"),
    [buildVehicleChart]
  );
  const chartRpm = useMemo(
    () => buildVehicleChart("wheel_rpm"),
    [buildVehicleChart]
  );

  const exportJpeg = useCallback(async () => {
    if (!chartsRef.current) return;
    setExporting(true);
    try {
      const dataUrl = await toJpeg(chartsRef.current, {
        quality: 0.95,
        pixelRatio: 2,
        backgroundColor: "#ffffff",
        cacheBust: true,
      });
      const a = document.createElement("a");
      const safe =
        chartTitle.trim().replace(/[^\w\-]+/g, "_").slice(0, 60) || "compare";
      a.download = `${safe}.jpg`;
      a.href = dataUrl;
      a.click();
    } catch (e) {
      console.error(e);
      window.alert("Export JPEG échoué.");
    } finally {
      setExporting(false);
    }
  }, [chartTitle]);

  const { setHeaderChrome } = useHeaderChrome();
  useEffect(() => {
    setHeaderChrome({
      kind: "versus",
      xMode,
      onXMode: (mode) => {
        if (mode === xMode) return;
        setXMode(mode);
        setWindowWidth(0);
        setWindowStart(0);
      },
      onExplorer: () => openVersusInspect("v_kmh"),
      onJpeg: () => {
        void exportJpeg();
      },
      jpegBusy: exporting,
      canExplore: active.length > 0,
      onAddCycle: () => setAddOpen(true),
    });
    return () => setHeaderChrome(null);
  }, [
    setHeaderChrome,
    xMode,
    exporting,
    active.length,
    exportJpeg,
  ]);

  const renderMulti = (
    data: Record<string, number>[],
    unit: string,
    includeLimits = false,
    seriesColor?: string
  ) => (
    <div className="h-48 w-full min-h-[12rem] lg:h-56">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
          <XAxis
            dataKey="x"
            type="number"
            domain={domain}
            tickFormatter={(v) => formatXTick(Number(v), xMode)}
            tick={{ fontSize: 10, fill: "#64748b" }}
          />
          <YAxis
            tick={{ fontSize: 10, fill: "#64748b" }}
            width={42}
            unit={` ${unit}`}
          />
          <Tooltip content={<CompareTooltip unit={unit} xMode={xMode} />} />
          {active.map((c) => {
            const idx = Math.max(
              0,
              cycles.findIndex((x) => x.id === c.id)
            );
            return (
            <Line
              key={c.id}
              type="monotone"
              dataKey={c.id}
              name={c.label || c.name}
              stroke={seriesColor ?? c.color}
              strokeWidth={idx === 0 ? 2.25 : 1.75}
              strokeDasharray={VERSUS_CYCLE_DASH[idx % VERSUS_CYCLE_DASH.length]}
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
            );
          })}
          {includeLimits &&
            limitExtras.map((ex) => (
              <Line
                key={ex.key}
                type="stepAfter"
                dataKey={ex.key}
                name={`${ex.kind}`}
                stroke={ex.color}
                strokeWidth={1.25}
                strokeDasharray={ex.dash}
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
              />
            ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );

  const windowUnit = xMode === "time" ? "s" : "m";
  const windowStep =
    xMode === "time"
      ? Math.max(0.5, (xExtent.hi - xExtent.lo) / 400)
      : Math.max(1, (xExtent.hi - xExtent.lo) / 400);

  return (
    <div className="flex h-full flex-col bg-slate-50 text-slate-900">
      <VersusFidelityBand />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Colonne gauche — cartes */}
        <aside className="flex min-h-0 w-full flex-col border-b border-slate-200 bg-slate-50 lg:w-[min(42%,440px)] lg:border-b-0 lg:border-r">
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            <input
              value={chartTitle}
              onChange={(e) => setChartTitle(e.target.value)}
              className="w-full rounded border border-transparent bg-transparent px-0.5 text-sm font-bold tracking-wide text-slate-900 outline-none hover:border-slate-200 focus:border-slate-300 focus:bg-white"
              title="Titre (éditable)"
            />
            {cycles.length === 0 && (
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="flex min-h-[120px] w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white text-sm text-slate-500 hover:border-brand hover:text-brand"
              >
                <span className="text-2xl font-light">+</span>
                Ajouter un cycle
              </button>
            )}
            {cycles.map((c) => (
              <CycleCard
                key={c.id}
                cycle={c}
                onRemove={() => removeCycle(c.id)}
                onColor={(color) => updateCycle(c.id, { color })}
                onLabel={(label) => updateCycle(c.id, { label })}
                onOffset={(patch) => updateCycle(c.id, patch)}
                onVehicle={(vehicleId) => updateCycle(c.id, { vehicleId })}
              />
            ))}
            {cycles.length > 0 && (
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white py-2.5 text-sm font-semibold text-slate-500 hover:border-brand hover:text-brand"
              >
                <span className="text-xl leading-none">+</span> Ajouter
              </button>
            )}
          </div>
        </aside>

        {/* Colonne droite — graphes */}
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white">
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Courbes
            </span>
            {COMPARE_SERIES_TOGGLES.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => setShow((s) => ({ ...s, [key]: !s[key] }))}
                className={`rounded-md px-2 py-1 text-[10px] font-semibold ${
                  show[key]
                    ? "bg-slate-900 text-white"
                    : "bg-slate-100 text-slate-500"
                }`}
              >
                {label}
              </button>
            ))}
            {hasCyclegenLimits && (
              <>
                <span className="ml-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  Limites
                </span>
                {(
                  [
                    ["legal", "Légal"],
                    ["traffic", "Trafic"],
                    ["curve", "Virage"],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() =>
                      setShowLimits((s) => ({ ...s, [k]: !s[k] }))
                    }
                    className={`rounded-md px-2 py-1 text-[10px] font-semibold ${
                      showLimits[k]
                        ? "bg-amber-600 text-white"
                        : "bg-amber-50 text-amber-800"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </>
            )}
          </div>

          {/* Légende : couleur carte · trait plein / tirets sur les graphes */}
          {cycles.length > 0 && (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2">
              <span
                className="text-[10px] font-semibold uppercase tracking-wide text-slate-400"
                title="Sur les graphes : couleur = grandeur, plein / tirets = cycle"
              >
                Légende
              </span>
              {cycles.map((c, idx) => {
                const dash =
                  VERSUS_CYCLE_DASH[idx % VERSUS_CYCLE_DASH.length];
                return (
                  <div
                    key={c.id}
                    className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-1 ${
                      enabledIds.has(c.id)
                        ? "border-slate-200 bg-white"
                        : "border-slate-100 bg-slate-50 opacity-50"
                    }`}
                  >
                    <button
                      type="button"
                      title={enabledIds.has(c.id) ? "Masquer" : "Afficher"}
                      onClick={() =>
                        setEnabledIds((prev) => {
                          const n = new Set(prev);
                          if (n.has(c.id)) n.delete(c.id);
                          else n.add(c.id);
                          return n;
                        })
                      }
                      className="text-[9px] font-bold text-slate-400 hover:text-slate-700"
                    >
                      {enabledIds.has(c.id) ? "●" : "○"}
                    </button>
                    <svg
                      width="28"
                      height="8"
                      aria-hidden
                      className="shrink-0"
                    >
                      <title>
                        {idx === 0 ? "Trait plein (cycle A)" : "Tirets"}
                      </title>
                      <line
                        x1="0"
                        y1="4"
                        x2="28"
                        y2="4"
                        stroke="#0f172a"
                        strokeWidth="2.5"
                        strokeDasharray={dash ?? undefined}
                      />
                    </svg>
                    <ColorPicker
                      value={c.color}
                      onChange={(color) => updateCycle(c.id, { color })}
                    />
                    <input
                      value={c.label}
                      onChange={(e) =>
                        updateCycle(c.id, { label: e.target.value })
                      }
                      className="w-[7.5rem] truncate rounded border border-transparent bg-transparent px-0.5 text-[10px] font-semibold text-slate-800 outline-none hover:border-slate-200 focus:border-slate-300"
                      title="Renommer la légende"
                    />
                    <label
                      className="inline-flex items-center gap-0.5 text-[9px] text-slate-500"
                      title={
                        xMode === "time"
                          ? "Offset temps (s)"
                          : "Offset distance (m)"
                      }
                    >
                      Δ
                      <input
                        type="number"
                        step={xMode === "time" ? 1 : 10}
                        value={
                          xMode === "time" ? c.offsetTime_s : c.offsetDist_m
                        }
                        onChange={(e) => {
                          const v = Number(e.target.value) || 0;
                          updateCycle(
                            c.id,
                            xMode === "time"
                              ? { offsetTime_s: v }
                              : { offsetDist_m: v }
                          );
                        }}
                        className="w-12 rounded border border-slate-200 px-0.5 py-0.5 tabular-nums text-[10px] text-slate-800"
                      />
                      {windowUnit}
                    </label>
                  </div>
                );
              })}
            </div>
          )}

          <div className="shrink-0 border-b border-slate-100 px-3 py-2">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                Intervalle {xMode === "time" ? "temps" : "distance"}
              </span>
              <div className="flex items-center gap-2 text-[10px] text-slate-600">
                <label className="inline-flex items-center gap-1">
                  Largeur
                  <input
                    type="number"
                    min={0}
                    max={Math.ceil(xExtent.hi - xExtent.lo) || 0}
                    step={xMode === "time" ? 10 : 100}
                    value={windowWidth}
                    onChange={(e) =>
                      setWindowWidth(Number(e.target.value) || 0)
                    }
                    className="w-16 rounded border border-slate-200 px-1 py-0.5 tabular-nums"
                    title="0 = trajet entier"
                  />
                  {windowUnit}
                </label>
                <span className="tabular-nums text-slate-500">
                  {formatXTick(domain[0], xMode)} →{" "}
                  {formatXTick(domain[1], xMode)}
                </span>
              </div>
            </div>
            <input
              type="range"
              min={xExtent.lo}
              max={Math.max(
                xExtent.lo,
                xExtent.hi - (windowWidth || 0)
              )}
              step={windowStep}
              value={windowStart}
              disabled={windowWidth <= 0 || xExtent.hi <= xExtent.lo}
              onChange={(e) => setWindowStart(Number(e.target.value))}
              className="w-full accent-brand disabled:opacity-30"
            />
          </div>

          <div
            ref={chartsRef}
            className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-white p-3"
          >
            <h2 className="text-center text-sm font-bold text-slate-800">
              {chartTitle}
            </h2>
            {active.length === 0 ? (
              <p className="py-12 text-center text-sm text-slate-400">
                Ajoutez et activez au moins un cycle pour comparer.
              </p>
            ) : (
              <>
                {show.v && (
                  <div className="rounded-xl border border-slate-200 bg-white p-3">
                    <button
                      type="button"
                      onClick={() => openVersusInspect("v_kmh")}
                      className="mb-1 flex w-full items-center justify-between text-left text-xs font-semibold text-slate-700 hover:text-brand"
                      title="Agrandir dans le volet d’exploration"
                    >
                      <span>Vitesse (km/h)</span>
                      <span className="text-[10px] font-medium text-slate-400">
                        Agrandir
                      </span>
                    </button>
                    {renderMulti(
                      chartV,
                      "km/h",
                      true,
                      INSPECT_SERIES.find((s) => s.id === "v_kmh")?.color
                    )}
                  </div>
                )}
                {show.a_lon && (
                  <div className="rounded-xl border border-slate-200 bg-white p-3">
                    <button
                      type="button"
                      onClick={() => openVersusInspect("a_lon")}
                      className="mb-1 flex w-full items-center justify-between text-left text-xs font-semibold text-slate-700 hover:text-brand"
                      title="Agrandir dans le volet d’exploration"
                    >
                      <span>Accélération longitudinale (m/s²)</span>
                      <span className="text-[10px] font-medium text-slate-400">
                        Agrandir
                      </span>
                    </button>
                    {renderMulti(
                      chartALon,
                      "m/s²",
                      false,
                      INSPECT_SERIES.find((s) => s.id === "a_lon")?.color
                    )}
                  </div>
                )}
                {show.a_lat && (
                  <div className="rounded-xl border border-slate-200 bg-white p-3">
                    <button
                      type="button"
                      onClick={() => openVersusInspect("a_lat")}
                      className="mb-1 flex w-full items-center justify-between text-left text-xs font-semibold text-slate-700 hover:text-brand"
                      title="Agrandir dans le volet d’exploration"
                    >
                      <span>Accélération tangentielle / latérale (m/s²)</span>
                      <span className="text-[10px] font-medium text-slate-400">
                        Agrandir
                      </span>
                    </button>
                    {renderMulti(
                      chartALat,
                      "m/s²",
                      false,
                      INSPECT_SERIES.find((s) => s.id === "a_lat")?.color
                    )}
                  </div>
                )}
                {show.slope && (
                  <div className="rounded-xl border border-slate-200 bg-white p-3">
                    <button
                      type="button"
                      onClick={() => openVersusInspect("slope")}
                      className="mb-1 flex w-full items-center justify-between text-left text-xs font-semibold text-slate-700 hover:text-brand"
                      title="Agrandir dans le volet d’exploration"
                    >
                      <span>Pente (%)</span>
                      <span className="text-[10px] font-medium text-slate-400">
                        Agrandir
                      </span>
                    </button>
                    {renderMulti(
                      chartSlope,
                      "%",
                      false,
                      INSPECT_SERIES.find((s) => s.id === "slope")?.color
                    )}
                  </div>
                )}
                {show.p_trac_kw && (
                  <div className="rounded-xl border border-slate-200 bg-white p-3">
                    <button
                      type="button"
                      onClick={() => openVersusInspect("p_trac_kw")}
                      className="mb-1 flex w-full items-center justify-between text-left text-xs font-semibold text-slate-700 hover:text-brand"
                      title="Agrandir dans le volet d’exploration"
                    >
                      <span>Puissance traction (kW)</span>
                      <span className="text-[10px] font-medium text-slate-400">
                        Agrandir
                      </span>
                    </button>
                    {renderMulti(
                      chartPTrac,
                      "kW",
                      false,
                      INSPECT_SERIES.find((s) => s.id === "p_trac_kw")?.color
                    )}
                  </div>
                )}
                {show.p_regen_kw && (
                  <div className="rounded-xl border border-slate-200 bg-white p-3">
                    <button
                      type="button"
                      onClick={() => openVersusInspect("p_regen_kw")}
                      className="mb-1 flex w-full items-center justify-between text-left text-xs font-semibold text-slate-700 hover:text-brand"
                      title="Agrandir dans le volet d’exploration"
                    >
                      <span>Puissance freinage |P| (kW)</span>
                      <span className="text-[10px] font-medium text-slate-400">
                        Agrandir
                      </span>
                    </button>
                    {renderMulti(
                      chartPRegen,
                      "kW",
                      false,
                      INSPECT_SERIES.find((s) => s.id === "p_regen_kw")?.color
                    )}
                  </div>
                )}
                {show.p_wheel_kw && (
                  <div className="rounded-xl border border-slate-200 bg-white p-3">
                    <button
                      type="button"
                      onClick={() => openVersusInspect("p_wheel_kw")}
                      className="mb-1 flex w-full items-center justify-between text-left text-xs font-semibold text-slate-700 hover:text-brand"
                      title="Agrandir dans le volet d’exploration"
                    >
                      <span>Puissance mécanique (kW)</span>
                      <span className="text-[10px] font-medium text-slate-400">
                        Agrandir
                      </span>
                    </button>
                    {renderMulti(
                      chartPWheel,
                      "kW",
                      false,
                      INSPECT_SERIES.find((s) => s.id === "p_wheel_kw")?.color
                    )}
                  </div>
                )}
                {show.wheel_torque_nm && (
                  <div className="rounded-xl border border-slate-200 bg-white p-3">
                    <button
                      type="button"
                      onClick={() => openVersusInspect("wheel_torque_nm")}
                      className="mb-1 flex w-full items-center justify-between text-left text-xs font-semibold text-slate-700 hover:text-brand"
                      title="Agrandir dans le volet d’exploration"
                    >
                      <span>Couple à la roue (N·m)</span>
                      <span className="text-[10px] font-medium text-slate-400">
                        Agrandir
                      </span>
                    </button>
                    {renderMulti(
                      chartTorque,
                      "N·m",
                      false,
                      INSPECT_SERIES.find((s) => s.id === "wheel_torque_nm")
                        ?.color
                    )}
                  </div>
                )}
                {show.wheel_rpm && (
                  <div className="rounded-xl border border-slate-200 bg-white p-3">
                    <button
                      type="button"
                      onClick={() => openVersusInspect("wheel_rpm")}
                      className="mb-1 flex w-full items-center justify-between text-left text-xs font-semibold text-slate-700 hover:text-brand"
                      title="Agrandir dans le volet d’exploration"
                    >
                      <span>Vitesse rotation roue (tr/min)</span>
                      <span className="text-[10px] font-medium text-slate-400">
                        Agrandir
                      </span>
                    </button>
                    {renderMulti(
                      chartRpm,
                      "tr/min",
                      false,
                      INSPECT_SERIES.find((s) => s.id === "wheel_rpm")?.color
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      </div>

      <AddCycleModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdd={addCycle}
        addedKeys={addedKeys}
      />

      <VersusInspectDrawer
        open={inspectOpen}
        onClose={() => setInspectOpen(false)}
        cycles={versusInputs}
        initialSeries={inspectSeries}
        runMetaList={versusRunMetaList}
      />
    </div>
  );
}
