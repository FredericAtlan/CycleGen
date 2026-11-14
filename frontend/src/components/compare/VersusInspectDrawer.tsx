"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toJpeg } from "html-to-image";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  INSPECT_SERIES,
  inspectSampleValue,
  seriesShort,
  type InspectSeriesId,
  type RollingMode,
} from "@/lib/chartInspectData";
import {
  metaLinesForCsv,
  type InspectRunMeta,
} from "@/lib/inspectRunMeta";
import { formatTimeLabel } from "@/lib/chartTime";
import type { SavedCycle } from "@/lib/cycleLibrary";
import { getVehicle, type VehicleCard } from "@/lib/vehicleLibrary";

/** Dash patterns by cycle index: 0 = solid, then dashed variants. */
export const VERSUS_CYCLE_DASH: (string | undefined)[] = [
  undefined,
  "7 4",
  "3 3",
  "10 3 2 3",
  "2 2",
];

export type VersusCycleInput = {
  id: string;
  label: string;
  time: number[];
  velocity: number[];
  acceleration: number[];
  a_lat: number[];
  slope: number[];
  position: number[];
  meta?: SavedCycle["meta"];
  source?: string;
  origin?: string;
  /** Vehicle for P / couple (road load). */
  vehicleId?: string | null;
};

export type VersusInspectDrawerProps = {
  open: boolean;
  onClose: () => void;
  cycles: VersusCycleInput[];
  initialSeries?: InspectSeriesId;
  runMetaList?: InspectRunMeta[];
};

type VertCursor = { id: string; t: number; color: string; label: string };

type SeriesPoint = { t: number; s: number; [cycleId: string]: number };

const CURSOR_COLORS = [
  "#ef4444",
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
  "#ec4899",
];

const WINDOW_PRESETS = [1, 5, 10, 30, 60, 100, 300] as const;

/** All analysis series, including vehicle road-load when a vehicle is set. */
const VERSUS_SERIES = INSPECT_SERIES;

function meta(id: InspectSeriesId) {
  return INSPECT_SERIES.find((s) => s.id === id)!;
}

function vehicleForCycle(c: VersusCycleInput): VehicleCard | null {
  const id = c.vehicleId || c.meta?.vehicleId || null;
  return id ? getVehicle(id) : null;
}

function valueAt(
  c: VersusCycleInput,
  i: number,
  series: InspectSeriesId
): number {
  return inspectSampleValue({
    series,
    v_mps: c.velocity[i] ?? 0,
    a_lon_mps2: c.acceleration[i] ?? 0,
    a_lat_mps2: c.a_lat[i] ?? 0,
    alpha_rad: c.slope[i] ?? 0,
    vehicle: vehicleForCycle(c),
    slopeUnit: "percent",
  });
}

function buildOverlayRows(
  cycles: VersusCycleInput[],
  series: InspectSeriesId,
  t0: number,
  t1: number
): SeriesPoint[] {
  if (!cycles.length) return [];
  const dt = Math.max(0.25, (t1 - t0) / 500);
  const out: SeriesPoint[] = [];
  for (let t = t0; t <= t1 + 1e-6; t += dt) {
    const row: SeriesPoint = { t, s: 0 };
    let sAcc = 0;
    let sN = 0;
    for (const c of cycles) {
      if (c.time.length < 1) {
        row[c.id] = Number.NaN;
        continue;
      }
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < c.time.length; i++) {
        const d = Math.abs((c.time[i] ?? 0) - t);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      const tFirst = c.time[0] ?? 0;
      const tLast = c.time[c.time.length - 1] ?? 0;
      const inRange = t >= tFirst - dt && t <= tLast + dt;
      row[c.id] = inRange ? valueAt(c, best, series) : Number.NaN;
      if (inRange && Number.isFinite(c.position[best])) {
        sAcc += c.position[best];
        sN += 1;
      }
    }
    row.s = sN ? sAcc / sN : 0;
    out.push(row);
  }
  return out;
}

