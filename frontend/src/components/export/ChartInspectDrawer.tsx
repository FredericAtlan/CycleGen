"use client";

/**
 * @deprecated Opened from ResultsAnalysisPanel historically.
 * Analysis is now embedded in ResultsAnalyseStudio (step 4).
 * Kept for potential Versus / external callers; prefer ResultsAnalyseStudio.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toJpeg } from "html-to-image";
import {
  Brush,
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
  nearestRow,
  seriesShort,
  sliceStats,
  withRollingOverlay,
  isZeroInflatedSeries,
  type InspectRow,
  type InspectSeriesId,
  type RollingMode,
} from "@/lib/chartInspectData";
import {
  metaLinesForCsv,
  type InspectRunMeta,
} from "@/lib/inspectRunMeta";
import { formatTimeLabel } from "@/lib/chartTime";

export type ChartInspectDrawerProps = {
  open: boolean;
  onClose: () => void;
  rows: InspectRow[];
  initialSeries: InspectSeriesId;
  initialSecondary?: InspectSeriesId;
  /** Traceability + structural simulation params. */
  runMeta?: InspectRunMeta | null;
};

type VertCursor = {
  id: string;
  t: number;
  color: string;
  label: string;
};

type ChartPoint = InspectRow & { rolling?: number };

const CURSOR_COLORS = [
  "#ef4444",
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#64748b",
];

const WINDOW_PRESETS = [1, 5, 10, 30, 60, 100, 300] as const;

function meta(id: InspectSeriesId) {
  return INSPECT_SERIES.find((s) => s.id === id)!;
}

