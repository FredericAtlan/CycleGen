"use client";

/**
 * RouterSourceToggles — per-router V_legal / V_traffic / Z checkboxes.
 *
 * Presents the routers that actually contributed to the analyze payload
 * (from `routers_used` + `router_status`) with an "OK / no key / error" badge,
 * and lets the user cock/uncoc each source (speed_sources / elevation_sources).
 */

import type { ReactNode } from "react";
import {
  ROUTER_LABELS,
  type ElevationSourceKey,
  type RouterKey,
} from "@/lib/types";

export type SourceStatus = "ok" | "skipped" | "error" | "unknown";

function statusFromTag(tag: string | undefined): SourceStatus {
  if (!tag) return "unknown";
  if (tag === "ok") return "ok";
  if (tag.startsWith("skipped")) return "skipped";
  if (tag.startsWith("error")) return "error";
  return "unknown";
}

function StatusBadge({
  status,
  hint,
}: {
  status: SourceStatus;
  hint?: string;
}) {
  const map: Record<SourceStatus, { label: string; cls: string }> = {
    ok: { label: "OK", cls: "bg-emerald-500/10 text-emerald-700" },
    skipped: { label: "clé absente", cls: "bg-amber-500/10 text-amber-700" },
    error: { label: "erreur", cls: "bg-rose-500/10 text-rose-700" },
    unknown: { label: "n/a", cls: "bg-slate-400/10 text-slate-500" },
  };
  const cfg = map[status];
  return (
    <span
      title={hint}
      className={`ml-2 inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${cfg.cls}`}
    >
      {cfg.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Speed sources (V_legal / V_traffic per router + OSM overlay)
// ---------------------------------------------------------------------------

export type SpeedSourceKey = RouterKey | "osm";

export const SPEED_SOURCE_LABELS: Record<SpeedSourceKey, string> = {
  here: "V légal HERE (maxSpeed)",
  mapbox: "V légal Mapbox (annotation.speed)",
  osrm: "V légal OSRM (annotation.speed)",
  osm: "V légal OSM (maxspeed overlay)",
};

export type SpeedSourceRow = {
  key: SpeedSourceKey;
  present: boolean;
  status: SourceStatus;
  statusHint?: string;
};

export function buildSpeedSourceRows(opts: {
  routersUsed?: RouterKey[];
  routerStatus?: Partial<Record<RouterKey, string>>;
  speedsByRouter?: Partial<Record<RouterKey, number[]>>;
  osmSpeedLimitsCount?: number;
}): SpeedSourceRow[] {
  const rows: SpeedSourceRow[] = [];
  const routers: RouterKey[] = ["here", "mapbox", "osrm"];
  for (const key of routers) {
    const rawStatus = opts.routerStatus?.[key];
    const has = (opts.speedsByRouter?.[key]?.length ?? 0) > 0;
    rows.push({
      key,
      present: has,
      status: has ? "ok" : statusFromTag(rawStatus),
      statusHint: rawStatus,
    });
  }
  const osmCount = opts.osmSpeedLimitsCount ?? 0;
  rows.push({
    key: "osm",
    present: osmCount > 0,
    status: osmCount > 0 ? "ok" : "unknown",
    statusHint: osmCount > 0 ? `${osmCount} ways` : "aucun tag maxspeed",
  });
  return rows;
}

export function RouterSpeedToggles({
  rows,
  selected,
  onChange,
  disabled = false,
  extra,
}: {
  rows: SpeedSourceRow[];
  selected: SpeedSourceKey[];
  onChange: (next: SpeedSourceKey[]) => void;
  disabled?: boolean;
  extra?: ReactNode;
}) {
  const setKey = (key: SpeedSourceKey, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(key);
    else next.delete(key);
    onChange(Array.from(next));
  };
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50/80 p-2.5">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Sources V légale (par routeur)
        </h3>
        <span className="text-[10px] text-slate-400">
          combinaison → V_legal
        </span>
      </div>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => {
          const routerLabel =
            row.key === "osm" ? "OSM (maxspeed)" : ROUTER_LABELS[row.key as RouterKey];
          return (
            <li key={row.key} className="flex items-center justify-between">
              <label
                className={`inline-flex cursor-pointer items-center gap-2 text-[11px] font-medium text-slate-700 ${
                  disabled || !row.present ? "cursor-not-allowed opacity-60" : ""
                }`}
                title={SPEED_SOURCE_LABELS[row.key]}
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-brand"
                  checked={selected.includes(row.key)}
                  disabled={disabled || !row.present}
                  onChange={(e) => setKey(row.key, e.target.checked)}
                />
                <span>{routerLabel}</span>
              </label>
              <StatusBadge status={row.status} hint={row.statusHint} />
            </li>
          );
        })}
      </ul>
      {extra}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Elevation sources
// ---------------------------------------------------------------------------

export const ELEVATION_LABELS: Record<ElevationSourceKey, string> = {
  here: "Z HERE (polyline 3D)",
  "open-meteo": "Z Open-Meteo (DEM)",
  "open-elevation": "Z Open-Elevation",
  "opentopodata": "Z OpenTopoData (ASTER 30 m)",
};

export type ElevationSourceRow = {
  key: ElevationSourceKey;
  present: boolean;
  status: SourceStatus;
  statusHint?: string;
};

export function buildElevationSourceRows(opts: {
  elevationsBySource?: Partial<Record<ElevationSourceKey, number[]>>;
  elevationSourceTag?: string | null;
}): ElevationSourceRow[] {
  const keys: ElevationSourceKey[] = [
    "here",
    "open-meteo",
    "open-elevation",
    "opentopodata",
  ];
  return keys.map((key) => {
    const arr = opts.elevationsBySource?.[key];
    const has = arr && arr.length > 0 && arr.some((z) => Math.abs(z) > 1e-6);
    return {
      key,
      present: !!has,
      status: has ? "ok" : "unknown",
      statusHint: has ? `${arr!.length} pts` : "non disponible",
    };
  });
}

export function ElevationSourceToggles({
  rows,
  selected,
  onChange,
  combine,
  onCombineChange,
  disabled = false,
}: {
  rows: ElevationSourceRow[];
  selected: ElevationSourceKey[];
  onChange: (next: ElevationSourceKey[]) => void;
  combine: "mean" | "min" | "max";
  onCombineChange: (mode: "mean" | "min" | "max") => void;
  disabled?: boolean;
}) {
  const setKey = (key: ElevationSourceKey, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(key);
    else next.delete(key);
    onChange(Array.from(next));
  };
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50/80 p-2.5">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Sources d’altitude
        </h3>
        <label className="text-[10px] text-slate-500">
          combine{" "}
          <select
            className="ml-1 rounded border border-slate-200 bg-white px-1 py-0.5 text-[10px]"
            value={combine}
            onChange={(e) => onCombineChange(e.target.value as "mean" | "min" | "max")}
            disabled={disabled}
          >
            <option value="mean">moyenne</option>
            <option value="min">min</option>
            <option value="max">max</option>
          </select>
        </label>
      </div>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center justify-between">
            <label
              className={`inline-flex cursor-pointer items-center gap-2 text-[11px] font-medium text-slate-700 ${
                disabled || !row.present ? "cursor-not-allowed opacity-60" : ""
              }`}
              title={ELEVATION_LABELS[row.key]}
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-brand"
                checked={selected.includes(row.key)}
                disabled={disabled || !row.present}
                onChange={(e) => setKey(row.key, e.target.checked)}
              />
              <span>{ELEVATION_LABELS[row.key]}</span>
            </label>
            <StatusBadge status={row.status} hint={row.statusHint} />
          </li>
        ))}
      </ul>
    </div>
  );
}
