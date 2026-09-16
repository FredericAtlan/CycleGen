"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { SavedCycle } from "@/lib/cycleLibrary";
import { slopeFromRad } from "@/lib/units";

export type ProfileDataDrawerProps = {
  open: boolean;
  onClose: () => void;
  cycle: SavedCycle | null;
  title?: string;
  hasGeo?: boolean;
};

const PREVIEW_ROWS = 80;

function safeFileStem(name: string): string {
  return (
    name
      .trim()
      .replace(/[^\w\-]+/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 60) || "cycle"
  );
}

export default function ProfileDataDrawer({
  open,
  onClose,
  cycle,
  title,
  hasGeo = false,
}: ProfileDataDrawerProps) {
  const [mounted, setMounted] = useState(false);
  const [exporting, setExporting] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const rows = useMemo(() => {
    if (!cycle || cycle.time.length < 1) return [];
    const n = cycle.time.length;
    const geoN = cycle.geometry?.length ?? 0;
    const geoAligned = geoN === n;
    const step = Math.max(1, Math.ceil(n / PREVIEW_ROWS));
    const out: {
      i: number;
      t: number;
      v: number;
      a: number;
      slope: number;
      s: number;
      lat: number | null;
      lon: number | null;
    }[] = [];
    const pushAt = (i: number) => {
      out.push({
        i,
        t: cycle.time[i] ?? 0,
        v: (cycle.velocity[i] ?? 0) * 3.6,
        a: cycle.acceleration[i] ?? 0,
        slope: slopeFromRad(cycle.slope[i] ?? 0, "percent"),
        s: cycle.position[i] ?? 0,
        lat: geoAligned ? cycle.geometry[i]?.lat ?? null : null,
        lon: geoAligned ? cycle.geometry[i]?.lon ?? null : null,
      });
    };
    for (let i = 0; i < n; i += step) pushAt(i);
    if (out.length && out[out.length - 1].i !== n - 1) pushAt(n - 1);
    return out;
  }, [cycle]);

  const geoPreview = useMemo(() => {
    if (!cycle?.geometry?.length) return [];
    const g = cycle.geometry;
    const step = Math.max(1, Math.ceil(g.length / 12));
    const pts = [];
    for (let i = 0; i < g.length; i += step) pts.push(g[i]);
    if (pts[pts.length - 1] !== g[g.length - 1]) pts.push(g[g.length - 1]);
    return pts;
  }, [cycle]);

  const exportExcel = useCallback(() => {
    if (!cycle || cycle.time.length < 1) return;
    setExporting(true);
    try {
      const n = cycle.time.length;
      const geoAligned = !!cycle.geometry && cycle.geometry.length === n;
      const headers = [
        "index",
        "time_s",
        "velocity_kmh",
        "acceleration_mps2",
        "slope_pct",
        "position_m",
        ...(geoAligned ? ["lat", "lon"] : []),
      ];
      const lines = [headers.join(";")];
      for (let i = 0; i < n; i++) {
        const cells = [
          String(i),
          String(cycle.time[i] ?? 0),
          ((cycle.velocity[i] ?? 0) * 3.6).toFixed(4),
          (cycle.acceleration[i] ?? 0).toFixed(6),
          slopeFromRad(cycle.slope[i] ?? 0, "percent").toFixed(4),
          (cycle.position[i] ?? 0).toFixed(3),
        ];
        if (geoAligned) {
          cells.push(
            cycle.geometry[i]?.lat != null
              ? cycle.geometry[i].lat.toFixed(6)
              : "",
            cycle.geometry[i]?.lon != null
              ? cycle.geometry[i].lon.toFixed(6)
              : ""
          );
        }
        lines.push(cells.join(";"));
      }
      const meta = [
        `# name;${cycle.name}`,
        `# source;${cycle.source}`,
        `# corpus_id;${cycle.corpusId ?? ""}`,
        `# duration_s;${cycle.stats.duration_s}`,
        `# distance_m;${cycle.stats.distance_m}`,
        `# v_mean_kmh;${cycle.stats.v_mean_kmh}`,
        `# has_gps;${geoAligned || (cycle.geometry?.length ?? 0) >= 2}`,
      ];
      const blob = new Blob(["\uFEFF" + [...meta, ...lines].join("\n")], {
        type: "text/csv;charset=utf-8;",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeFileStem(cycle.name)}_export.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      window.alert("Export Excel échoué.");
    } finally {
      setExporting(false);
    }
  }, [cycle]);

  if (!mounted || !open || !cycle) return null;

  const geoOk = hasGeo || (cycle.geometry?.length ?? 0) >= 2;
  const geoAligned =
    !!cycle.geometry && cycle.geometry.length === cycle.time.length;
  const st = cycle.stats;

  return createPortal(
    <div className="fixed inset-0 z-[1400] flex justify-end" role="dialog" aria-modal>
      <button
        type="button"
        className="absolute inset-0 bg-slate-900/40"
        aria-label="Fermer"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-xl flex-col border-l border-slate-200 bg-white shadow-2xl transition-transform duration-200 ease-out">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-bold text-slate-900">
              {title || cycle.name}
            </h2>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {cycle.source}
              {cycle.corpusId ? ` · ${cycle.corpusId}` : ""}
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {geoOk ? (
                <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
                  Avec GPS
                </span>
              ) : (
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                  Sans GPS
                </span>
              )}
              <span className="rounded bg-slate-50 px-1.5 py-0.5 text-[10px] tabular-nums text-slate-600">
                {cycle.time.length} pts
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              disabled={exporting || cycle.time.length < 1}
              onClick={() => exportExcel()}
              className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              title="Exporter toutes les séries en CSV (Excel)"
            >
              {exporting ? "Export…" : "Export Excel"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
            >
              Fermer
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <section className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <h3 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              KPIs
            </h3>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
              <div>
                <dt className="text-slate-400">Durée</dt>
                <dd className="font-semibold tabular-nums text-slate-800">
                  {st.duration_s.toFixed(1)} s
                </dd>
              </div>
              <div>
                <dt className="text-slate-400">Distance</dt>
                <dd className="font-semibold tabular-nums text-slate-800">
                  {(st.distance_m / 1000).toFixed(2)} km
                </dd>
              </div>
              <div>
                <dt className="text-slate-400">v̄</dt>
                <dd className="font-semibold tabular-nums text-slate-800">
                  {st.v_mean_kmh.toFixed(1)} km/h
                </dd>
              </div>
              <div>
                <dt className="text-slate-400">vmax</dt>
                <dd className="font-semibold tabular-nums text-slate-800">
                  {st.v_max_kmh.toFixed(1)} km/h
                </dd>
              </div>
              <div>
                <dt className="text-slate-400">Pente moy.</dt>
                <dd className="font-semibold tabular-nums text-slate-800">
                  {st.slope_mean_pct != null
                    ? `${st.slope_mean_pct.toFixed(1)} %`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-slate-400">Pente min / max</dt>
                <dd className="font-semibold tabular-nums text-slate-800">
                  {st.slope_min_pct != null && st.slope_max_pct != null
                    ? `${st.slope_min_pct.toFixed(1)} / ${st.slope_max_pct.toFixed(1)} %`
                    : "—"}
                </dd>
              </div>
            </dl>
          </section>

          {(cycle.meta?.citation ||
            cycle.meta?.license ||
            cycle.sourceUrl ||
            cycle.meta?.notes) && (
            <section className="rounded-lg border border-slate-200 p-3 text-[11px] leading-snug text-slate-600">
              <h3 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Provenance
              </h3>
              {cycle.meta?.citation && (
                <p className="mt-1">{cycle.meta.citation}</p>
              )}
              {cycle.meta?.license && (
                <p className="mt-1 text-slate-500">
                  Licence : {cycle.meta.license}
                </p>
              )}
              {(cycle.sourceUrl || cycle.meta?.sourceUrl) && (
                <a
                  href={cycle.sourceUrl || cycle.meta?.sourceUrl || "#"}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-block text-brand hover:underline"
                >
                  Source web
                </a>
              )}
            </section>
          )}

          <section>
            <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Aperçu séries ({rows.length} lignes affichées / {cycle.time.length})
            </h3>
            <div className="overflow-auto rounded-lg border border-slate-200">
              <table className="w-full min-w-[520px] border-collapse text-left text-[10px]">
                <thead className="sticky top-0 bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-2 py-1.5">#</th>
                    <th className="px-2 py-1.5">t (s)</th>
                    <th className="px-2 py-1.5">v (km/h)</th>
                    <th className="px-2 py-1.5">a (m/s²)</th>
                    <th className="px-2 py-1.5">pente %</th>
                    <th className="px-2 py-1.5">s (m)</th>
                    {geoAligned && (
                      <>
                        <th className="px-2 py-1.5">lat</th>
                        <th className="px-2 py-1.5">lon</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.i} className="border-t border-slate-100">
                      <td className="px-2 py-1 tabular-nums text-slate-400">
                        {r.i}
                      </td>
                      <td className="px-2 py-1 tabular-nums">{r.t.toFixed(2)}</td>
                      <td className="px-2 py-1 tabular-nums">{r.v.toFixed(2)}</td>
                      <td className="px-2 py-1 tabular-nums">{r.a.toFixed(3)}</td>
                      <td className="px-2 py-1 tabular-nums">
                        {r.slope.toFixed(2)}
                      </td>
                      <td className="px-2 py-1 tabular-nums">{r.s.toFixed(1)}</td>
                      {geoAligned && (
                        <>
                          <td className="px-2 py-1 tabular-nums">
                            {r.lat != null ? r.lat.toFixed(5) : "—"}
                          </td>
                          <td className="px-2 py-1 tabular-nums">
                            {r.lon != null ? r.lon.toFixed(5) : "—"}
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {geoOk && !geoAligned && geoPreview.length > 0 && (
              <div className="mt-2 rounded-lg border border-emerald-100 bg-emerald-50/50 p-2 text-[10px] text-slate-600">
                <p className="font-semibold text-emerald-900">
                  Polyligne GPS ({cycle.geometry.length} pts)
                </p>
                <ul className="mt-1 space-y-0.5 font-mono tabular-nums">
                  {geoPreview.map((p, i) => (
                    <li key={`${p.lat}-${p.lon}-${i}`}>
                      {p.lat.toFixed(5)}, {p.lon.toFixed(5)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>
      </aside>
    </div>,
    document.body
  );
}
