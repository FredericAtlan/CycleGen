"use client";

import { useMemo, useState, useEffect } from "react";
import DownloadButtons from "@/components/export/DownloadButtons";
import SaveCycleButton from "@/components/SaveCycleButton";
import ResultsAnalyseStudio from "@/components/export/ResultsAnalyseStudio";
import WarningsPanel, {
  trafficSourceBadgeClass,
  trafficSourceLabel,
} from "@/components/WarningsPanel";
import {
  buildInspectRows,
} from "@/lib/chartInspectData";
import { buildInspectRunMeta } from "@/lib/inspectRunMeta";
import type { EnvelopeMask } from "@/lib/corridorEdit";
import { computeCycleStats } from "@/lib/cycleMetrics";
import type { DriverPhysics } from "@/lib/driverPresets";
import type { DriverZone } from "@/lib/driverZones";
import type { SlopeAlgoOptions } from "@/lib/slopeAlgo";
import type {
  ConsolidatedProfile,
  CycleGenWarning,
  DriverProfile,
  SimEngine,
  SpatialCorridor,
  WaypointDraft,
} from "@/lib/types";
import type { SlopeUnit } from "@/lib/units";
import { slopeExtremes, slopeUnitLabel } from "@/lib/units";
import type { VehicleCard } from "@/lib/vehicleLibrary";
import VehiclePanel from "@/components/VehiclePanel";

export type ResultsAnalysisPanelProps = {
  profile: ConsolidatedProfile;
  corridor: SpatialCorridor | null;
  onCorridorChange?: (c: SpatialCorridor) => void;
  vehicle: VehicleCard | null;
  aY: number;
  slopeUnit: SlopeUnit;
  onSlopeUnitChange: (u: SlopeUnit) => void;
  syncEnabled?: boolean;
  onCursorS?: (s_m: number | null) => void;
  onBrushRangeS?: (range: { s0: number; s1: number } | null) => void;
  /** Playback playhead time (s). */
  highlightT?: number | null;
  /** Pan analyse charts to follow the playhead while replaying. */
  followPlayhead?: boolean;
  /** Keyboard scrub / moment jump → seek playhead. */
  onSeekT?: (t: number) => void;
  trafficSource?: string | null;
  warnings?: CycleGenWarning[];
  driverProfile: DriverProfile;
  /** Named driver library id / display name for meta + Excel. */
  driverId?: string | null;
  driverName?: string | null;
  routeLabel: string;
  onVersus?: () => void;
  physics?: DriverPhysics | null;
  engine?: SimEngine | string | null;
  maxSpeedKmh?: number | null;
  envelopeMask?: EnvelopeMask | null;
  routingProfile?: string | null;
  departAt?: string | null;
  driverZonesEnabled?: boolean;
  driverZonesCount?: number;
  driverZones?: DriverZone[];
  distanceM?: number | null;
  durationS?: number | null;
  noGps?: boolean;
  vehicleId?: string | null;
  onVehicleSelect?: (v: VehicleCard) => void;
  slopeAlgo?: SlopeAlgoOptions | null;
  includeTrafficLights?: boolean;
  waypoints?: WaypointDraft[];
  elevationA_m?: number | null;
  elevationB_m?: number | null;
  originLat?: number | null;
  originLon?: number | null;
  destLat?: number | null;
  destLon?: number | null;
  /** Nom de l’étude (export + enregistrement bibliothèque). */
  studyName?: string | null;
  onCycleSaved?: (name: string) => void;
  /** Kept for API compat — reference overlay handled in future focus layers. */
  referenceCycle?: {
    name: string;
    time: number[];
    velocity: number[];
  } | null;
  onClearReference?: () => void;
  libraryOrigin?: "cyclegen" | "corpus" | "import";
};

function formatKpiDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h${m % 60}`;
  }
  return `${m} min ${s}s`;
}

export default function ResultsAnalysisPanel({
  profile,
  corridor,
  onCorridorChange,
  vehicle,
  aY,
  slopeUnit,
  onSlopeUnitChange,
  syncEnabled = false,
  onCursorS,
  onBrushRangeS,
  highlightT = null,
  followPlayhead = false,
  onSeekT,
  trafficSource = null,
  warnings = [],
  driverProfile,
  driverId = null,
  driverName = null,
  routeLabel,
  onVersus,
  physics = null,
  engine = null,
  maxSpeedKmh = null,
  envelopeMask = null,
  routingProfile = null,
  departAt = null,
  driverZonesEnabled = false,
  driverZonesCount = 0,
  driverZones,
  distanceM = null,
  durationS = null,
  noGps = false,
  vehicleId = null,
  onVehicleSelect,
  slopeAlgo = null,
  includeTrafficLights,
  waypoints,
  elevationA_m = null,
  elevationB_m = null,
  originLat = null,
  originLon = null,
  destLat = null,
  destLon = null,
  studyName = null,
  onCycleSaved,
  libraryOrigin,
}: ResultsAnalysisPanelProps) {
  const [fullscreen, setFullscreen] = useState(false);
  const [figureExports, setFigureExports] = useState<{
    exportJpeg: () => void;
    exportCsv: () => void;
    busy: boolean;
    disabled: boolean;
  } | null>(null);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const kpis = useMemo(() => computeCycleStats(profile), [profile]);

  const inspectRows = useMemo(
    () =>
      buildInspectRows({
        profile,
        corridor,
        vehicle,
        aY,
        slopeUnit,
      }),
    [profile, corridor, vehicle, aY, slopeUnit]
  );

  const gpsOriginLat = originLat ?? corridor?.geometry?.[0]?.lat ?? null;
  const gpsOriginLon = originLon ?? corridor?.geometry?.[0]?.lon ?? null;
  const gpsDestLat =
    destLat ??
    (corridor?.geometry && corridor.geometry.length >= 2
      ? corridor.geometry[corridor.geometry.length - 1].lat
      : null);
  const gpsDestLon =
    destLon ??
    (corridor?.geometry && corridor.geometry.length >= 2
      ? corridor.geometry[corridor.geometry.length - 1].lon
      : null);

  const resolvedStudyName = studyName?.trim() || null;

  const runMeta = useMemo(
    () =>
      buildInspectRunMeta({
        routeLabel,
        saveTitle: resolvedStudyName,
        originLat: gpsOriginLat,
        originLon: gpsOriginLon,
        destLat: gpsDestLat,
        destLon: gpsDestLon,
        trafficSource:
          trafficSource ?? profile.traffic_source ?? corridor?.traffic_source,
        engine,
        driverProfile,
        driverId,
        driverName,
        physics,
        aY,
        maxSpeedKmh,
        vehicle,
        envelopeMask,
        feuxCount: corridor?.S_feux?.length ?? 0,
        includeTrafficLights,
        slopeAlgo,
        routingProfile,
        departAt,
        driverZonesEnabled,
        driverZonesCount,
        profileStatus: profile.status,
        distanceM:
          distanceM ??
          (profile.position.length
            ? profile.position[profile.position.length - 1]
            : null),
        durationS: durationS ?? profile.total_duration_s,
        avgSpeedKmh: profile.average_speed_kmh,
      }),
    [
      routeLabel,
      resolvedStudyName,
      gpsOriginLat,
      gpsOriginLon,
      gpsDestLat,
      gpsDestLon,
      trafficSource,
      profile,
      corridor,
      engine,
      driverProfile,
      driverId,
      driverName,
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
      distanceM,
      durationS,
    ]
  );

  const displayWarnings =
    noGps
      ? (warnings.length > 0 ? warnings : profile.warnings ?? []).filter(
          (w) => w.code !== "no_gps"
        )
      : warnings.length > 0
        ? warnings
        : profile.warnings?.length
          ? profile.warnings
          : corridor?.warnings ?? [];

  const trafficLabel = trafficSourceLabel(
    trafficSource ?? profile.traffic_source ?? corridor?.traffic_source
  );

  const badgeClass =
    profile.status === "completed"
      ? "bg-emerald-50 text-emerald-700"
      : "bg-amber-50 text-amber-700";

  const distLabel = kpis
    ? kpis.distance_m >= 1000
      ? `${(kpis.distance_m / 1000).toFixed(2)} km`
      : `${Math.round(kpis.distance_m)} m`
    : "—";

  const slopeExtLabel = useMemo(() => {
    const fromProfile = slopeExtremes(profile.slope, slopeUnit);
    const ext = fromProfile ?? slopeExtremes(corridor?.alpha, slopeUnit);
    if (!ext) return null;
    const digits = slopeUnit === "percent" ? 1 : slopeUnit === "deg" ? 2 : 4;
    const u = slopeUnitLabel(slopeUnit);
    return `Pente min ${ext.min.toFixed(digits)} ${u} · Pente max ${ext.max.toFixed(digits)} ${u}`;
  }, [profile.slope, corridor?.alpha, slopeUnit]);

  return (
    <aside
      className={
        fullscreen
          ? "fixed inset-0 z-[1150] flex flex-col bg-white"
          : "flex h-full min-w-0 flex-1 flex-col border-l border-slate-200 bg-white"
      }
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 px-3 py-1.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <h2 className="text-sm font-semibold text-slate-900">Analyse</h2>
          {noGps ? (
            <span
              className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900"
              title="Pas de GPS — P / couple depuis le véhicule (masse, F0/F1/F2, r_dyn)"
            >
              Trace t/v/pente
            </span>
          ) : (
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${badgeClass}`}
            >
              {profile.status}
            </span>
          )}
          {!noGps && trafficLabel && (
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${trafficSourceBadgeClass(
                trafficSource ??
                  profile.traffic_source ??
                  corridor?.traffic_source
              )}`}
            >
              {trafficLabel}
            </span>
          )}
          {noGps && onVehicleSelect ? (
            <VehiclePanel
              selectedId={vehicleId}
              onSelect={onVehicleSelect}
              compact
            />
          ) : (
            kpis && (
              <span className="min-w-0 truncate text-[10px] tabular-nums text-slate-500">
                {formatKpiDuration(kpis.duration_s)} · {distLabel} · v̄{" "}
                {kpis.v_mean_kmh.toFixed(0)} km/h · Vmax{" "}
                {kpis.v_max_kmh.toFixed(0)} km/h
                {slopeExtLabel ? ` · ${slopeExtLabel}` : ""}
                {vehicle
                  ? ` · ${vehicle.name} (${vehicle.code}) · ${vehicle.massCode} ${Math.round(vehicle.mass_kg)} kg`
                  : ""}
              </span>
            )
          )}
          {noGps && kpis && (
            <span className="hidden min-w-0 truncate text-[10px] tabular-nums text-slate-400 lg:inline">
              {formatKpiDuration(kpis.duration_s)} · {distLabel} · v̄{" "}
              {kpis.v_mean_kmh.toFixed(0)} km/h
            </span>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {fullscreen ? (
            <button
              type="button"
              onClick={() => setFullscreen(false)}
              className="shrink-0 rounded-md border border-brand bg-brand px-2.5 py-1 text-[10px] font-semibold text-white hover:bg-brand-dark"
              title="Revenir à la vue Studio (carte + analyse) — Échap"
            >
              Quitter plein écran
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setFullscreen(true)}
              className="shrink-0 rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] font-semibold text-slate-700 hover:bg-slate-50"
              title="Plein écran analyse"
            >
              Plein écran
            </button>
          )}
          <DownloadButtons
            variant="toolbar"
            profile={profile}
            corridor={corridor}
            vehicle={vehicle}
            aY={aY}
            runMeta={runMeta}
            saveTitle={resolvedStudyName}
            originLat={gpsOriginLat}
            originLon={gpsOriginLon}
            destLat={gpsDestLat}
            destLon={gpsDestLon}
            elevationA_m={elevationA_m}
            elevationB_m={elevationB_m}
            onExportJpegFigure={
              figureExports ? () => figureExports.exportJpeg() : null
            }
            onExportCsvWindow={
              figureExports ? () => figureExports.exportCsv() : null
            }
            figureExportBusy={figureExports?.busy ?? false}
            figureExportDisabled={figureExports?.disabled ?? true}
          />
          <SaveCycleButton
            variant="toolbar"
            profile={profile}
            corridor={corridor}
            aY={aY}
            driverProfile={driverProfile}
            driverId={driverId}
            driverName={driverName}
            trafficSource={trafficSource}
            routeLabel={routeLabel}
            studyName={resolvedStudyName}
            originLat={gpsOriginLat}
            originLon={gpsOriginLon}
            destLat={gpsDestLat}
            destLon={gpsDestLon}
            physics={physics}
            routingProfile={routingProfile}
            departAt={departAt}
            maxSpeedKmh={maxSpeedKmh}
            vehicleId={vehicleId}
            preferredEngine={engine}
            envelopeMask={envelopeMask}
            slopeAlgo={slopeAlgo}
            includeTrafficLights={includeTrafficLights}
            driverZonesEnabled={driverZonesEnabled}
            driverZones={driverZones}
            waypoints={waypoints}
            elevationA_m={elevationA_m}
            elevationB_m={elevationB_m}
            onSaved={onCycleSaved}
            libraryOrigin={libraryOrigin}
          />
          {onVersus && (
            <button
              type="button"
              onClick={onVersus}
              disabled={profile.time.length < 2}
              className="shrink-0 rounded-md bg-brand px-2 py-1 text-[10px] font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
            >
              Versus
            </button>
          )}
        </div>
      </div>

      {!noGps && vehicle && (
        <p className="shrink-0 border-b border-slate-100 px-3 py-1.5 text-[11px] text-slate-500">
          Véhicule (étape Comportement) :{" "}
          <span className="font-semibold text-slate-700">
            {vehicle.name} · {vehicle.code} · {vehicle.massCode}{" "}
            {Math.round(vehicle.mass_kg)} kg · F0={vehicle.f0_n} N
          </span>
          {" — "}courbes P / couple aux roues ci-dessous.
        </p>
      )}

      <ResultsAnalyseStudio
        rows={inspectRows}
        profile={profile}
        corridor={noGps ? null : corridor}
        onCorridorChange={noGps ? undefined : onCorridorChange}
        runMeta={runMeta}
        slopeUnit={slopeUnit}
        onSlopeUnitChange={onSlopeUnitChange}
        syncEnabled={noGps ? false : syncEnabled}
        onCursorS={noGps ? undefined : onCursorS}
        onBrushRangeS={noGps ? undefined : onBrushRangeS}
        highlightT={highlightT}
        followPlayhead={followPlayhead}
        onSeekT={onSeekT}
        warnings={displayWarnings}
        noGps={noGps}
        hasVehicle={vehicle != null}
        onFigureExportsChange={setFigureExports}
        elevationMeta={
          noGps
            ? null
            : {
                originLat: gpsOriginLat,
                originLon: gpsOriginLon,
                destLat: gpsDestLat,
                destLon: gpsDestLon,
                originLabel: routeLabel.includes("→")
                  ? routeLabel.split("→")[0]?.trim()
                  : routeLabel,
                destLabel: routeLabel.includes("→")
                  ? routeLabel.split("→")[1]?.trim()
                  : null,
              }
        }
      />
    </aside>
  );
}