function BigChart({
  data,
  seriesId,
  label,
  color,
  unit,
  xDomain,
  cursors,
  placeMode,
  onPlace,
  showBrush,
  brushRange,
  onBrushChange,
  showRolling,
  rollingLabel,
  meanLabel,
}: {
  data: ChartPoint[];
  seriesId: InspectSeriesId;
  label: string;
  color: string;
  unit: string;
  xDomain: [number, number];
  cursors: VertCursor[];
  placeMode: boolean;
  onPlace: (t: number) => void;
  showBrush?: boolean;
  brushRange?: [number, number];
  onBrushChange?: (r: [number, number]) => void;
  showRolling?: boolean;
  rollingLabel?: string;
  meanLabel?: string;
}) {
  const short = seriesShort(seriesId);
  const rollShort =
    rollingLabel?.startsWith("RMS")
      ? `RMS`
      : rollingLabel?.startsWith("Moy")
        ? `Moy`
        : "F";

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
          <span className="shrink-0 text-[9px] text-slate-400">{unit}</span>
        </div>
        {meanLabel && (
          <span className="shrink-0 text-[10px] tabular-nums text-slate-600">
            {meanLabel}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{ top: 8, right: 12, left: 4, bottom: showBrush ? 4 : 2 }}
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
              width={48}
              tick={{ fontSize: 10, fill: "#64748b" }}
              tickFormatter={(v) => Number(v).toFixed(1)}
            />
            <Tooltip
              contentStyle={{ fontSize: 11, padding: "4px 8px" }}
              labelFormatter={(x) => `t = ${Number(x).toFixed(1)} s`}
              formatter={(v, name) => {
                const n = String(name);
                const tag =
                  n === short || n === label
                    ? short
                    : n.includes("RMS") || n.includes("Moy") || n === rollingLabel
                      ? rollShort
                      : n.slice(0, 3);
                return [
                  typeof v === "number"
                    ? `${v.toFixed(2)} ${unit}`
                    : String(v ?? ""),
                  tag,
                ];
              }}
            />
            {brushRange && brushRange[1] > brushRange[0] && (
              <ReferenceArea
                x1={brushRange[0]}
                x2={brushRange[1]}
                fill="#0ea5e9"
                fillOpacity={0.06}
                strokeOpacity={0}
              />
            )}
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
            <Line
              type="monotone"
              dataKey={seriesId}
              name={short}
              stroke={color}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            {showRolling && (
              <Line
                type="monotone"
                dataKey="rolling"
                name={rollShort}
                stroke="#0f172a"
                strokeWidth={1.5}
                strokeDasharray="6 3"
                dot={false}
                isAnimationActive={false}
              />
            )}
            {showBrush && onBrushChange && (
              <Brush
                dataKey="t"
                height={24}
                stroke="#94a3b8"
                travellerWidth={8}
                tickFormatter={(v) => formatTimeLabel(Number(v))}
                onChange={(br) => {
                  if (
                    br &&
                    typeof br.startIndex === "number" &&
                    typeof br.endIndex === "number" &&
                    data[br.startIndex] &&
                    data[br.endIndex]
                  ) {
                    onBrushChange([
                      data[br.startIndex].t,
                      data[br.endIndex].t,
                    ]);
                  }
                }}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default function ChartInspectDrawer({
  open,
  onClose,
  rows,
  initialSeries,
  initialSecondary = "a_lon",
  runMeta = null,
}: ChartInspectDrawerProps) {
  const [mounted, setMounted] = useState(false);
  const [selected, setSelected] = useState<InspectSeriesId[]>([
    initialSeries,
  ]);
  const [gridRows, setGridRows] = useState(2);
  const [gridCols, setGridCols] = useState(2);
  const [title, setTitle] = useState("Analyse graphique");
  const [labels, setLabels] = useState<Record<InspectSeriesId, string>>(() =>
    Object.fromEntries(
      INSPECT_SERIES.map((s) => [s.id, s.defaultLabel])
    ) as Record<InspectSeriesId, string>
  );
  const [cursors, setCursors] = useState<VertCursor[]>([]);
  const [placeMode, setPlaceMode] = useState(false);
  const [rollingOn, setRollingOn] = useState(true);
  const [rollingMode, setRollingMode] = useState<RollingMode>("rms");
  const [windowSec, setWindowSec] = useState(10);
  const [exporting, setExporting] = useState<"jpeg" | "excel" | null>(null);
  const [metaOpen, setMetaOpen] = useState(true);
  const exportRef = useRef<HTMLDivElement | null>(null);
  const [tMin, tMax] = useMemo((): [number, number] => {
    if (!rows.length) return [0, 1];
    return [rows[0].t, rows[rows.length - 1].t];
  }, [rows]);
  const tripSpan = Math.max(0, tMax - tMin);
  const [range, setRange] = useState<[number, number]>([tMin, tMax]);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const init: InspectSeriesId[] = [initialSeries];
    if (initialSecondary && initialSecondary !== initialSeries) {
      init.push(initialSecondary);
    }
    setSelected(init);
    const n = init.length;
    if (n <= 1) {
      setGridRows(1);
      setGridCols(1);
    } else if (n === 2) {
      setGridRows(2);
      setGridCols(1);
    } else if (n <= 4) {
      setGridRows(2);
      setGridCols(2);
    } else {
      setGridRows(3);
      setGridCols(3);
    }
    setRange([tMin, tMax]);
    setCursors([]);
    setPlaceMode(false);
    setTitle("Analyse multi-graphiques");
  }, [open, initialSeries, initialSecondary, tMin, tMax]);

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
  const windowIsFull = tripSpan > 0 && effectiveWindow >= tripSpan - 1e-6;

  const rollingLabel = `${rollingMode === "rms" ? "RMS" : "Moy."} ${
    windowIsFull ? "trajet" : `${effectiveWindow.toFixed(0)} s`
  }`;

  const toggleSeries = (id: InspectSeriesId) => {
    setSelected((prev) => {
      if (prev.includes(id)) {
        if (prev.length <= 1) return prev;
        return prev.filter((x) => x !== id);
      }
      return [...prev, id];
    });
  };

  /** Means over the visible time window (legend). */
  const legendMeans = useMemo(() => {
    const [a, b] = range;
    const slice = rows.filter((r) => r.t >= a - 1e-6 && r.t <= b + 1e-6);
    const src = slice.length ? slice : rows;
    return selected.map((id) => {
      const st = sliceStats(
        src,
        src[0]?.t ?? 0,
        src[src.length - 1]?.t ?? 0,
        id
      );
      return {
        id,
        mean: st?.mean ?? null,
        rms: st?.rms ?? null,
        meanActive: st?.meanActive ?? null,
        duty: st?.duty ?? null,
        energyKwh: st?.energyKwh ?? null,
        unit: meta(id).unit,
        color: meta(id).color,
        label: labels[id],
        zeroInflated: isZeroInflatedSeries(id),
      };
    });
  }, [rows, range, selected, labels]);

  const chartDataBySeries = useMemo(() => {
    const map = new Map<InspectSeriesId, ChartPoint[]>();
    for (const id of selected) {
      const overlay = rollingOn
        ? withRollingOverlay(rows, id, effectiveWindow, rollingMode)
        : rows.map((r) => ({ ...r, rolling: r[id] }));
      const [a, b] = range;
      map.set(
        id,
        overlay.filter((r) => r.t >= a - 1e-6 && r.t <= b + 1e-6)
      );
    }
    return map;
  }, [selected, rows, rollingOn, effectiveWindow, rollingMode, range]);

  const addCursorAt = (t: number) => {
    const snapped = nearestRow(rows, t);
    if (!snapped) return;
    setCursors((prev) => {
      const color = CURSOR_COLORS[prev.length % CURSOR_COLORS.length];
      return [
        ...prev,
        {
          id: `c-${Date.now()}-${prev.length}`,
          t: snapped.t,
          color,
          label: `C${prev.length + 1}`,
        },
      ];
    });
    // Keep placeMode on — successive clicks add more cursors until toggled off.
  };

  const safeFileBase = useCallback(() => {
    return (
      title.trim().replace(/[^\w\-àâäéèêëïîôùûüç]+/gi, "_").slice(0, 60) ||
      "cyclegen_analyse"
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

  /** Excel-friendly CSV of the visible time window + selected series. */
  const exportExcel = useCallback(() => {
    setExporting("excel");
    try {
      const [a, b] = range;
      const slice = rows.filter((r) => r.t >= a - 1e-6 && r.t <= b + 1e-6);
      const series = selected.length ? selected : (["v_kmh"] as InspectSeriesId[]);
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
        ...series.map((id) => `${seriesShort(id)}_${meta(id).unit}`),
        ...(rollingOn
          ? series.map(
              (id) =>
                `${seriesShort(id)}_${rollingMode === "rms" ? "RMS" : "Moy"}_${effectiveWindow.toFixed(0)}s`
            )
          : []),
      ];

      const lines: string[] = [
        esc(`# ${title}`),
        ...metaLinesForCsv(runMeta).map(esc),
        esc(`# t0=${a.toFixed(3)}s t1=${b.toFixed(3)}s`),
        header.map(esc).join(sep),
      ];

      const overlays = rollingOn
        ? series.map((id) =>
            withRollingOverlay(rows, id, effectiveWindow, rollingMode)
          )
        : null;

      for (let i = 0; i < slice.length; i++) {
        const r = slice[i];
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

      if (cursors.length) {
        lines.push("");
        lines.push(esc("# Curseurs"));
        lines.push(
          ["C", "T_s", ...series.map((id) => seriesShort(id))]
            .map(esc)
            .join(sep)
        );
        for (const c of cursors) {
          const row = nearestRow(rows, c.t);
          lines.push(
            [
              esc(c.label),
              num(c.t),
              ...series.map((id) => num(row ? row[id] : Number.NaN)),
            ].join(sep)
          );
        }
      }

      // UTF-8 BOM so Excel opens accents correctly
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
    range,
    rows,
    selected,
    rollingOn,
    rollingMode,
    effectiveWindow,
    title,
    cursors,
    safeFileBase,
    runMeta,
  ]);

  const focusId = selected[0] ?? initialSeries;
  const betweenStats =
    cursors.length >= 2
      ? sliceStats(rows, cursors[0].t, cursors[1].t, focusId)
      : null;

  const slots = Math.max(1, gridRows * gridCols);
  const displayed = selected.slice(0, slots);

  if (!mounted || !open) return null;

  const body = (
    <div className="fixed inset-0 z-[1200] flex justify-end">
      <button
        type="button"
        aria-label="Fermer l’inspection"
        className="absolute inset-0 bg-slate-900/35"
        onClick={onClose}
      />
      <aside
        className="relative flex h-full w-full sm:w-[88%]"
        style={{ animation: "cyclegen-drawer-in 280ms ease-out" }}
        role="dialog"
        aria-modal="true"
        aria-label="Inspection graphique"
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
                className="min-w-0 flex-1 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-sm font-semibold text-slate-900 outline-none focus:border-brand focus:bg-white"
                placeholder="Titre du graphique"
              />
            </label>
            <button
              type="button"
              onClick={() => void exportJpeg()}
              disabled={exporting != null}
              className="shrink-0 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[10px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              title="Exporter la zone graphes en JPEG"
            >
              {exporting === "jpeg" ? "Export…" : "JPEG"}
            </button>
            <button
              type="button"
              onClick={() => exportExcel()}
              disabled={exporting != null}
              className="shrink-0 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[10px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              title="Exporter les données visibles (fenêtre + séries) en CSV Excel"
            >
              {exporting === "excel" ? "Export…" : "Excel CSV"}
            </button>
            <div className="flex items-center gap-1.5 text-[10px] text-slate-600">
              <span className="font-semibold uppercase tracking-wide text-slate-400">
                Layout
              </span>
              <label className="inline-flex items-center gap-0.5">
                L
                <input
                  type="number"
                  min={1}
                  max={4}
                  value={gridRows}
                  onChange={(e) =>
                    setGridRows(
                      Math.min(4, Math.max(1, Number(e.target.value) || 1))
                    )
                  }
                  className="w-10 rounded border border-slate-200 px-1 py-0.5 tabular-nums"
                />
              </label>
              <span>×</span>
              <label className="inline-flex items-center gap-0.5">
                C
                <input
                  type="number"
                  min={1}
                  max={4}
                  value={gridCols}
                  onChange={(e) =>
                    setGridCols(
                      Math.min(4, Math.max(1, Number(e.target.value) || 1))
                    )
                  }
                  className="w-10 rounded border border-slate-200 px-1 py-0.5 tabular-nums"
                />
              </label>
              <div className="ml-1 flex gap-0.5">
                {(
                  [
                    [1, 1],
                    [1, 2],
                    [2, 1],
                    [2, 2],
                    [2, 3],
                    [3, 2],
                    [3, 3],
                  ] as const
                ).map(([r, c]) => (
                  <button
                    key={`${r}x${c}`}
                    type="button"
                    title={`${r}×${c}`}
                    onClick={() => {
                      setGridRows(r);
                      setGridCols(c);
                    }}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      gridRows === r && gridCols === c
                        ? "bg-slate-900 text-white"
                        : "border border-slate-200 text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {r}×{c}
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
            >
              Fermer
            </button>
          </div>

          <div className="flex min-h-0 flex-1">
            {/* Series checkboxes + legend means */}
            <div className="flex w-52 shrink-0 flex-col gap-3 overflow-y-auto border-r border-slate-100 bg-slate-50/80 p-2">
              {runMeta && runMeta.entries.length > 0 && (
                <div>
                  <button
                    type="button"
                    onClick={() => setMetaOpen((v) => !v)}
                    className="mb-1 flex w-full items-center justify-between px-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400 hover:text-slate-700"
                  >
                    <span>Traçabilité & params</span>
                    <span>{metaOpen ? "▾" : "▸"}</span>
                  </button>
                  {metaOpen && (
                    <dl className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[9px] leading-snug text-slate-600">
                      {(
                        [
                          ["trace", "Traçabilité"],
                          ["route", "Trajet"],
                          ["sim", "Simulation"],
                          ["slope", "Pente"],
                          ["vehicle", "Véhicule"],
                        ] as const
                      ).map(([g, gLabel]) => {
                        const items = runMeta.entries.filter(
                          (e) => e.group === g
                        );
                        if (!items.length) return null;
                        return (
                          <div key={g} className="border-b border-slate-50 pb-1 last:border-0">
                            <div className="mb-0.5 font-semibold uppercase tracking-wide text-slate-400">
                              {gLabel}
                            </div>
                            {items.map((e) => (
                              <div
                                key={e.key}
                                className="flex justify-between gap-2"
                                title={`${e.label}: ${e.value}`}
                              >
                                <dt className="shrink-0 text-slate-400">
                                  {e.label}
                                </dt>
                                <dd className="truncate text-right font-semibold text-slate-800">
                                  {e.value}
                                </dd>
                              </div>
                            ))}
                          </div>
                        );
                      })}
                    </dl>
                  )}
                </div>
              )}
              <div>
                <p className="mb-1 px-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                  Variables (cases)
                </p>
                <div className="space-y-0.5">
                  {INSPECT_SERIES.map((s) => {
                    const on = selected.includes(s.id);
                    return (
                      <label
                        key={s.id}
                        className={`flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[11px] ${
                          on
                            ? "bg-white font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                            : "text-slate-600 hover:bg-white/70"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggleSeries(s.id)}
                          className="accent-brand"
                        />
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ background: s.color }}
                        />
                        <span className="truncate">{labels[s.id]}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div>
                <p className="mb-1 px-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                  Légende · statistiques
                </p>
                <p className="mb-1.5 px-1 text-[9px] leading-snug text-slate-400">
                  ȳ = moyenne sur tous les échantillons (y compris 0). Pour
                  regen/traction, ȳ actif ignore les zéros.
                  {rollingOn
                    ? ` · pointillés = ${rollingMode.toUpperCase()} ${windowIsFull ? "trajet (constante)" : `${effectiveWindow.toFixed(0)} s`}`
                    : ""}
                </p>
                <ul className="space-y-1.5">
                  {legendMeans.map((m) => (
                    <li
                      key={m.id}
                      className="rounded-md border border-slate-200 bg-white px-2 py-1.5"
                    >
                      <div className="flex items-center gap-1.5">
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ background: m.color }}
                        />
                        <input
                          value={labels[m.id]}
                          onChange={(e) =>
                            setLabels((prev) => ({
                              ...prev,
                              [m.id]: e.target.value,
                            }))
                          }
                          className="min-w-0 flex-1 truncate border-0 bg-transparent text-[11px] font-semibold text-slate-800 outline-none focus:ring-0"
                        />
                      </div>
                      <div className="mt-0.5 space-y-0.5 text-[10px] tabular-nums text-slate-600">
                        <div>
                          ȳ{" "}
                          <strong>
                            {m.mean != null ? m.mean.toFixed(3) : "—"}
                          </strong>{" "}
                          {m.unit}
                          <span className="text-slate-400">
                            {" "}
                            · RMS{" "}
                            {m.rms != null ? m.rms.toFixed(3) : "—"} {m.unit}
                          </span>
                        </div>
                        {m.zeroInflated && m.meanActive != null && (
                          <div className="text-emerald-800">
                            ȳ actif{" "}
                            <strong>{m.meanActive.toFixed(2)}</strong> {m.unit}
                            {m.duty != null ? (
                              <span className="text-slate-500">
                                {" "}
                                · {(m.duty * 100).toFixed(0)} % du temps
                              </span>
                            ) : null}
                          </div>
                        )}
                        {m.energyKwh != null &&
                          Number.isFinite(m.energyKwh) && (
                            <div className="text-slate-500">
                              Énergie ≈{" "}
                              <strong>
                                {Math.abs(m.energyKwh) >= 0.01
                                  ? m.energyKwh.toFixed(3)
                                  : m.energyKwh.toExponential(2)}
                              </strong>{" "}
                              kWh
                            </div>
                          )}
                      </div>
                    </li>
                  ))}
                </ul>
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
                      : "border border-slate-200 text-slate-700 hover:bg-slate-50"
                  }`}
                  title={
                    placeMode
                      ? "Mode placement actif — cliquer plusieurs fois pour ajouter des curseurs ; recliquer pour quitter"
                      : "Activer le placement multi-curseurs"
                  }
                >
                  {placeMode
                    ? "Placement ON — clic → curseur"
                    : "＋ Curseurs verticaux"}
                </button>
                <button
                  type="button"
                  onClick={() => addCursorAt((range[0] + range[1]) / 2)}
                  className="rounded-md border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Au milieu
                </button>
                <button
                  type="button"
                  onClick={() => setCursors([])}
                  disabled={!cursors.length}
                  className="rounded-md border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-500 hover:bg-slate-50 disabled:opacity-40"
                >
                  Effacer curseurs
                </button>
                <span className="text-[10px] text-slate-400">
                  {displayed.length}/{slots} cases · {cursors.length} curseur
                  {cursors.length !== 1 ? "s" : ""}
                </span>
                {betweenStats && (
                  <span className="ml-auto text-[10px] tabular-nums text-slate-600">
                    C1↔C2 ({labels[focusId]}) · Δt {betweenStats.dt.toFixed(1)}s
                    · ȳ {betweenStats.mean.toFixed(2)} {meta(focusId).unit} ·
                    RMS {betweenStats.rms.toFixed(2)} {meta(focusId).unit}
                    {isZeroInflatedSeries(focusId) &&
                    betweenStats.meanActive != null
                      ? ` · ȳ actif ${betweenStats.meanActive.toFixed(2)} ${meta(focusId).unit} (${(betweenStats.duty * 100).toFixed(0)} %)`
                      : ""}
                  </span>
                )}
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50/70 px-3 py-1.5">
                <label className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-slate-700">
                  <input
                    type="checkbox"
                    checked={rollingOn}
                    onChange={(e) => setRollingOn(e.target.checked)}
                    className="accent-brand"
                  />
                  Fenêtre glissante
                </label>
                <div
                  role="radiogroup"
                  aria-label="Mode moyenne"
                  className="flex rounded-md border border-slate-200 bg-white p-0.5"
                >
                  {(
                    [
                      ["mean", "Moyenne"],
                      ["rms", "RMS"],
                    ] as const
                  ).map(([id, lab]) => (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={rollingMode === id}
                      disabled={!rollingOn}
                      onClick={() => setRollingMode(id)}
                      className={`rounded px-2 py-0.5 text-[10px] font-semibold disabled:opacity-40 ${
                        rollingMode === id
                          ? "bg-slate-900 text-white"
                          : "text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      {lab}
                    </button>
                  ))}
                </div>
                <label className="inline-flex items-center gap-1 text-[10px] text-slate-600">
                  τ
                  <input
                    type="number"
                    min={0.5}
                    max={Math.max(1, Math.ceil(tripSpan) || 1)}
                    step={1}
                    disabled={!rollingOn}
                    value={Number(windowSec.toFixed(1))}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v) && v > 0) setWindowSec(v);
                    }}
                    className="w-14 rounded border border-slate-200 bg-white px-1 py-0.5 tabular-nums disabled:opacity-40"
                  />
                  s
                </label>
                <div className="flex flex-wrap gap-0.5">
                  {WINDOW_PRESETS.filter(
                    (p) => p <= tripSpan + 1 || tripSpan <= 0
                  ).map((p) => (
                    <button
                      key={p}
                      type="button"
                      disabled={!rollingOn}
                      onClick={() => setWindowSec(p)}
                      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold disabled:opacity-40 ${
                        Math.abs(windowSec - p) < 0.05
                          ? "bg-sky-600 text-white"
                          : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      {p}s
                    </button>
                  ))}
                  <button
                    type="button"
                    disabled={!rollingOn || tripSpan <= 0}
                    onClick={() => setWindowSec(Math.max(1, tripSpan))}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold disabled:opacity-40 ${
                      windowIsFull
                        ? "bg-sky-600 text-white"
                        : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    Trajet
                  </button>
                </div>
                <input
                  type="range"
                  min={1}
                  max={Math.max(1, Math.ceil(tripSpan) || 1)}
                  step={1}
                  disabled={!rollingOn || tripSpan <= 0}
                  value={Math.min(
                    Math.max(1, Math.round(windowSec)),
                    Math.max(1, Math.ceil(tripSpan) || 1)
                  )}
                  onChange={(e) => setWindowSec(Number(e.target.value))}
                  className="min-w-[8rem] flex-1 accent-sky-600 disabled:opacity-40"
                />
              </div>

              <div
                ref={exportRef}
                className="flex min-h-0 flex-1 flex-col bg-white"
              >
                <div className="shrink-0 border-b border-slate-100 px-3 py-1.5 text-center text-sm font-semibold text-slate-900">
                  {title}
                </div>
                {runMeta && runMeta.entries.length > 0 && (
                  <div className="shrink-0 border-b border-slate-100 px-3 py-1 text-[8px] leading-snug text-slate-500">
                    {runMeta.entries
                      .map((e) => `${e.label}: ${e.value}`)
                      .join(" · ")}
                  </div>
                )}
              <div
                className="min-h-0 flex-1 gap-2 p-2"
                style={{
                  display: "grid",
                  gridTemplateRows: `repeat(${gridRows}, minmax(0, 1fr))`,
                  gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
                }}
              >
                {Array.from({ length: slots }).map((_, i) => {
                  const id = displayed[i];
                  if (!id) {
                    return (
                      <div
                        key={`empty-${i}`}
                        className="rounded-md border border-dashed border-slate-200 bg-slate-50/50"
                      />
                    );
                  }
                  const m = legendMeans.find((x) => x.id === id);
                  const data = chartDataBySeries.get(id) ?? [];
                  const sMeta = meta(id);
                  return (
                    <BigChart
                      key={id}
                      data={data.length ? data : rows}
                      seriesId={id}
                      label={labels[id]}
                      color={sMeta.color}
                      unit={sMeta.unit}
                      xDomain={range}
                      cursors={cursors}
                      placeMode={placeMode}
                      onPlace={addCursorAt}
                      showRolling={rollingOn}
                      rollingLabel={rollingLabel}
                      meanLabel={
                        m?.mean != null
                          ? m.zeroInflated && m.meanActive != null
                            ? `ȳ ${m.mean.toFixed(2)} ${sMeta.unit} · actif ${m.meanActive.toFixed(1)} ${sMeta.unit}`
                            : `ȳ ${m.mean.toFixed(2)} ${sMeta.unit}`
                          : undefined
                      }
                    />
                  );
                })}
              </div>
              </div>

              <div className="shrink-0 space-y-1 border-t border-slate-200 bg-slate-50 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-600">
                  <span className="font-semibold uppercase tracking-wide text-slate-500">
                    Fenêtre temporelle
                  </span>
                  <label className="inline-flex items-center gap-1">
                    t₀
                    <input
                      type="number"
                      step={1}
                      value={Number(range[0].toFixed(1))}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (!Number.isFinite(v)) return;
                        setRange([
                          Math.max(tMin, Math.min(v, range[1])),
                          range[1],
                        ]);
                      }}
                      className="w-16 rounded border border-slate-200 bg-white px-1 py-0.5 tabular-nums"
                    />
                  </label>
                  <label className="inline-flex items-center gap-1">
                    t₁
                    <input
                      type="number"
                      step={1}
                      value={Number(range[1].toFixed(1))}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (!Number.isFinite(v)) return;
                        setRange([
                          range[0],
                          Math.min(tMax, Math.max(v, range[0])),
                        ]);
                      }}
                      className="w-16 rounded border border-slate-200 bg-white px-1 py-0.5 tabular-nums"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => setRange([tMin, tMax])}
                    className="rounded border border-slate-200 bg-white px-1.5 py-0.5 font-semibold"
                  >
                    Tout
                  </button>
                  <span className="ml-auto tabular-nums text-slate-400">
                    {formatTimeLabel(range[0])} → {formatTimeLabel(range[1])} (
                    {(range[1] - range[0]).toFixed(0)} s)
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={tMin}
                    max={tMax}
                    step={Math.max(0.1, (tMax - tMin) / 500)}
                    value={range[0]}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setRange([Math.min(v, range[1] - 0.1), range[1]]);
                    }}
                    className="min-w-0 flex-1 accent-sky-600"
                  />
                  <input
                    type="range"
                    min={tMin}
                    max={tMax}
                    step={Math.max(0.1, (tMax - tMin) / 500)}
                    value={range[1]}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setRange([range[0], Math.max(v, range[0] + 0.1)]);
                    }}
                    className="min-w-0 flex-1 accent-sky-600"
                  />
                </div>
              </div>

              {cursors.length > 0 && (
                <div className="max-h-32 shrink-0 overflow-auto border-t border-slate-200">
                  <table className="w-full text-left text-[10px]">
                    <thead className="sticky top-0 bg-slate-50 text-slate-500">
                      <tr>
                        <th className="px-2 py-1 font-semibold">C</th>
                        <th className="px-2 py-1 font-semibold">t (s)</th>
                        {selected.map((id) => (
                          <th key={id} className="px-2 py-1 font-semibold">
                            {seriesShort(id)} ({meta(id).unit})
                          </th>
                        ))}
                        <th className="px-2 py-1" />
                      </tr>
                    </thead>
                    <tbody>
                      {cursors.map((c) => {
                        const row = nearestRow(rows, c.t);
                        return (
                          <tr key={c.id} className="border-t border-slate-100">
                            <td className="px-2 py-1">
                              <span
                                className="mr-1 inline-block h-2 w-2 rounded-full"
                                style={{ background: c.color }}
                              />
                              {c.label}
                            </td>
                            <td className="px-2 py-1 tabular-nums">
                              <input
                                type="number"
                                step={0.5}
                                value={Number(c.t.toFixed(2))}
                                onChange={(e) => {
                                  const snapped = nearestRow(
                                    rows,
                                    Number(e.target.value)
                                  );
                                  if (!snapped) return;
                                  setCursors((prev) =>
                                    prev.map((x) =>
                                      x.id === c.id
                                        ? { ...x, t: snapped.t }
                                        : x
                                    )
                                  );
                                }}
                                className="w-16 rounded border border-slate-200 px-1 py-0.5"
                              />
                            </td>
                            {selected.map((id) => (
                              <td
                                key={id}
                                className="px-2 py-1 tabular-nums font-medium"
                              >
                                {row ? row[id].toFixed(3) : "—"}
                              </td>
                            ))}
                            <td className="px-2 py-1 text-right">
                              <button
                                type="button"
                                onClick={() =>
                                  setCursors((prev) =>
                                    prev.filter((x) => x.id !== c.id)
                                  )
                                }
                                className="text-slate-400 hover:text-red-600"
                              >
                                ×
                              </button>
                            </td>
                          </tr>
                        );
                      })}
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
