"use client";

import { useMemo, useState } from "react";
import type { ConsolidatedProfile, SpatialCorridor, WaypointDraft } from "@/lib/types";
import type { EnvelopeMask } from "@/lib/corridorEdit";
import type { DriverPhysics } from "@/lib/driverPresets";
import type { DriverZone } from "@/lib/driverZones";
import type { SlopeAlgoOptions } from "@/lib/slopeAlgo";
import type { LegalFilterOptions } from "@/lib/legalFilter";
import {
  elevationExtremesM,
  formatGpsCoord,
  resolveCycleSaveName,
  saveCycle,
  slimCorridorForSave,
  type SavedCycleStudioMeta,
} from "@/lib/cycleLibrary";
import {
  computeCycleStats,
  lateralAccelFromCorridor,
  sampleLimitsAlongProfile,
} from "@/lib/cycleMetrics";

type LeaveStudioDialogProps = {
  open: boolean;
  onCancel: () => void;
  /** Leave without saving (session cleared by caller). */
  onLeave: () => void;
  profile: ConsolidatedProfile | null;
  corridor?: SpatialCorridor | null;
  aY?: number;
  driverProfile?: string;
  driverId?: string | null;
  driverName?: string | null;
  trafficSource?: string | null;
  routeLabel?: string;
  /** Nom d’étude prérempli à la sauvegarde. */
  studyName?: string | null;
  originLat?: number | null;
  originLon?: number | null;
  destLat?: number | null;
  destLon?: number | null;
  physics?: DriverPhysics | null;
  routingProfile?: string | null;
  departAt?: string | null;
  maxSpeedKmh?: number | null;
  vehicleId?: string | null;
  preferredEngine?: string | null;
  envelopeMask?: EnvelopeMask | null;
  slopeAlgo?: SlopeAlgoOptions | null;
  legalFilter?: LegalFilterOptions | null;
  includeTrafficLights?: boolean;
  driverZonesEnabled?: boolean;
  driverZones?: DriverZone[];
  waypoints?: WaypointDraft[];
  elevationA_m?: number | null;
  elevationB_m?: number | null;
  onSaved?: (name: string) => void;
};

