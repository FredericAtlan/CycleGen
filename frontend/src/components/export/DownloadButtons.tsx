"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  downloadBlob,
  exportProfile,
} from "@/lib/api";
import {
  downloadCycleCsvEnriched,
  downloadCycleExcel,
} from "@/lib/exportWorkbook";
import { buildInspectRunMeta, type InspectRunMeta } from "@/lib/inspectRunMeta";
import type { DriverPhysics } from "@/lib/driverPresets";
import type { EnvelopeMask } from "@/lib/corridorEdit";
import type { SlopeAlgoOptions } from "@/lib/slopeAlgo";
import type {
  ConsolidatedProfile,
  DriverProfile,
  ExportFormat,
  SpatialCorridor,
} from "@/lib/types";
import type { VehicleCard } from "@/lib/vehicleLibrary";
import { DEFAULT_A_Y } from "@/lib/driverPresets";

type DownloadButtonsProps = {
  profile: ConsolidatedProfile;
  corridor?: SpatialCorridor | null;
  vehicle?: VehicleCard | null;
  aY?: number;
  runMeta?: InspectRunMeta | null;
  /** stack = sidebar / panel ; toolbar = barre d’actions compacte */
  variant?: "stack" | "toolbar";
  routeLabel?: string;
  trafficSource?: string | null;
  driverProfile?: DriverProfile;
  physics?: DriverPhysics | null;
  engine?: string | null;
  maxSpeedKmh?: number | null;
  envelopeMask?: EnvelopeMask | null;
  routingProfile?: string | null;
  departAt?: string | null;
  driverZonesEnabled?: boolean;
  driverZonesCount?: number;
  includeTrafficLights?: boolean;
  slopeAlgo?: SlopeAlgoOptions | null;
  saveTitle?: string | null;
  originLat?: number | null;
  originLon?: number | null;
  destLat?: number | null;
  destLon?: number | null;
  elevationA_m?: number | null;
  elevationB_m?: number | null;
  /** Figure exports from the analyse studio (JPEG / CSV fenêtre). */
  onExportJpegFigure?: (() => void) | null;
  onExportCsvWindow?: (() => void) | null;
  figureExportBusy?: boolean;
  figureExportDisabled?: boolean;
};

type BusyKind = ExportFormat | "xlsx" | "csv_rich";

const btnBase =
  "inline-flex min-w-0 items-center justify-center gap-1 rounded-md text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";

