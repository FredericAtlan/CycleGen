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
  type SavedCycle,
  type SavedCycleStudioMeta,
} from "@/lib/cycleLibrary";
import {
  computeCycleStats,
  lateralAccelFromCorridor,
  sampleLimitsAlongProfile,
} from "@/lib/cycleMetrics";

type SaveCycleButtonProps = {
  profile: ConsolidatedProfile | null;
  corridor?: SpatialCorridor | null;
  aY?: number;
  driverProfile?: string;
  /** Named library driver. */
  driverId?: string | null;
  driverName?: string | null;
  trafficSource?: string | null;
  routeLabel?: string;
  /** GPS départ / arrivée (prioritaires pour nom par défaut + meta). */
  originLat?: number | null;
  originLon?: number | null;
  destLat?: number | null;
  destLon?: number | null;
  disabled?: boolean;
  variant?: "fab" | "inline" | "toolbar";
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
  /** Nom affiché de l’étude (header / bibliothèque) — défaut de sauvegarde & export. */
  studyName?: string | null;
  /** Called with the final library name after a successful save. */
  onSaved?: (name: string) => void;
  /** Override library origin (default: cyclegen if geometry, else import). */
  libraryOrigin?: "cyclegen" | "corpus" | "import";
};

export default function SaveCycleButton({
  profile,
  corridor = null,
  aY = 3.5,
  driverProfile = "Normal",
  driverId = null,
  driverName = null,
  trafficSource = null,
  routeLabel = "",
  originLat = null,
  originLon = null,
  destLat = null,
  destLon = null,
  disabled = false,
  variant = "fab",
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
  studyName = null,
  onSaved,
  libraryOrigin,
}: SaveCycleButtonProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [status, setStatus] = useState<"idle" | "ok" | "err">("idle");
  const [msg, setMsg] = useState("");

  const canSave = !!profile && profile.time.length > 1 && !disabled;

  const previewStats = useMemo(() => {
    if (!profile) return null;
    const a_lat = lateralAccelFromCorridor(profile, corridor, aY);
    return computeCycleStats({
      time: profile.time,
      velocity: profile.velocity,
      acceleration: profile.acceleration,
      slope: profile.slope,
      position: profile.position,
      a_lat,
    });
  }, [profile, corridor, aY]);

  const gpsOrigin = useMemo(
    () =>
      formatGpsCoord(originLat, originLon) ??
      formatGpsCoord(
        corridor?.geometry?.[0]?.lat,
        corridor?.geometry?.[0]?.lon
      ),
    [originLat, originLon, corridor]
  );
  const gpsDestination = useMemo(() => {
    const g = corridor?.geometry;
    const last = g && g.length >= 2 ? g[g.length - 1] : null;
    return (
      formatGpsCoord(destLat, destLon) ??
      formatGpsCoord(last?.lat, last?.lon)
    );
  }, [destLat, destLon, corridor]);

  const suggestedName = useMemo(
    () =>
      resolveCycleSaveName({
        title: studyName?.trim() || "",
        originLat: originLat ?? corridor?.geometry?.[0]?.lat,
        originLon: originLon ?? corridor?.geometry?.[0]?.lon,
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

  const openDialog = () => {
    setName(suggestedName);
    setStatus("idle");
    setMsg("");
    setOpen(true);
  };

  const handleSave = () => {
    if (!profile) return;
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
        gpsOrigin: formatGpsCoord(oLat, oLon) ?? gpsOrigin ?? undefined,
        origin_lat: oLat,
        origin_lon: oLon,
        gpsDestination:
          formatGpsCoord(dLat, dLon) ?? gpsDestination ?? undefined,
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
      const saved: SavedCycle = saveCycle({
        name: savedName,
        source: `CycleGen · ${driverProfile}`,
        sourceUrl: null,
        origin:
          libraryOrigin ??
          ((corridor?.geometry?.length ?? 0) >= 2 ? "cyclegen" : "import"),
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
      setStatus("ok");
      setMsg(`Enregistré « ${saved.name} »`);
      onSaved?.(saved.name);
      window.setTimeout(() => setOpen(false), 700);
    } catch (e) {
      setStatus("err");
      setMsg(e instanceof Error ? e.message : "Échec d’enregistrement");
    }
  };

  const triggerClass =
    variant === "fab"
      ? "pointer-events-auto fixed bottom-4 right-4 z-[1200] inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white shadow-lg ring-1 ring-brand/30 transition hover:bg-brand-dark active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
      : variant === "toolbar"
        ? "inline-flex shrink-0 items-center justify-center gap-1 rounded-md bg-brand px-2.5 py-1 text-[10px] font-semibold text-white transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40"
        : "inline-flex w-full min-w-0 min-h-[40px] items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <>
      <button
        type="button"
        disabled={!canSave}
        onClick={openDialog}
        title="Enregistrer dans ma bibliothèque (navigateur)"
        className={triggerClass}
      >
        <svg
          width={variant === "toolbar" ? 12 : 16}
          height={variant === "toolbar" ? 12 : 16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden
          className="shrink-0"
        >
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
          <polyline points="17 21 17 13 7 13 7 21" />
          <polyline points="7 3 7 8 15 8" />
        </svg>
        {variant === "toolbar"
          ? "Enregistrer bibliothèque"
          : "Enregistrer dans ma bibliothèque"}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[1300] flex items-center justify-center bg-slate-900/40 p-3"
          role="dialog"
          aria-modal
          aria-label="Enregistrer le cycle"
          onClick={() => setOpen(false)}
        >
          <div
            className="flex max-h-[min(88dvh,34rem)] w-full max-w-md flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="shrink-0 border-b border-slate-100 px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-900">
                Enregistrer l’étude
              </h3>
              <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
                Le nom d’étude apparaît dans la bibliothèque et dans l’export
                (traçabilité). Modifiable.
              </p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              <label className="block space-y-1">
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
              <p className="mt-2 text-[10px] tabular-nums leading-snug text-slate-500">
                GPS départ{" "}
                <span className="font-semibold text-slate-800">
                  {gpsOrigin ?? "—"}
                </span>
                {" → "}
                GPS arrivée{" "}
                <span className="font-semibold text-slate-800">
                  {gpsDestination ?? "—"}
                </span>
              </p>
              {previewStats && (
                <dl className="mt-3 grid grid-cols-3 gap-x-2 gap-y-1 rounded-md bg-slate-50 px-2.5 py-2 text-[10px] text-slate-600">
                  <div>
                    Durée{" "}
                    <span className="font-semibold tabular-nums text-slate-900">
                      {previewStats.duration_s.toFixed(0)} s
                    </span>
                  </div>
                  <div>
                    Dist.{" "}
                    <span className="font-semibold tabular-nums text-slate-900">
                      {(previewStats.distance_m / 1000).toFixed(2)} km
                    </span>
                  </div>
                  <div>
                    v̄{" "}
                    <span className="font-semibold tabular-nums text-slate-900">
                      {previewStats.v_mean_kmh.toFixed(0)} km/h
                    </span>
                  </div>
                  <div>
                    Vmax{" "}
                    <span className="font-semibold tabular-nums text-slate-900">
                      {previewStats.v_max_kmh.toFixed(0)} km/h
                    </span>
                  </div>
                  {previewStats.slope_min_pct != null &&
                    previewStats.slope_max_pct != null && (
                      <div className="col-span-2">
                        Pente{" "}
                        <span className="font-semibold tabular-nums text-slate-900">
                          {previewStats.slope_min_pct.toFixed(1)}…
                          {previewStats.slope_max_pct.toFixed(1)} %
                        </span>
                      </div>
                    )}
                </dl>
              )}
              {msg && (
                <p
                  className={`mt-2 text-[11px] ${
                    status === "err" ? "text-red-600" : "text-emerald-700"
                  }`}
                >
                  {msg}
                </p>
              )}
            </div>
            <div className="flex shrink-0 justify-end gap-2 border-t border-slate-100 px-4 py-2.5">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={handleSave}
                className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-dark"
              >
                Enregistrer
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