export default function LeaveStudioDialog({
  open,
  onCancel,
  onLeave,
  profile,
  corridor = null,
  aY = 3.5,
  driverProfile = "Normal",
  driverId = null,
  driverName = null,
  trafficSource = null,
  routeLabel = "",
  studyName = null,
  originLat = null,
  originLon = null,
  destLat = null,
  destLon = null,
  physics = null,
  routingProfile = null,
  departAt = null,
  maxSpeedKmh = null,
  vehicleId = null,
  preferredEngine = null,
  envelopeMask = null,
  slopeAlgo = null,
  legalFilter = null,
  includeTrafficLights,
  driverZonesEnabled,
  driverZones,
  waypoints,
  elevationA_m = null,
  elevationB_m = null,
  onSaved,
}: LeaveStudioDialogProps) {
  const canSave = !!profile && profile.time.length > 1;
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<"confirm" | "save">("confirm");

  const preview = useMemo(() => {
    if (!profile || !canSave) return null;
    const a_lat = lateralAccelFromCorridor(profile, corridor, aY);
    return computeCycleStats({
      time: profile.time,
      velocity: profile.velocity,
      acceleration: profile.acceleration,
      slope: profile.slope,
      position: profile.position,
      a_lat,
    });
  }, [profile, corridor, aY, canSave]);

  const suggestedName = useMemo(
    () =>
      resolveCycleSaveName({
        title: studyName?.trim() || "",
        originLat: originLat ?? corridor?.geometry?.[0]?.lat ?? null,
        originLon: originLon ?? corridor?.geometry?.[0]?.lon ?? null,
        destLat:
          destLat ??
          (corridor?.geometry && corridor.geometry.length >= 2
            ? corridor.geometry[corridor.geometry.length - 1].lat
            : null),
        destLon:
          destLon ??
          (corridor?.geometry && corridor.geometry.length >= 2
            ? corridor.geometry[corridor.geometry.length - 1].lon
            : null),
        routeLabel,
      }),
    [studyName, originLat, originLon, destLat, destLon, corridor, routeLabel]
  );

  if (!open) return null;

  const resetLocal = () => {
    setMode("confirm");
    setErr(null);
    setSaving(false);
    setName("");
  };

  const handleCancel = () => {
    resetLocal();
    onCancel();
  };

  const handleLeave = () => {
    resetLocal();
    onLeave();
  };

  const handleSaveAndLeave = () => {
    if (!profile || !canSave) return;
    setSaving(true);
    setErr(null);
    try {
      const a_lat = lateralAccelFromCorridor(profile, corridor, aY);
      const limits = sampleLimitsAlongProfile(profile, corridor);
      const stats = computeCycleStats({
        time: profile.time,
        velocity: profile.velocity,
        acceleration: profile.acceleration,
        slope: profile.slope,
        position: profile.position,
        a_lat,
      });
      const slimCorridor = slimCorridorForSave(corridor);
      const { z_min_m, z_max_m } = elevationExtremesM(
        slimCorridor?.elevations_m ?? corridor?.elevations_m
      );
      const oLat = originLat ?? corridor?.geometry?.[0]?.lat ?? null;
      const oLon = originLon ?? corridor?.geometry?.[0]?.lon ?? null;
      const dLat =
        destLat ??
        (corridor?.geometry && corridor.geometry.length >= 2
          ? corridor.geometry[corridor.geometry.length - 1].lat
          : null);
      const dLon =
        destLon ??
        (corridor?.geometry && corridor.geometry.length >= 2
          ? corridor.geometry[corridor.geometry.length - 1].lon
          : null);
      const userTitle = name.trim();
      const savedName = resolveCycleSaveName({
        title: userTitle || studyName,
        originLat: oLat,
        originLon: oLon,
        destLat: dLat,
        destLon: dLon,
        routeLabel,
      });
      const meta: SavedCycleStudioMeta = {
        driverProfile,
        driverId: driverId ?? null,
        driverName: driverName ?? undefined,
        trafficSource: trafficSource ?? undefined,
        routeLabel: routeLabel || undefined,
        saveTitle: savedName,
        gpsOrigin: formatGpsCoord(oLat, oLon) ?? undefined,
        origin_lat: oLat,
        origin_lon: oLon,
        gpsDestination: formatGpsCoord(dLat, dLon) ?? undefined,
        destination_lat: dLat,
        destination_lon: dLon,
        routingProfile: routingProfile ?? undefined,
        departAt: departAt ?? undefined,
        aY,
        physics: physics ?? undefined,
        maxSpeedKmh: maxSpeedKmh ?? null,
        vehicleId: vehicleId ?? null,
        preferredEngine: preferredEngine ?? undefined,
        envelopeMask: envelopeMask ?? undefined,
        slopeAlgo: slopeAlgo ?? undefined,
        legalFilter: legalFilter ?? undefined,
        includeTrafficLights,
        driverZonesEnabled,
        driverZones: driverZones?.length ? driverZones : undefined,
        waypoints: waypoints?.length ? waypoints : undefined,
        elevationA_m: elevationA_m ?? null,
        elevationB_m: elevationB_m ?? null,
        has_tls: (slimCorridor?.S_feux?.length ?? 0) > 0,
      };
      saveCycle({
        name: savedName,
        source: `CycleGen · ${driverProfile}`,
        sourceUrl: null,
        origin: "cyclegen",
        stats,
        time: profile.time,
        velocity: profile.velocity,
        acceleration: profile.acceleration,
        slope: profile.slope,
        a_lat,
        position: profile.position,
        geometry: corridor?.geometry ?? [],
        resultAvailable: true,
        z_min_m,
        z_max_m,
        corridor: slimCorridor,
        limits,
        meta,
      });
      onSaved?.(savedName);
      resetLocal();
      onLeave();
    } catch (e) {
      setSaving(false);
      setErr(e instanceof Error ? e.message : "Échec d’enregistrement");
    }
  };

  return (
    <div
      className="fixed inset-0 z-[1400] flex items-center justify-center bg-slate-900/40 p-3"
      role="dialog"
      aria-modal
      aria-label="Quitter le studio"
      onClick={handleCancel}
    >
      <div
        className="max-h-[min(88dvh,28rem)] w-full max-w-md overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {mode === "confirm" ? (
          <>
            <h3 className="text-sm font-semibold text-slate-900">
              Revenir au menu principal ?
            </h3>
            <p className="mt-2 text-[13px] leading-snug text-slate-600">
              Vous allez recommencer la création de profil. Le travail en cours
              sera effacé de la session Studio.
              {canSave
                ? " Enregistrez le cycle avant de quitter si vous souhaitez le conserver."
                : ""}
            </p>
            <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={handleCancel}
                className="rounded-md border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={handleLeave}
                className="rounded-md border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                Quitter sans enregistrer
              </button>
              {canSave && (
                <button
                  type="button"
                  onClick={() => {
                    setName(suggestedName);
                    setMode("save");
                  }}
                  className="rounded-md bg-brand px-3 py-2 text-xs font-semibold text-white hover:bg-brand-dark"
                >
                  Enregistrer puis quitter
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <h3 className="text-sm font-semibold text-slate-900">
              Enregistrer avant de quitter
            </h3>
            <p className="mt-1 text-[11px] text-slate-500">
              Le cycle sera ajouté à la bibliothèque, puis la session Studio
              sera réinitialisée.
            </p>
            <label className="mt-3 block space-y-1">
              <span className="text-[11px] font-medium text-slate-600">
                Nom de l’étude
              </span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={suggestedName}
                className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm"
              />
            </label>
            <p className="mt-1.5 text-[10px] tabular-nums text-slate-500">
              GPS départ{" "}
              <span className="font-semibold text-slate-800">
                {formatGpsCoord(
                  originLat ?? corridor?.geometry?.[0]?.lat,
                  originLon ?? corridor?.geometry?.[0]?.lon
                ) ?? "—"}
              </span>
              {" · "}
              GPS arrivée{" "}
              <span className="font-semibold text-slate-800">
                {formatGpsCoord(
                  destLat ??
                    (corridor?.geometry && corridor.geometry.length >= 2
                      ? corridor.geometry[corridor.geometry.length - 1].lat
                      : null),
                  destLon ??
                    (corridor?.geometry && corridor.geometry.length >= 2
                      ? corridor.geometry[corridor.geometry.length - 1].lon
                      : null)
                ) ?? "—"}
              </span>
            </p>
            {preview && (
              <p className="mt-2 text-[11px] tabular-nums text-slate-500">
                {(preview.distance_m / 1000).toFixed(1)} km ·{" "}
                {Math.round(preview.duration_s)} s · v̄{" "}
                {preview.v_mean_kmh.toFixed(0)} km/h
              </p>
            )}
            {err && (
              <p className="mt-2 text-[11px] font-medium text-red-600">{err}</p>
            )}
            <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                disabled={saving}
                onClick={() => setMode("confirm")}
                className="rounded-md border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              >
                Retour
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={handleSaveAndLeave}
                className="rounded-md bg-brand px-3 py-2 text-xs font-semibold text-white hover:bg-brand-dark disabled:opacity-40"
              >
                {saving ? "Enregistrement…" : "Enregistrer et quitter"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