export default function DownloadButtons({
  profile,
  corridor = null,
  vehicle = null,
  aY = DEFAULT_A_Y,
  runMeta = null,
  variant = "stack",
  routeLabel,
  trafficSource = null,
  driverProfile,
  physics = null,
  engine = null,
  maxSpeedKmh = null,
  envelopeMask = null,
  routingProfile = null,
  departAt = null,
  driverZonesEnabled = false,
  driverZonesCount = 0,
  includeTrafficLights,
  slopeAlgo = null,
  saveTitle = null,
  originLat = null,
  originLon = null,
  destLat = null,
  destLon = null,
  elevationA_m = null,
  elevationB_m = null,
  onExportJpegFigure = null,
  onExportCsvWindow = null,
  figureExportBusy = false,
  figureExportDisabled = false,
}: DownloadButtonsProps) {
  const [busy, setBusy] = useState<BusyKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const geoOriginLat = originLat ?? corridor?.geometry?.[0]?.lat ?? null;
  const geoOriginLon = originLon ?? corridor?.geometry?.[0]?.lon ?? null;
  const geoDestLat =
    destLat ??
    (corridor?.geometry && corridor.geometry.length >= 2
      ? corridor.geometry[corridor.geometry.length - 1].lat
      : null);
  const geoDestLon =
    destLon ??
    (corridor?.geometry && corridor.geometry.length >= 2
      ? corridor.geometry[corridor.geometry.length - 1].lon
      : null);

  const resolvedMeta = useMemo(() => {
    if (runMeta) return runMeta;
    return buildInspectRunMeta({
      routeLabel,
      saveTitle,
      originLat: geoOriginLat,
      originLon: geoOriginLon,
      destLat: geoDestLat,
      destLon: geoDestLon,
      trafficSource:
        trafficSource ?? profile.traffic_source ?? corridor?.traffic_source,
      engine,
      driverProfile,
      physics,
      aY,
      maxSpeedKmh,
      vehicle,
      envelopeMask,
      includeTrafficLights,
      feuxCount: corridor?.S_feux?.length ?? 0,
      slopeAlgo,
      routingProfile,
      departAt,
      driverZonesEnabled,
      driverZonesCount,
      profileStatus: profile.status,
      distanceM: profile.position.length
        ? profile.position[profile.position.length - 1]
        : null,
      durationS: profile.total_duration_s,
      avgSpeedKmh: profile.average_speed_kmh,
    });
  }, [
    runMeta,
    routeLabel,
    saveTitle,
    geoOriginLat,
    geoOriginLon,
    geoDestLat,
    geoDestLon,
    trafficSource,
    profile,
    corridor,
    engine,
    driverProfile,
    physics,
    aY,
    maxSpeedKmh,
    vehicle,
    envelopeMask,
    includeTrafficLights,
    slopeAlgo,
    routingProfile,
    departAt,
    driverZonesEnabled,
    driverZonesCount,
  ]);

  const ctx = useMemo(
    () => ({
      profile,
      corridor,
      vehicle,
      aY,
      physics,
      geometry: corridor?.geometry ?? null,
      runMeta: resolvedMeta,
      saveTitle: saveTitle?.trim() || null,
      originLat: geoOriginLat,
      originLon: geoOriginLon,
      destLat: geoDestLat,
      destLon: geoDestLon,
      elevationA_m:
        elevationA_m ??
        (corridor?.elevations_m?.length ? corridor.elevations_m[0] : null),
      elevationB_m:
        elevationB_m ??
        (corridor?.elevations_m && corridor.elevations_m.length >= 2
          ? corridor.elevations_m[corridor.elevations_m.length - 1]
          : null),
    }),
    [
      profile,
      corridor,
      vehicle,
      aY,
      physics,
      resolvedMeta,
      saveTitle,
      geoOriginLat,
      geoOriginLon,
      geoDestLat,
      geoDestLon,
      elevationA_m,
      elevationB_m,
    ]
  );

  const handleExcel = () => {
    setBusy("xlsx");
    setError(null);
    void downloadCycleExcel(ctx)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Export Excel échoué");
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const handleCsvRich = () => {
    setBusy("csv_rich");
    setError(null);
    try {
      downloadCycleCsvEnriched(ctx);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export CSV échoué");
    } finally {
      setBusy(null);
    }
  };

  const handleLegacy = async (format: ExportFormat) => {
    setBusy(format);
    setError(null);
    try {
      const { blob, filename } = await exportProfile(profile, format);
      downloadBlob(blob, filename);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Export failed"
      );
    } finally {
      setBusy(null);
    }
  };

  const Spinner = ({ light }: { light?: boolean }) => (
    <span
      className={`h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-t-transparent ${
        light ? "border-white" : "border-current"
      }`}
    />
  );

  if (variant === "toolbar") {
    return (
      <div ref={menuRef} className="relative shrink-0">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          disabled={busy != null}
          title="Exporter le cycle (Excel, CSV, XML)"
          aria-expanded={menuOpen}
          className={`${btnBase} border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-700 hover:bg-slate-50`}
        >
          {busy != null ? <Spinner /> : null}
          Exporter
          <span className="text-slate-400" aria-hidden>
            ▾
          </span>
        </button>
        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full z-[1200] mt-1 min-w-[12.5rem] rounded-md border border-slate-200 bg-white py-1 shadow-lg"
          >
            <p className="px-3 py-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400">
              Cycle
            </p>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                handleExcel();
              }}
              disabled={busy != null}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
              title="Excel multi-onglets (Traçabilité + Profil + Unités)"
            >
              Excel (.xlsx)
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                handleCsvRich();
              }}
              disabled={busy != null}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
              title="CSV enrichi + commentaires de traçabilité"
            >
              CSV enrichi
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                void handleLegacy("xml");
              }}
              disabled={busy != null}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
              title="Export XML (API)"
            >
              XML
            </button>
            {(onExportJpegFigure || onExportCsvWindow) && (
              <>
                <div className="my-1 border-t border-slate-100" />
                <p className="px-3 py-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                  Figure analyse
                </p>
                {onExportJpegFigure && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onExportJpegFigure();
                    }}
                    disabled={
                      busy != null || figureExportBusy || figureExportDisabled
                    }
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
                    title="Exporter uniquement la figure courante (JPEG)"
                  >
                    JPEG figure
                  </button>
                )}
                {onExportCsvWindow && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onExportCsvWindow();
                    }}
                    disabled={
                      busy != null || figureExportBusy || figureExportDisabled
                    }
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
                    title="CSV de la fenêtre / séries affichées"
                  >
                    CSV fenêtre
                  </button>
                )}
              </>
            )}
          </div>
        )}
        {error && (
          <span className="absolute right-0 top-full mt-8 whitespace-nowrap text-[10px] text-red-600">
            {error}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="min-w-0 w-full max-w-full space-y-2 overflow-hidden">
      <button
        type="button"
        onClick={handleExcel}
        disabled={busy != null}
        className={`${btnBase} w-full bg-brand px-2.5 py-2 text-white hover:bg-brand-dark`}
        title="Excel : Traçabilité (+ carte) · Profil · Courbes · Unités"
      >
        {busy === "xlsx" && <Spinner light />}
        <span className="truncate">Excel (.xlsx)</span>
      </button>
      <div className="grid min-w-0 grid-cols-2 gap-1.5">
        <button
          type="button"
          onClick={handleCsvRich}
          disabled={busy != null}
          className={`${btnBase} border border-brand bg-white px-2 py-2 text-brand hover:bg-brand/5`}
          title="CSV enrichi (1 feuille) : commentaires de traçabilité + colonnes d’analyse"
        >
          {busy === "csv_rich" && <Spinner />}
          <span className="truncate">CSV enrichi</span>
        </button>
        <button
          type="button"
          onClick={() => void handleLegacy("xml")}
          disabled={busy != null}
          className={`${btnBase} border border-slate-200 bg-white px-2 py-2 text-slate-700 hover:bg-slate-50`}
        >
          {busy === "xml" && <Spinner />}
          <span className="truncate">XML</span>
        </button>
      </div>
      <p className="break-words text-[10px] leading-snug text-slate-500">
        Excel : Traçabilité (+ carte) · Profil · Courbes · Unités. CSV : même profil +
        lignes <code className="rounded bg-slate-100 px-0.5">#</code>. Priorité{" "}
        <span className="font-semibold text-slate-700">time · v · pente %</span>
        {vehicle
          ? "."
          : " — véhicule requis pour couple / puissances / rpm."}
      </p>
      {error && <p className="break-words text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