function meanOfKey(rows: SeriesPoint[], key: string): number | null {
  const vals = rows.map((r) => r[key]).filter((v) => Number.isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function rmsOfKey(rows: SeriesPoint[], key: string): number | null {
  const vals = rows.map((r) => r[key]).filter((v) => Number.isFinite(v));
  if (!vals.length) return null;
  return Math.sqrt(vals.reduce((a, b) => a + b * b, 0) / vals.length);
}

/** Causal rolling on overlay rows for one cycle key. */
function withRollingOnKey(
  rows: SeriesPoint[],
  key: string,
  windowSec: number,
  mode: RollingMode
): SeriesPoint[] {
  if (!rows.length || !(windowSec > 0)) return rows;
  let j = 0;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  const out: SeriesPoint[] = [];
  for (let i = 0; i < rows.length; i++) {
    const vi = rows[i][key];
    if (Number.isFinite(vi)) {
      sum += vi;
      sumSq += vi * vi;
      count += 1;
    }
    const tLo = rows[i].t - windowSec;
    while (j < i && rows[j].t < tLo - 1e-9) {
      const vj = rows[j][key];
      if (Number.isFinite(vj)) {
        sum -= vj;
        sumSq -= vj * vj;
        count -= 1;
      }
      j += 1;
    }
    const rollKey = `${key}__roll`;
    const rolling =
      count > 0
        ? mode === "rms"
          ? Math.sqrt(Math.max(0, sumSq / count))
          : sum / count
        : Number.NaN;
    out.push({ ...rows[i], [rollKey]: rolling });
  }
  return out;
}

function OverlayChart({
  data,
  cycles,
  seriesId,
  label,
  color,
  unit,
  xDomain,
  cursors,
  placeMode,
  onPlace,
  showRolling,
  meanBits,
}: {
  data: SeriesPoint[];
  cycles: VersusCycleInput[];
  seriesId: InspectSeriesId;
  label: string;
  color: string;
  unit: string;
  xDomain: [number, number];
  cursors: VertCursor[];
  placeMode: boolean;
  onPlace: (t: number) => void;
  showRolling: boolean;
  meanBits: string;
}) {
  const short = seriesShort(seriesId);
  return (
    <div className="flex h-full min-h-0 flex-col rounded-md border border-slate-200 bg-white">
      <div className="flex shrink-0 items-baseline justify-between gap-2 border-b border-slate-100 px-2 py-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: color }}
          />
          <span className="truncate text-[11px] font-semibold text-slate-800">
            {label}
          </span>
          <span className="text-[9px] text-slate-400">{unit}</span>
        </div>
        <span className="max-w-[55%] truncate text-[9px] tabular-nums text-slate-500">
          {meanBits}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{ top: 8, right: 10, left: 2, bottom: 2 }}
            onClick={(state) => {
              if (!placeMode || !state?.activeLabel) return;
              const t = Number(state.activeLabel);
              if (Number.isFinite(t)) onPlace(t);
            }}
            style={{ cursor: placeMode ? "crosshair" : "default" }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              dataKey="t"
              type="number"
              domain={xDomain}
              allowDataOverflow
              tick={{ fontSize: 10, fill: "#64748b" }}
              tickFormatter={(v) => formatTimeLabel(Number(v))}
            />
            <YAxis
              width={44}
              tick={{ fontSize: 10, fill: "#64748b" }}
              tickFormatter={(v) => Number(v).toFixed(1)}
            />
            <Tooltip
              contentStyle={{ fontSize: 11, padding: "4px 8px" }}
              labelFormatter={(x) => `t = ${Number(x).toFixed(1)} s`}
              formatter={(v, name) => [
                typeof v === "number" && Number.isFinite(v)
                  ? `${v.toFixed(2)} ${unit}`
                  : "—",
                String(name),
              ]}
            />
            {cursors.map((c) => (
              <ReferenceLine
                key={c.id}
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
            {cycles.map((c, idx) => (
              <Line
                key={c.id}
                type="monotone"
                dataKey={c.id}
                name={`${short}${idx === 0 ? "" : `'`.repeat(Math.min(idx, 3))}`}
                stroke={color}
                strokeWidth={idx === 0 ? 2.25 : 1.75}
                strokeDasharray={VERSUS_CYCLE_DASH[idx % VERSUS_CYCLE_DASH.length]}
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
              />
            ))}
            {showRolling &&
              cycles.map((c, idx) => (
                <Line
                  key={`${c.id}-roll`}
                  type="monotone"
                  dataKey={`${c.id}__roll`}
                  name={`${short}·F${idx + 1}`}
                  stroke="#0f172a"
                  strokeWidth={1}
                  strokeDasharray={
                    idx === 0 ? "2 2" : VERSUS_CYCLE_DASH[idx % VERSUS_CYCLE_DASH.length]
                  }
                  strokeOpacity={0.55}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls={false}
                />
              ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default function VersusInspectDrawer({
  open,
  onClose,
  cycles,
  initialSeries = "v_kmh",
  runMetaList = [],
}: VersusInspectDrawerProps) {
  const [mounted, setMounted] = useState(false);
  const [selected, setSelected] = useState<InspectSeriesId[]>([initialSeries]);
  const [gridRows, setGridRows] = useState(2);
  const [gridCols, setGridCols] = useState(2);
  const [title, setTitle] = useState("Versus — exploration");
  const [labels, setLabels] = useState<Record<InspectSeriesId, string>>(() =>
    Object.fromEntries(
      INSPECT_SERIES.map((s) => [s.id, s.defaultLabel])
    ) as Record<InspectSeriesId, string>
  );
  const [cursors, setCursors] = useState<VertCursor[]>([]);
  const [placeMode, setPlaceMode] = useState(false);
  const [rollingOn, setRollingOn] = useState(false);
  const [rollingMode, setRollingMode] = useState<RollingMode>("mean");
  const [windowSec, setWindowSec] = useState(10);
  const [exporting, setExporting] = useState<"jpeg" | "excel" | null>(null);
  const [metaOpen, setMetaOpen] = useState(true);
  const exportRef = useRef<HTMLDivElement | null>(null);

  const tExtent = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of cycles) {
      if (!c.time.length) continue;
      lo = Math.min(lo, c.time[0], c.time[c.time.length - 1]);
      hi = Math.max(hi, c.time[0], c.time[c.time.length - 1]);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1 };
    return { lo, hi };
  }, [cycles]);

  const [range, setRange] = useState<[number, number]>([
    tExtent.lo,
    tExtent.hi,
  ]);
  const tripSpan = Math.max(0, tExtent.hi - tExtent.lo);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    setSelected([initialSeries, "a_lon"].filter((id, i, a) => a.indexOf(id) === i) as InspectSeriesId[]);
    setGridRows(2);
    setGridCols(1);
    setRange([tExtent.lo, tExtent.hi]);
    setCursors([]);
    setPlaceMode(false);
    setTitle("Versus — exploration");
  }, [open, initialSeries, tExtent.lo, tExtent.hi]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const effectiveWindow = Math.min(
    Math.max(0.1, windowSec),
    Math.max(0.1, tripSpan || windowSec)
  );

  const toggleSeries = (id: InspectSeriesId) => {
    setSelected((prev) => {
      if (prev.includes(id)) {
        if (prev.length <= 1) return prev;
        return prev.filter((x) => x !== id);
      }
      return [...prev, id];
    });
  };

  const chartBundles = useMemo(() => {
    const [a, b] = range;
    return selected.map((id) => {
      let rows = buildOverlayRows(cycles, id, a, b);
      if (rollingOn) {
        for (const c of cycles) {
          rows = withRollingOnKey(rows, c.id, effectiveWindow, rollingMode);
        }
      }
      const means = cycles.map((c) => ({
        id: c.id,
        label: c.label,
        mean: meanOfKey(rows, c.id),
        rms: rmsOfKey(rows, c.id),
      }));
      return { id, rows, means };
    });
  }, [selected, cycles, range, rollingOn, effectiveWindow, rollingMode]);

  const addCursorAt = (t: number) => {
    setCursors((prev) => {
      const color = CURSOR_COLORS[prev.length % CURSOR_COLORS.length];
      return [
        ...prev,
        {
          id: `c-${Date.now()}-${prev.length}`,
          t,
          color,
          label: `C${prev.length + 1}`,
        },
      ];
    });
  };

  const safeFileBase = useCallback(() => {
    return (
      title.trim().replace(/[^\w\-àâäéèêëïîôùûüç]+/gi, "_").slice(0, 60) ||
      "versus_analyse"
    );
  }, [title]);

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
      const a = document.createElement("a");
      a.download = `${safeFileBase()}.jpg`;
      a.href = dataUrl;
      a.click();
    } catch (e) {
      console.error(e);
      window.alert("Export JPEG échoué.");
    } finally {
      setExporting(null);
    }
  }, [safeFileBase]);

  const exportExcel = useCallback(() => {
    setExporting("excel");
    try {
      const sep = ";";
      const esc = (v: string | number) => {
        const s = String(v);
        if (/[;"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
      };
      const num = (v: number) =>
        Number.isFinite(v) ? String(v).replace(".", ",") : "";
      const lines: string[] = [esc(`# ${title}`)];
      for (const m of runMetaList) {
        lines.push(...metaLinesForCsv(m).map(esc));
      }
      lines.push(esc(`# cycles=${cycles.map((c) => c.label).join(" | ")}`));
      lines.push(
        esc(
          `# style=solid(cycle1)/dash(cycle2+) · t0=${range[0].toFixed(2)} t1=${range[1].toFixed(2)}`
        )
      );

      for (const bundle of chartBundles) {
        const sMeta = meta(bundle.id);
        lines.push("");
        lines.push(esc(`# series=${sMeta.short}`));
        lines.push(
          ["T_s", ...cycles.map((c) => `${sMeta.short}_${c.label}`)]
            .map(esc)
            .join(sep)
        );
        for (const r of bundle.rows) {
          lines.push(
            [num(r.t), ...cycles.map((c) => num(r[c.id]))].map(esc).join(sep)
          );
        }
      }

      if (cursors.length) {
        lines.push("");
        lines.push(esc("# Curseurs"));
        const hdr = ["C", "T_s"];
        for (const bundle of chartBundles) {
          for (const c of cycles) {
            hdr.push(`${seriesShort(bundle.id)}_${c.label}`);
          }
        }
        lines.push(hdr.map(esc).join(sep));
        for (const cur of cursors) {
          const cells: string[] = [esc(cur.label), num(cur.t)];
          for (const bundle of chartBundles) {
            const nearest = bundle.rows.reduce(
              (best, r) =>
                Math.abs(r.t - cur.t) < Math.abs(best.t - cur.t) ? r : best,
              bundle.rows[0]
            );
            for (const c of cycles) {
              cells.push(num(nearest?.[c.id] ?? Number.NaN));
            }
          }
          lines.push(cells.join(sep));
        }
      }

      const blob = new Blob(["\uFEFF" + lines.join("\r\n")], {
        type: "text/csv;charset=utf-8;",
      });
      const url = URL.createObjectURL(blob);
      const aEl = document.createElement("a");
      aEl.href = url;
      aEl.download = `${safeFileBase()}.csv`;
      aEl.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
      window.alert("Export Excel échoué.");
    } finally {
      setExporting(null);
    }
  }, [
    title,
    runMetaList,
    cycles,
    range,
    chartBundles,
    cursors,
    safeFileBase,
  ]);

  const slots = Math.max(1, gridRows * gridCols);
  const displayed = chartBundles.slice(0, slots);

  if (!mounted || !open) return null;

  const body = (
    <div className="fixed inset-0 z-[1200] flex justify-end">
      <button
        type="button"
        aria-label="Fermer"
        className="absolute inset-0 bg-slate-900/35"
        onClick={onClose}
      />
      <aside
        className="relative flex h-full w-full sm:w-[88%]"
        style={{ animation: "cyclegen-drawer-in 280ms ease-out" }}
        role="dialog"
        aria-modal="true"
      >
        <style>{`
          @keyframes cyclegen-drawer-in {
            from { transform: translateX(100%); }
            to { transform: translateX(0); }
          }
        `}</style>
        <div className="flex h-full w-full flex-col border-l border-slate-200 bg-white shadow-2xl">
          <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-3 py-2">
            <label className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                Titre
              </span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="min-w-0 flex-1 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-sm font-semibold outline-none focus:border-brand focus:bg-white"
              />
            </label>
            <button
              type="button"
              disabled={exporting != null}
              onClick={() => void exportJpeg()}
              className="rounded-md border border-slate-200 px-2.5 py-1 text-[10px] font-semibold disabled:opacity-50"
            >
              {exporting === "jpeg" ? "…" : "JPEG"}
            </button>
            <button
              type="button"
              disabled={exporting != null}
              onClick={() => exportExcel()}
              className="rounded-md border border-slate-200 px-2.5 py-1 text-[10px] font-semibold disabled:opacity-50"
            >
              {exporting === "excel" ? "…" : "Excel CSV"}
            </button>
            <div className="flex items-center gap-1 text-[10px] text-slate-600">
              <span className="font-semibold uppercase text-slate-400">
                Layout
              </span>
              <input
                type="number"
                min={1}
                max={4}
                value={gridRows}
                onChange={(e) =>
                  setGridRows(Math.min(4, Math.max(1, Number(e.target.value) || 1)))
                }
                className="w-9 rounded border border-slate-200 px-1 py-0.5"
                title="Lignes"
              />
              <span>×</span>
              <input
                type="number"
                min={1}
                max={4}
                value={gridCols}
                onChange={(e) =>
                  setGridCols(Math.min(4, Math.max(1, Number(e.target.value) || 1)))
                }
                className="w-9 rounded border border-slate-200 px-1 py-0.5"
                title="Colonnes"
              />
              {(
                [
                  [1, 1],
                  [2, 1],
                  [1, 2],
                  [2, 2],
                  [3, 2],
                ] as const
              ).map(([r, c]) => (
                <button
                  key={`${r}x${c}`}
                  type="button"
                  onClick={() => {
                    setGridRows(r);
                    setGridCols(c);
                  }}
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                    gridRows === r && gridCols === c
                      ? "bg-slate-900 text-white"
                      : "border border-slate-200"
                  }`}
                >
                  {r}×{c}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold"
            >
              Fermer
            </button>
          </div>

          <div className="flex min-h-0 flex-1">
            <div className="flex w-52 shrink-0 flex-col gap-2 overflow-y-auto border-r border-slate-100 bg-slate-50/80 p-2">
              <div className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[9px] text-slate-600">
                <div className="mb-1 font-semibold uppercase text-slate-400">
                  Style Versus
                </div>
                {cycles.map((c, i) => (
                  <div key={c.id} className="flex items-center gap-1.5 py-0.5">
                    <svg width="28" height="8" className="shrink-0">
                      <line
                        x1="0"
                        y1="4"
                        x2="28"
                        y2="4"
                        stroke="#0f172a"
                        strokeWidth="2"
                        strokeDasharray={VERSUS_CYCLE_DASH[i % VERSUS_CYCLE_DASH.length]}
                      />
                    </svg>
                    <span className="truncate font-semibold">{c.label}</span>
                  </div>
                ))}
                <p className="mt-1 text-[8px] text-slate-400">
                  Couleur = variable · trait = cycle (plein / tirets)
                </p>
              </div>

              {runMetaList.length > 0 && (
                <div>
                  <button
                    type="button"
                    onClick={() => setMetaOpen((v) => !v)}
                    className="mb-1 flex w-full justify-between px-1 text-[9px] font-semibold uppercase text-slate-400"
                  >
                    Traçabilité & params
                    <span>{metaOpen ? "▾" : "▸"}</span>
                  </button>
                  {metaOpen &&
                    runMetaList.map((m, mi) => (
                      <dl
                        key={mi}
                        className="mb-2 max-h-36 space-y-0.5 overflow-y-auto rounded border border-slate-200 bg-white px-2 py-1 text-[9px]"
                      >
                        <div className="font-semibold text-slate-500">
                          {cycles[mi]?.label ?? `Cycle ${mi + 1}`}
                        </div>
                        {m.entries.map((e) => (
                          <div
                            key={`${mi}-${e.key}`}
                            className="flex justify-between gap-1"
                          >
                            <dt className="text-slate-400">{e.label}</dt>
                            <dd className="truncate font-semibold text-slate-800">
                              {e.value}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    ))}
                </div>
              )}

              <div>
                <p className="mb-1 px-1 text-[9px] font-semibold uppercase text-slate-400">
                  Variables
                </p>
                {VERSUS_SERIES.map((s) => {
                  const on = selected.includes(s.id);
                  return (
                    <label
                      key={s.id}
                      className={`flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[11px] ${
                        on
                          ? "bg-white font-semibold shadow-sm ring-1 ring-slate-200"
                          : "text-slate-600"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggleSeries(s.id)}
                        className="accent-brand"
                      />
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ background: s.color }}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {labels[s.id]}
                      </span>
                      {s.needsVehicle && (
                        <span
                          className="shrink-0 rounded bg-slate-100 px-1 text-[8px] font-bold uppercase tracking-wide text-slate-500"
                          title="Nécessite un véhicule (road load)"
                        >
                          véh.
                        </span>
                      )}
                    </label>
                  );
                })}
                {selected.some(
                  (id) => INSPECT_SERIES.find((s) => s.id === id)?.needsVehicle
                ) &&
                  cycles.some((c) => !vehicleForCycle(c)) && (
                    <p className="mt-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-1 text-[9px] text-amber-900">
                      Choisissez un véhicule sur chaque carte Versus pour
                      calculer puissance et couple.
                    </p>
                  )}
              </div>

              <div>
                <p className="mb-1 px-1 text-[9px] font-semibold uppercase text-slate-400">
                  Légende · ȳ
                </p>
                {chartBundles.map((b) => (
                  <div
                    key={b.id}
                    className="mb-1.5 rounded border border-slate-200 bg-white px-2 py-1 text-[9px]"
                  >
                    <input
                      value={labels[b.id]}
                      onChange={(e) =>
                        setLabels((p) => ({ ...p, [b.id]: e.target.value }))
                      }
                      className="mb-0.5 w-full border-0 bg-transparent text-[11px] font-semibold outline-none"
                    />
                    {b.means.map((m, i) => (
                      <div key={m.id} className="tabular-nums text-slate-600">
                        <span className="text-slate-400">
                          {i === 0 ? "━" : "╌"}
                        </span>{" "}
                        {m.label}: ȳ{" "}
                        <strong>
                          {m.mean != null ? m.mean.toFixed(2) : "—"}
                        </strong>{" "}
                        {meta(b.id).unit}
                        {m.rms != null && (
                          <span className="text-slate-400">
                            {" "}
                            · RMS {m.rms.toFixed(2)} {meta(b.id).unit}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>

            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-1.5">
                <button
                  type="button"
                  onClick={() => setPlaceMode((v) => !v)}
                  className={`rounded-md px-2 py-1 text-[10px] font-semibold ${
                    placeMode
                      ? "bg-red-600 text-white"
                      : "border border-slate-200"
                  }`}
                >
                  {placeMode
                    ? "Placement ON — clic → curseur"
                    : "＋ Curseurs verticaux"}
                </button>
                <button
                  type="button"
                  onClick={() => addCursorAt((range[0] + range[1]) / 2)}
                  className="rounded-md border border-slate-200 px-2 py-1 text-[10px] font-semibold"
                >
                  Au milieu
                </button>
                <button
                  type="button"
                  onClick={() => setCursors([])}
                  disabled={!cursors.length}
                  className="rounded-md border border-slate-200 px-2 py-1 text-[10px] font-semibold disabled:opacity-40"
                >
                  Effacer
                </button>
                <label className="ml-auto inline-flex items-center gap-1 text-[10px]">
                  <input
                    type="checkbox"
                    checked={rollingOn}
                    onChange={(e) => setRollingOn(e.target.checked)}
                  />
                  Fenêtre
                </label>
                <div className="flex rounded border border-slate-200 p-0.5">
                  {(
                    [
                      ["mean", "Moy"],
                      ["rms", "RMS"],
                    ] as const
                  ).map(([id, lab]) => (
                    <button
                      key={id}
                      type="button"
                      disabled={!rollingOn}
                      onClick={() => setRollingMode(id)}
                      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold disabled:opacity-40 ${
                        rollingMode === id ? "bg-slate-900 text-white" : ""
                      }`}
                    >
                      {lab}
                    </button>
                  ))}
                </div>
                <input
                  type="number"
                  min={1}
                  disabled={!rollingOn}
                  value={windowSec}
                  onChange={(e) => setWindowSec(Number(e.target.value) || 10)}
                  className="w-12 rounded border border-slate-200 px-1 text-[10px] disabled:opacity-40"
                />
                <div className="flex gap-0.5">
                  {WINDOW_PRESETS.filter((p) => p <= tripSpan + 1 || !tripSpan).map(
                    (p) => (
                      <button
                        key={p}
                        type="button"
                        disabled={!rollingOn}
                        onClick={() => setWindowSec(p)}
                        className="rounded border border-slate-200 px-1 text-[9px] disabled:opacity-40"
                      >
                        {p}s
                      </button>
                    )
                  )}
                </div>
              </div>

              <div
                ref={exportRef}
                className="flex min-h-0 flex-1 flex-col bg-white"
              >
                <div className="shrink-0 border-b border-slate-100 px-3 py-1.5 text-center text-sm font-semibold">
                  {title}
                </div>
                {runMetaList[0]?.entries.length ? (
                  <div className="shrink-0 border-b border-slate-100 px-3 py-1 text-[8px] text-slate-500">
                    {cycles
                      .map(
                        (c, i) =>
                          `${c.label}: ` +
                          (runMetaList[i]?.entries
                            .slice(0, 6)
                            .map((e) => `${e.label}=${e.value}`)
                            .join(", ") ?? "")
                      )
                      .join(" ‖ ")}
                  </div>
                ) : null}
                <div
                  className="min-h-0 flex-1 gap-2 p-2"
                  style={{
                    display: "grid",
                    gridTemplateRows: `repeat(${gridRows}, minmax(0, 1fr))`,
                    gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
                  }}
                >
                  {Array.from({ length: slots }).map((_, i) => {
                    const b = displayed[i];
                    if (!b) {
                      return (
                        <div
                          key={`e-${i}`}
                          className="rounded-md border border-dashed border-slate-200 bg-slate-50/50"
                        />
                      );
                    }
                    const sMeta = meta(b.id);
                    const meanBits = `${b.means
                      .map(
                        (m, idx) =>
                          `${idx === 0 ? "━" : "╌"}${m.mean != null ? m.mean.toFixed(1) : "—"}`
                      )
                      .join(" ")} ${sMeta.unit}`;
                    return (
                      <OverlayChart
                        key={b.id}
                        data={b.rows}
                        cycles={cycles}
                        seriesId={b.id}
                        label={labels[b.id]}
                        color={sMeta.color}
                        unit={sMeta.unit}
                        xDomain={range}
                        cursors={cursors}
                        placeMode={placeMode}
                        onPlace={addCursorAt}
                        showRolling={rollingOn}
                        meanBits={meanBits}
                      />
                    );
                  })}
                </div>
              </div>

              <div className="shrink-0 space-y-1 border-t border-slate-200 bg-slate-50 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2 text-[10px]">
                  <span className="font-semibold uppercase text-slate-500">
                    Fenêtre T
                  </span>
                  <input
                    type="number"
                    value={Number(range[0].toFixed(1))}
                    onChange={(e) =>
                      setRange([
                        Math.max(tExtent.lo, Number(e.target.value) || 0),
                        range[1],
                      ])
                    }
                    className="w-16 rounded border border-slate-200 px-1"
                  />
                  <input
                    type="number"
                    value={Number(range[1].toFixed(1))}
                    onChange={(e) =>
                      setRange([
                        range[0],
                        Math.min(tExtent.hi, Number(e.target.value) || 1),
                      ])
                    }
                    className="w-16 rounded border border-slate-200 px-1"
                  />
                  <button
                    type="button"
                    onClick={() => setRange([tExtent.lo, tExtent.hi])}
                    className="rounded border border-slate-200 px-1.5 font-semibold"
                  >
                    Tout
                  </button>
                </div>
                <div className="flex gap-2">
                  <input
                    type="range"
                    min={tExtent.lo}
                    max={tExtent.hi}
                    step={Math.max(0.1, tripSpan / 400)}
                    value={range[0]}
                    onChange={(e) =>
                      setRange([
                        Math.min(Number(e.target.value), range[1] - 0.1),
                        range[1],
                      ])
                    }
                    className="flex-1 accent-sky-600"
                  />
                  <input
                    type="range"
                    min={tExtent.lo}
                    max={tExtent.hi}
                    step={Math.max(0.1, tripSpan / 400)}
                    value={range[1]}
                    onChange={(e) =>
                      setRange([
                        range[0],
                        Math.max(Number(e.target.value), range[0] + 0.1),
                      ])
                    }
                    className="flex-1 accent-sky-600"
                  />
                </div>
              </div>

              {cursors.length > 0 && (
                <div className="max-h-28 shrink-0 overflow-auto border-t border-slate-200 text-[10px]">
                  <table className="w-full">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr>
                        <th className="px-2 py-1 text-left">C</th>
                        <th className="px-2 py-1 text-left">t (s)</th>
                        {selected.map((id) =>
                          cycles.map((c, ci) => (
                            <th
                              key={`${id}-${c.id}`}
                              className="px-2 py-1 text-left"
                            >
                              {seriesShort(id)}
                              {ci === 0 ? "" : "'"} ({meta(id).unit})
                            </th>
                          ))
                        )}
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {cursors.map((cur) => (
                        <tr key={cur.id} className="border-t border-slate-100">
                          <td className="px-2 py-1">{cur.label}</td>
                          <td className="px-2 py-1 tabular-nums">
                            {cur.t.toFixed(1)}
                          </td>
                          {chartBundles.map((b) => {
                            const nearest = b.rows.reduce(
                              (best, r) =>
                                Math.abs(r.t - cur.t) < Math.abs(best.t - cur.t)
                                  ? r
                                  : best,
                              b.rows[0]
                            );
                            return cycles.map((c) => (
                              <td
                                key={`${cur.id}-${b.id}-${c.id}`}
                                className="px-2 py-1 tabular-nums"
                              >
                                {nearest && Number.isFinite(nearest[c.id])
                                  ? nearest[c.id].toFixed(2)
                                  : "—"}
                              </td>
                            ));
                          })}
                          <td className="px-2 py-1 text-right">
                            <button
                              type="button"
                              onClick={() =>
                                setCursors((p) =>
                                  p.filter((x) => x.id !== cur.id)
                                )
                              }
                            >
                              ×
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      </aside>
    </div>
  );

  return createPortal(body, document.body);
}
