"use client";

import { useMemo, useState } from "react";
import type {
  CycleGenWarning,
  DriverProfile,
  RouterKey,
  RoutingProfile,
  SimEngine,
  SpatialCorridor,
} from "@/lib/types";
import { ROUTER_LABELS, ROUTER_TO_PROFILE } from "@/lib/types";
import type { DriverPhysics } from "@/lib/driverPresets";
import type { WaypointDraft } from "@/lib/types";
import type { EnvelopeMask } from "@/lib/corridorEdit";
import { withUpdatedFeux } from "@/lib/corridorEdit";
import type { SlopeAlgoOptions } from "@/lib/slopeAlgo";
import type { LegalFilterOptions } from "@/lib/legalFilter";
import SpeedEnvelopeTimeChart from "@/components/corridor/SpeedEnvelopeTimeChart";
import SimParamsPanel from "@/components/SimParamsPanel";
import DriverZonesEditor from "@/components/DriverZonesEditor";
import VehiclePanel from "@/components/VehiclePanel";
import WaypointsEditor, {
  type MapClickMode,
} from "@/components/WaypointsEditor";
import type { DriverZone } from "@/lib/driverZones";
import type { VehicleCard } from "@/lib/vehicleLibrary";
import { getVehicle } from "@/lib/vehicleLibrary";
import WarningsPanel, {
  trafficSourceBadgeClass,
  trafficSourceLabel,
} from "@/components/WarningsPanel";
import AccordionSection from "@/components/AccordionSection";
import TrafficLightsEditor from "@/components/corridor/TrafficLightsEditor";
import DownloadButtons from "@/components/export/DownloadButtons";
import SaveCycleButton from "@/components/SaveCycleButton";
import {
  DurationIcon,
  RouteEndpointPin,
  TimeEndpointPin,
  RouterIcon,
  RulerIcon,
} from "@/components/RouteEndpointPin";
import type { StudioWizardStep } from "@/components/StudioStepper";
import type { ConsolidatedProfile } from "@/lib/types";
import { computeCycleStats } from "@/lib/cycleMetrics";
import type { SlopeUnit } from "@/lib/units";
import BuildProgressGauge, {
  type BuildPhase,
} from "@/components/BuildProgressGauge";

type SidebarProps = {
  activeStep: StudioWizardStep;
  departureLabel: string;
  destinationLabel: string;
  onDepartureLabelChange: (value: string) => void;
  onDestinationLabelChange: (value: string) => void;
  pointASet: boolean;
  pointBSet: boolean;
  originLat?: number | null;
  originLon?: number | null;
  destLat?: number | null;
  destLon?: number | null;
  elevationA_m?: number | null;
  elevationB_m?: number | null;
  onGeocodeA: () => void;
  onGeocodeB: () => void;
  geocodingEndpoint: "A" | "B" | null;
  waypoints: WaypointDraft[];
  onWaypointsChange: (next: WaypointDraft[]) => void;
  clickMode: MapClickMode;
  onClickModeChange: (mode: MapClickMode) => void;
  onGeocodeWaypoint: (id: string) => void;
  geocodingWaypointId: string | null;
  routingProfile: RoutingProfile | string;
  onRoutingProfileChange: (value: string) => void;
  /** Multi-router selection (Trajet). If empty, fallback to routingProfile. */
  routingProfiles?: RoutingProfile[];
  onRoutingProfilesChange?: (next: RoutingProfile[]) => void;
  /** Availability hints for router checkboxes (env keys). */
  routerAvailability?: Partial<Record<RouterKey, boolean>>;
  /** Status per router after last analyze ('ok' | 'skipped:no_key' | 'error:...'). */
  routerStatus?: Partial<Record<RouterKey, string>>;
  departAt: string;
  onDepartAtChange: (value: string) => void;
  aY: number;
  onAYChange: (value: number) => void;
  trafficSource?: string | null;
  warnings?: CycleGenWarning[];
  driverProfile: DriverProfile;
  onDriverProfileChange: (value: DriverProfile) => void;
  physics: DriverPhysics;
  onPhysicsChange: (value: DriverPhysics) => void;
  /** Named driver from local library. */
  driverId?: string | null;
  onDriverIdChange?: (id: string | null) => void;
  maxSpeedKmh: number | null;
  onMaxSpeedKmhChange: (value: number | null) => void;
  envelopeMask?: EnvelopeMask;
  onEnvelopeMaskChange?: (mask: EnvelopeMask) => void;
  /** Map/chart sync from speed charts. */
  onCursorS?: (s_m: number | null) => void;
  onBrushRangeS?: (range: { s0: number; s1: number } | null) => void;
  /** Stochastic Markov residual noise in IDM (homologation: false). */
  enableMarkov?: boolean;
  onEnableMarkovChange?: (v: boolean) => void;
  /** One-click AVL-like homologation preset. */
  onApplyHomologationPreset?: () => void;
  /** Export active corridor+route as JSON (local-first). */
  onExportCorridorProfile?: () => void;
  /** Import corridor JSON file (no network). */
  onImportCorridorProfile?: (file: File) => void;
  corridorProfileBusy?: boolean;
  /** Include detected traffic lights in the cycle (default true). */
  includeTrafficLights?: boolean;
  onIncludeTrafficLightsChange?: (include: boolean) => void;
  slopeAlgo?: SlopeAlgoOptions;
  onSlopeAlgoChange?: (opts: SlopeAlgoOptions) => void;
  /** Filtrage spatial des vitesses légales (V_legal). */
  legalFilter?: LegalFilterOptions;
  onLegalFilterChange?: (opts: LegalFilterOptions) => void;
  /** Raw DEM along route (before / after corridor correction). */
  routeElevationsM?: number[] | null;
  analyzing: boolean;
  canAnalyze: boolean;
  generatingCycle?: boolean;
  distanceLabel: string;
  durationLabel: string;
  canBuildCorridor?: boolean;
  buildingCorridor?: boolean;
  paramsDisabled?: boolean;
  paramsDirty?: boolean;
  /** Before → after when paramsDirty. */
  paramsDirtyLines?: string[];
  driverZonesEnabled?: boolean;
  onDriverZonesEnabledChange?: (v: boolean) => void;
  driverZones?: DriverZone[];
  onDriverZonesChange?: (zones: DriverZone[]) => void;
  vehicleId?: string | null;
  onVehicleSelect?: (v: VehicleCard) => void;
  driverName?: string | null;
  corridor?: SpatialCorridor | null;
  onCorridorChange?: (c: SpatialCorridor) => void;
  slopeUnit?: SlopeUnit;
  onSlopeUnitChange?: (u: SlopeUnit) => void;
  profile?: ConsolidatedProfile | null;
  preferredEngine?: SimEngine;
  onPreferredEngineChange?: (e: SimEngine) => void;
  onCta: () => void;
  ctaDisabled?: boolean;
  onCycleSaved?: (name: string) => void;
  /** Nom d’étude (header) pour sauvegarde / export. */
  studyName?: string | null;
};

function WizardCta({
  label,
  busy,
  disabled,
  onClick,
  progressPhase = null,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  progressPhase?: BuildPhase | null;
}) {
  return (
    <div className="shrink-0 border-t border-slate-200 bg-white p-3">
      {busy && progressPhase ? (
        <BuildProgressGauge
          active
          phase={progressPhase}
          variant="inline"
          className="mb-2"
        />
      ) : null}
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || busy}
        className="flex w-full min-h-[48px] items-center justify-center gap-2 rounded-md bg-brand px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-dark active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy && (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
        )}
        {label}
      </button>
    </div>
  );
}

export default function Sidebar({
  activeStep,
  departureLabel,
  destinationLabel,
  onDepartureLabelChange,
  onDestinationLabelChange,
  pointASet,
  pointBSet,
  originLat = null,
  originLon = null,
  destLat = null,
  destLon = null,
  elevationA_m = null,
  elevationB_m = null,
  onGeocodeA,
  onGeocodeB,
  geocodingEndpoint,
  waypoints,
  onWaypointsChange,
  clickMode,
  onClickModeChange,
  onGeocodeWaypoint,
  geocodingWaypointId,
  routingProfile,
  onRoutingProfileChange,
  routingProfiles = [],
  onRoutingProfilesChange,
  routerAvailability,
  routerStatus,
  departAt,
  onDepartAtChange,
  aY,
  onAYChange,
  trafficSource = null,
  warnings = [],
  driverProfile,
  onDriverProfileChange,
  physics,
  onPhysicsChange,
  driverId = null,
  onDriverIdChange,
  driverName = null,
  maxSpeedKmh,
  onMaxSpeedKmhChange,
  envelopeMask,
  onEnvelopeMaskChange,
  onCursorS,
  onBrushRangeS,
  enableMarkov = false,
  onEnableMarkovChange,
  onApplyHomologationPreset,
  onExportCorridorProfile,
  onImportCorridorProfile,
  corridorProfileBusy = false,
  includeTrafficLights = true,
  onIncludeTrafficLightsChange,
  slopeAlgo,
  onSlopeAlgoChange,
  legalFilter,
  onLegalFilterChange,
  routeElevationsM = null,
  analyzing,
  canAnalyze,
  generatingCycle = false,
  distanceLabel,
  durationLabel,
  canBuildCorridor = false,
  buildingCorridor = false,
  paramsDisabled = false,
  paramsDirty = false,
  paramsDirtyLines = [],
  driverZonesEnabled = false,
  onDriverZonesEnabledChange,
  driverZones = [],
  onDriverZonesChange,
  vehicleId = null,
  onVehicleSelect,
  corridor = null,
  onCorridorChange,
  slopeUnit = "percent",
  onSlopeUnitChange,
  profile = null,
  preferredEngine = "idm",
  onPreferredEngineChange,
  onCta,
  ctaDisabled = false,
  onCycleSaved,
  studyName = null,
}: SidebarProps) {
  const trafficLabel = trafficSourceLabel(trafficSource);
  const [selectedFeu, setSelectedFeu] = useState<number | null>(null);

  const kpis = useMemo(() => {
    if (!profile || profile.time.length < 2) return null;
    return computeCycleStats({
      time: profile.time,
      velocity: profile.velocity,
      acceleration: profile.acceleration,
      slope: profile.slope,
      position: profile.position,
    });
  }, [profile]);

  const busy =
    analyzing || generatingCycle || buildingCorridor;
  const routeLabel = `${departureLabel} → ${destinationLabel}`;

  return (
    <aside
      data-testid="studio-sidebar"
      className="flex h-full w-80 shrink-0 flex-col border-r border-slate-200 bg-white"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
        {activeStep === 1 && (
          <div className="flex flex-col gap-3">
            <AccordionSection
              title="Trajet"
              summary={
                pointASet || pointBSet
                  ? `${pointASet ? "A✓" : "A…"} · ${pointBSet ? "B✓" : "B…"}`
                  : "Départ et arrivée"
              }
              defaultOpen
            >
              <div className="relative space-y-0">
                {/* Rail A → B → heure */}
                <div
                  className="pointer-events-none absolute bottom-10 left-[13px] top-8 w-px bg-slate-200"
                  aria-hidden
                />

                {/* Départ A */}
                <div className="relative flex gap-2.5 pb-3">
                  <div className="relative z-[1] pt-1">
                    <RouteEndpointPin tone="A" />
                  </div>
                  <label className="min-w-0 flex-1 space-y-1">
                    <span className="flex items-center justify-between text-xs font-medium text-slate-700">
                      Départ
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                          pointASet
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {pointASet ? "Localisé" : "Adresse / GPS"}
                      </span>
                    </span>
                    <div className="flex gap-1">
                      <input
                        type="text"
                        value={departureLabel}
                        onChange={(e) => onDepartureLabelChange(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            onGeocodeA();
                          }
                        }}
                        disabled={paramsDisabled}
                        className={`min-w-0 flex-1 rounded-md border bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none focus:ring-1 focus:ring-brand disabled:opacity-60 ${
                          pointASet
                            ? "border-l-[3px] border-l-emerald-500 border-y-slate-200 border-r-slate-200 focus:border-brand"
                            : "border-slate-200 focus:border-brand"
                        }`}
                        placeholder="Adresse ou GPS : 48.822, 1.617"
                      />
                      <button
                        type="button"
                        disabled={
                          paramsDisabled ||
                          !departureLabel.trim() ||
                          geocodingEndpoint === "A"
                        }
                        onClick={onGeocodeA}
                        className="shrink-0 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-semibold text-brand hover:bg-brand/5 disabled:opacity-50"
                      >
                        {geocodingEndpoint === "A" ? "…" : "Localiser"}
                      </button>
                    </div>
                    {pointASet && (
                      <p className="text-[11px] tabular-nums text-slate-500">
                        Altitude{" "}
                        <span className="font-semibold text-slate-700">
                          {elevationA_m != null && Number.isFinite(elevationA_m)
                            ? `${Math.round(elevationA_m)} m`
                            : "…"}
                        </span>
                      </p>
                    )}
                  </label>
                </div>

                {/* Arrivée B */}
                <div className="relative flex gap-2.5 pb-3 pt-1">
                  <div className="relative z-[1] pt-1">
                    <RouteEndpointPin tone="B" />
                  </div>
                  <label className="min-w-0 flex-1 space-y-1">
                    <span className="flex items-center justify-between text-xs font-medium text-slate-700">
                      Arrivée
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                          pointBSet
                            ? "bg-red-50 text-red-700"
                            : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {pointBSet ? "Localisé" : "Adresse / GPS"}
                      </span>
                    </span>
                    <div className="flex gap-1">
                      <input
                        type="text"
                        value={destinationLabel}
                        onChange={(e) => onDestinationLabelChange(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            onGeocodeB();
                          }
                        }}
                        disabled={paramsDisabled}
                        className={`min-w-0 flex-1 rounded-md border bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none focus:ring-1 focus:ring-brand disabled:opacity-60 ${
                          pointBSet
                            ? "border-l-[3px] border-l-red-500 border-y-slate-200 border-r-slate-200 focus:border-brand"
                            : "border-slate-200 focus:border-brand"
                        }`}
                        placeholder="Adresse ou GPS"
                      />
                      <button
                        type="button"
                        disabled={
                          paramsDisabled ||
                          !destinationLabel.trim() ||
                          geocodingEndpoint === "B"
                        }
                        onClick={onGeocodeB}
                        className="shrink-0 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-semibold text-brand hover:bg-brand/5 disabled:opacity-50"
                      >
                        {geocodingEndpoint === "B" ? "…" : "Localiser"}
                      </button>
                    </div>
                    {pointBSet && (
                      <p className="text-[11px] tabular-nums text-slate-500">
                        Altitude{" "}
                        <span className="font-semibold text-slate-700">
                          {elevationB_m != null && Number.isFinite(elevationB_m)
                            ? `${Math.round(elevationB_m)} m`
                            : "…"}
                        </span>
                      </p>
                    )}
                  </label>
                </div>

                {/* Heure — même rail / même format pin que A et B */}
                <div className="relative flex gap-2.5 pt-1">
                  <div className="relative z-[1] pt-1">
                    <TimeEndpointPin />
                  </div>
                  <label className="min-w-0 flex-1 space-y-1">
                    <span className="flex items-center justify-between text-xs font-medium text-slate-700">
                      Heure de départ
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                          departAt
                            ? "bg-amber-50 text-amber-800"
                            : "bg-amber-100 text-amber-700"
                        }`}
                      >
                        {departAt ? "OK" : "Requise"}
                      </span>
                    </span>
                    <input
                      type="datetime-local"
                      value={departAt}
                      onChange={(e) => onDepartAtChange(e.target.value)}
                      disabled={paramsDisabled}
                      required
                      className="w-full rounded-md border border-amber-200/80 bg-amber-50/40 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand disabled:opacity-60"
                    />
                    <span className="text-[10px] text-slate-400">
                      Mapbox Traffic — enveloppe de congestion.
                    </span>
                  </label>
                </div>
              </div>
            </AccordionSection>

            <AccordionSection
              title="Routeur"
              summary={`${
                routingProfile.includes("HERE")
                  ? "HERE"
                  : routingProfile.includes("Mapbox")
                    ? "Mapbox"
                    : "OSRM"
              } · ${departAt ? "heure OK" : "heure ?"}`}
              defaultOpen
            >
              <div className="space-y-3">
                {trafficLabel && (
                  <div
                    className={`rounded-md px-3 py-2 text-xs font-semibold ${trafficSourceBadgeClass(trafficSource)}`}
                    title={trafficSource ?? undefined}
                  >
                    Source vitesses : {trafficLabel}
                  </div>
                )}

                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700">
                      <RouterIcon className="h-3.5 w-3.5 text-slate-500" />
                      Routeurs (multi)
                    </span>
                    <span className="text-[10px] text-slate-400">
                      HERE + secours
                    </span>
                  </div>
                  <ul className="flex flex-col gap-1 rounded-md border border-slate-200 bg-slate-50/80 p-2">
                    {(["here", "mapbox", "osrm"] as RouterKey[]).map(
                      (key) => {
                        const profile = ROUTER_TO_PROFILE[key];
                        const rawStatus = routerStatus?.[key];
                        const configuredKnown =
                          routerAvailability?.[key] !== undefined;
                        const configured = configuredKnown
                          ? routerAvailability?.[key] === true
                          : true;
                        const checked = onRoutingProfilesChange
                          ? routingProfiles.includes(profile)
                          : routingProfile === profile;
                        const badge = rawStatus
                          ? rawStatus === "ok"
                            ? { label: "OK", cls: "bg-emerald-500/10 text-emerald-700" }
                            : rawStatus.startsWith("skipped")
                              ? { label: "clé absente", cls: "bg-amber-500/10 text-amber-700" }
                              : rawStatus.startsWith("error")
                                ? { label: "erreur", cls: "bg-rose-500/10 text-rose-700" }
                                : { label: rawStatus, cls: "bg-slate-400/10 text-slate-500" }
                          : configuredKnown && !configured
                            ? { label: "clé absente", cls: "bg-amber-500/10 text-amber-700" }
                            : null;
                        return (
                          <li
                            key={key}
                            className="flex items-center justify-between"
                          >
                            <label
                              className={`inline-flex items-center gap-2 text-[11px] font-medium text-slate-700 ${paramsDisabled || !configured ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
                            >
                              <input
                                type="checkbox"
                                className="h-3.5 w-3.5 accent-brand"
                                checked={checked}
                                disabled={paramsDisabled || !configured}
                                onChange={(e) => {
                                  if (onRoutingProfilesChange) {
                                    const next = new Set(routingProfiles);
                                    if (e.target.checked) next.add(profile);
                                    else next.delete(profile);
                                    onRoutingProfilesChange(Array.from(next));
                                  }
                                  // Backward compat: keep singular in sync w/ first checked.
                                  onRoutingProfileChange(profile);
                                }}
                              />
                              <span>{ROUTER_LABELS[key]}</span>
                            </label>
                            {badge && (
                              <span
                                title={rawStatus ?? undefined}
                                className={`ml-2 inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${badge.cls}`}
                              >
                                {badge.label}
                              </span>
                            )}
                          </li>
                        );
                      }
                    )}
                  </ul>
                  <p className="text-[10px] leading-snug text-slate-500">
                    Par défaut : HERE uniquement. Si HERE échoue → Mapbox →
                    OSRM. Cocher plusieurs routeurs active le multi-compare
                    (projection nearest-S) dans Contraintes.
                  </p>
                </div>

                {onApplyHomologationPreset && (
                  <button
                    type="button"
                    disabled={paramsDisabled}
                    onClick={onApplyHomologationPreset}
                    className="w-full rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-left text-xs font-semibold text-emerald-900 transition hover:bg-emerald-100 disabled:opacity-50"
                  >
                    Mode Homologation (AVL)
                    <span className="mt-0.5 block font-normal text-emerald-800/80">
                      HERE · limites ON · Vmax 130 · trafic OFF · Markov OFF
                    </span>
                  </button>
                )}

                {(distanceLabel !== "—" || durationLabel !== "—") && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2">
                      <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                        <RulerIcon className="h-3 w-3" />
                        Distance
                      </div>
                      <div className="mt-0.5 text-sm font-bold tabular-nums text-slate-900">
                        {distanceLabel}
                      </div>
                    </div>
                    <div className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2">
                      <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                        <DurationIcon className="h-3 w-3" />
                        Durée estimée
                      </div>
                      <div className="mt-0.5 text-sm font-bold tabular-nums text-slate-900">
                        {durationLabel}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </AccordionSection>

            {/* Mode de conduite migré : Vmax + Markov → Comportement (step 3),
                Respecter limites + V min/max → Contraintes (step 2). */}
            <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-snug text-slate-600">
              Vmax véhicule, virage (a_y) et Markov se règlent dans{" "}
              <span className="font-semibold">Comportement</span>. Le respect
              des limites, les sources de vitesse / pente et les V/α min-max
              se règlent dans <span className="font-semibold">Contraintes</span>.
            </p>

            {(onExportCorridorProfile || onImportCorridorProfile) && (
              <AccordionSection
                title="Profil routier (local)"
                summary="IndexedDB · import / export JSON"
                defaultOpen={false}
              >
                <div className="space-y-2">
                  <p className="text-[10px] leading-snug text-slate-500">
                    Stockage navigateur uniquement (pas de base backend). Même
                    trajet + options → recharge depuis le cache local.
                  </p>
                  {onExportCorridorProfile && (
                    <button
                      type="button"
                      disabled={paramsDisabled || corridorProfileBusy}
                      onClick={onExportCorridorProfile}
                      className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-800 transition hover:bg-slate-50 disabled:opacity-50"
                    >
                      Exporter le profil routier (.json)
                    </button>
                  )}
                  {onImportCorridorProfile && (
                    <label className="block w-full cursor-pointer rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-3 text-center text-xs font-semibold text-slate-700 transition hover:bg-slate-100">
                      Importer un profil (JSON)
                      <input
                        type="file"
                        accept=".json,application/json"
                        className="sr-only"
                        disabled={paramsDisabled || corridorProfileBusy}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = "";
                          if (f) onImportCorridorProfile(f);
                        }}
                      />
                    </label>
                  )}
                  {corridorProfileBusy ? (
                    <p className="text-[10px] text-slate-500">
                      Lecture / écriture du profil…
                    </p>
                  ) : null}
                </div>
              </AccordionSection>
            )}

            <AccordionSection
              title="Arrêts & clic carte"
              badge={waypoints.length}
              summary={
                waypoints.length
                  ? `${waypoints.length} arrêt${waypoints.length > 1 ? "s" : ""}`
                  : "Waypoints optionnels"
              }
              defaultOpen={waypoints.length > 0 || clickMode !== "navigate"}
            >
              <WaypointsEditor
                waypoints={waypoints}
                onChange={onWaypointsChange}
                clickMode={clickMode}
                onClickModeChange={onClickModeChange}
                onGeocodeWaypoint={onGeocodeWaypoint}
                geocodingId={geocodingWaypointId}
                disabled={paramsDisabled}
                embedded
              />
            </AccordionSection>
          </div>
        )}

        {activeStep === 2 && (
          <div className="flex flex-col gap-3">
            <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-snug text-slate-600">
              <span className="font-semibold text-slate-700">
                Infrastructure spatiale f(s)
              </span>{" "}
              — vitesse légale, pente, sources et filtres se configurent dans
              l’atelier à droite. Cette barre latérale garde le contrôle des
              feux et l’état des alertes.
            </p>

            <AccordionSection
              title="Feux tricolores"
              summary={
                includeTrafficLights
                  ? corridor?.S_feux?.length
                    ? `${corridor.S_feux.length} feu${corridor.S_feux.length > 1 ? "x" : ""}`
                    : "Avec feux"
                  : "Sans feux"
              }
              defaultOpen
            >
              <div className="space-y-2 p-1">
                <div className="flex rounded-md border border-slate-200 p-0.5">
                  {(
                    [
                      [true, "Avec feux"],
                      [false, "Sans feux"],
                    ] as const
                  ).map(([on, label]) => (
                    <button
                      key={label}
                      type="button"
                      disabled={paramsDisabled || !onIncludeTrafficLightsChange}
                      onClick={() => onIncludeTrafficLightsChange?.(on)}
                      className={`flex-1 rounded px-2 py-1.5 text-[11px] font-semibold transition ${
                        includeTrafficLights === on
                          ? "bg-slate-900 text-white"
                          : "text-slate-600 hover:bg-slate-50"
                      } disabled:cursor-not-allowed disabled:opacity-50`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] leading-snug text-slate-500">
                  {includeTrafficLights
                    ? "Les feux OSM projetés sur le tracé freinent le véhicule à la simulation."
                    : "Aucun feu dans le cycle — vitesse libre hors enveloppes et stops."}
                </p>
                {includeTrafficLights && corridor && onCorridorChange ? (
                  <TrafficLightsEditor
                    corridor={corridor}
                    selectedIndex={selectedFeu}
                    onSelect={setSelectedFeu}
                    onChangeFeux={(S_feux) =>
                      onCorridorChange(withUpdatedFeux(corridor, S_feux))
                    }
                    onChangeCorridor={onCorridorChange}
                    onInspect={() => undefined}
                    defaultOpen
                    bare
                  />
                ) : includeTrafficLights ? (
                  <p className="rounded-md border border-dashed border-slate-200 px-3 py-2 text-[11px] text-slate-500">
                    Les feux apparaissent après construction du cycle.
                  </p>
                ) : null}
              </div>
            </AccordionSection>

            {warnings.length > 0 && (
              <WarningsPanel
                warnings={warnings}
                title="Imputations et alertes"
                collapsible
                defaultOpen={warnings.length <= 6}
              />
            )}
            {buildingCorridor ? (
              <BuildProgressGauge active phase="corridor" variant="panel" />
            ) : null}
            {corridorErrorHint(buildingCorridor, canBuildCorridor)}
          </div>
        )}

        {activeStep === 3 && (
          <div className="flex flex-col gap-3">
            <AccordionSection
              title="Vmax · Virage · Bruit"
              summary={`Vmax ${maxSpeedKmh ?? "—"} · a_y ${aY.toFixed(1)} · Markov ${enableMarkov ? "ON" : "OFF"}`}
              defaultOpen
            >
              <div className="space-y-3">
                <label className="block space-y-1">
                  <span className="flex items-center justify-between text-xs font-medium text-slate-700">
                    <span>Vitesse Max Véhicule (km/h)</span>
                    <span className="text-[10px] font-normal text-slate-500">
                      remask client
                    </span>
                  </span>
                  <input
                    type="number"
                    min={30}
                    max={300}
                    step={5}
                    value={maxSpeedKmh ?? 130}
                    disabled={paramsDisabled}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      onMaxSpeedKmhChange(
                        Number.isFinite(v) ? Math.max(30, v) : 130
                      );
                    }}
                    className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand disabled:opacity-60"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="flex items-center justify-between text-xs font-medium text-slate-700">
                    <span>Latéral en virage a_y (m/s²)</span>
                    <span className="text-[10px] font-normal text-slate-500">
                      V_curve ∝ √a_y
                    </span>
                  </span>
                  <input
                    type="range"
                    min={1.5}
                    max={6.0}
                    step={0.1}
                    value={aY}
                    disabled={paramsDisabled}
                    onChange={(e) => onAYChange(Number(e.target.value))}
                    className="w-full accent-brand"
                  />
                  <p className="text-right text-[10px] text-slate-500 tabular-nums">
                    a_y = {aY.toFixed(1)} m/s²
                  </p>
                </label>
                <label className="flex items-center justify-between gap-3 text-xs font-medium text-slate-700">
                  <span>Bruit stochastique Markov (IDM)</span>
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-brand"
                    checked={enableMarkov}
                    disabled={paramsDisabled || !onEnableMarkovChange}
                    onChange={(e) => onEnableMarkovChange?.(e.target.checked)}
                  />
                </label>
                <p className="text-[10px] leading-snug text-slate-500">
                  Homologation (AVL) = Markov OFF, virage max = 3.5 m/s².
                </p>
              </div>
            </AccordionSection>

            {corridor && corridor.S.length > 1 && (
              <AccordionSection
                title="Aperçu de la Cinématique V(t)"
                summary={`min(V_env · ${(physics.speed_factor ?? 1).toFixed(2)}, Vmax ${maxSpeedKmh ?? "—"})`}
                defaultOpen
              >
                <div className="space-y-2 p-1">
                  <p className="text-[11px] leading-snug text-slate-500">
                    Domaine temporel f(t) — enveloppe désirée du conducteur.
                    Bouger Vmax, a_y ou le profil conducteur remasque le
                    corridor côté client (aucun rebuild).
                  </p>
                  <SpeedEnvelopeTimeChart
                    corridor={corridor}
                    envelopeMask={envelopeMask}
                    speedFactor={physics.speed_factor}
                    maxSpeedKmh={maxSpeedKmh}
                  />
                </div>
              </AccordionSection>
            )}

            <AccordionSection
              title="Moteur"
              summary={preferredEngine === "sumo" ? "SUMO" : "IDM (défaut)"}
              defaultOpen
            >
              <div className="flex rounded-md border border-slate-200 p-0.5">
                {(
                  [
                    ["idm", "IDM (défaut)"],
                    ["sumo", "SUMO"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    disabled={paramsDisabled}
                    onClick={() => onPreferredEngineChange?.(id)}
                    className={`flex-1 rounded px-2 py-1.5 text-[11px] font-semibold transition ${
                      preferredEngine === id
                        ? "bg-slate-900 text-white"
                        : "text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </AccordionSection>

            <AccordionSection
              title="Conducteur"
              summary={`${driverName ?? driverProfile}${paramsDirty ? " · à appliquer" : ""}`}
              defaultOpen
            >
              <SimParamsPanel
                driverProfile={driverProfile}
                onDriverProfileChange={onDriverProfileChange}
                physics={physics}
                onPhysicsChange={onPhysicsChange}
                driverId={driverId}
                onDriverIdChange={onDriverIdChange}
                maxSpeedKmh={maxSpeedKmh}
                onMaxSpeedKmhChange={onMaxSpeedKmhChange}
                aY={aY}
                onAYChange={onAYChange}
                disabled={paramsDisabled}
                pendingApplyHint={paramsDirty}
                pendingDiffLines={paramsDirtyLines}
                embedded
              />
            </AccordionSection>

            {onDriverZonesChange && onDriverZonesEnabledChange && (
              <AccordionSection
                title="Zones conducteur"
                badge={driverZonesEnabled ? driverZones.length : undefined}
                summary={
                  driverZonesEnabled
                    ? driverZones.length
                      ? `${driverZones.length} zone${driverZones.length > 1 ? "s" : ""}`
                      : "Activées · aucune zone"
                    : "Désactivées"
                }
                defaultOpen={driverZonesEnabled}
              >
                <DriverZonesEditor
                  enabled={driverZonesEnabled}
                  onEnabledChange={onDriverZonesEnabledChange}
                  zones={driverZones}
                  onZonesChange={onDriverZonesChange}
                  disabled={paramsDisabled}
                  embedded
                />
              </AccordionSection>
            )}

            {onVehicleSelect && (
              <AccordionSection
                title="Véhicule"
                summary={
                  vehicleId
                    ? `${getVehicle(vehicleId)?.code ?? vehicleId} · P / couple en Résultats`
                    : "Masse, F0/F1/F2, r_dyn → P / couple"
                }
                defaultOpen
              >
                <VehiclePanel
                  selectedId={vehicleId}
                  onSelect={onVehicleSelect}
                  disabled={paramsDisabled}
                  embedded
                />
                <p className="mt-2 text-[10px] leading-snug text-slate-500">
                  Le véhicule choisi ici sert au solveur (Vmax) et aux courbes
                  puissance / couple aux roues à l’étape Résultats.
                </p>
              </AccordionSection>
            )}
          </div>
        )}

        {activeStep === 4 && (
          <div className="flex flex-col gap-3">
            <AccordionSection
              title="Indicateurs"
              summary={
                kpis
                  ? `${formatKpiDuration(kpis.duration_s)} · ${
                      kpis.distance_m >= 1000
                        ? `${(kpis.distance_m / 1000).toFixed(1)} km`
                        : `${Math.round(kpis.distance_m)} m`
                    }`
                  : "Après génération"
              }
              defaultOpen
            >
              {kpis ? (
                <div className="grid grid-cols-2 gap-2">
                  <Kpi
                    label="Durée"
                    value={formatKpiDuration(kpis.duration_s)}
                  />
                  <Kpi
                    label="Distance"
                    value={
                      kpis.distance_m >= 1000
                        ? `${(kpis.distance_m / 1000).toFixed(2)} km`
                        : `${Math.round(kpis.distance_m)} m`
                    }
                  />
                  <Kpi
                    label="v moyenne"
                    value={`${kpis.v_mean_kmh.toFixed(1)} km/h`}
                  />
                  <Kpi
                    label="v max"
                    value={`${kpis.v_max_kmh.toFixed(1)} km/h`}
                  />
                  {kpis.slope_min_pct != null && (
                    <Kpi
                      label="Pente min"
                      value={`${kpis.slope_min_pct.toFixed(1)} %`}
                    />
                  )}
                  {kpis.slope_max_pct != null && (
                    <Kpi
                      label="Pente max"
                      value={`${kpis.slope_max_pct.toFixed(1)} %`}
                    />
                  )}
                </div>
              ) : (
                <p className="text-[11px] text-slate-500">
                  Aucun profil — générez le cycle à l’étape 3.
                </p>
              )}
            </AccordionSection>

            {profile && profile.time.length > 1 && (
              <AccordionSection
                title="Export & sauvegarde"
                summary="Excel, CSV enrichi, bibliothèque"
                defaultOpen
              >
                <div className="flex min-w-0 flex-col gap-2 overflow-hidden">
                  <DownloadButtons
                    variant="stack"
                    profile={profile}
                    corridor={corridor}
                    vehicle={vehicleId ? getVehicle(vehicleId) : null}
                    aY={aY}
                    routeLabel={routeLabel}
                    saveTitle={studyName?.trim() || null}
                    trafficSource={trafficSource}
                    driverProfile={driverProfile}
                    physics={physics}
                    engine={preferredEngine}
                    maxSpeedKmh={maxSpeedKmh}
                    envelopeMask={envelopeMask}
                    routingProfile={
                      typeof routingProfile === "string"
                        ? routingProfile
                        : undefined
                    }
                    departAt={departAt}
                    driverZonesEnabled={driverZonesEnabled}
                    driverZonesCount={driverZones.length}
                    includeTrafficLights={includeTrafficLights}
                    slopeAlgo={slopeAlgo}
                    originLat={originLat}
                    originLon={originLon}
                    destLat={destLat}
                    destLon={destLon}
                    elevationA_m={elevationA_m}
                    elevationB_m={elevationB_m}
                  />
                  <SaveCycleButton
                    variant="inline"
                    profile={profile}
                    corridor={corridor}
                    aY={aY}
                    driverProfile={driverProfile}
                    driverId={driverId}
                    driverName={driverName}
                    trafficSource={trafficSource}
                    routeLabel={routeLabel}
                    studyName={studyName?.trim() || null}
                    originLat={originLat}
                    originLon={originLon}
                    destLat={destLat}
                    destLon={destLon}
                    physics={physics}
                    routingProfile={
                      typeof routingProfile === "string"
                        ? routingProfile
                        : undefined
                    }
                    departAt={departAt}
                    maxSpeedKmh={maxSpeedKmh}
                    vehicleId={vehicleId}
                    preferredEngine={preferredEngine}
                    envelopeMask={envelopeMask}
                    slopeAlgo={slopeAlgo}
                    legalFilter={legalFilter}
                    includeTrafficLights={includeTrafficLights}
                    driverZonesEnabled={driverZonesEnabled}
                    driverZones={driverZones}
                    waypoints={waypoints}
                    elevationA_m={elevationA_m}
                    elevationB_m={elevationB_m}
                    onSaved={onCycleSaved}
                  />
                </div>
              </AccordionSection>
            )}
          </div>
        )}
      </div>

      {activeStep === 1 && (
        <WizardCta
          label={analyzing ? "Calcul de l’itinéraire…" : "Calculer l’itinéraire"}
          busy={analyzing}
          disabled={!canAnalyze || ctaDisabled}
          onClick={onCta}
          progressPhase={analyzing ? "analyzing" : null}
        />
      )}
      {activeStep === 2 && (
        <WizardCta
          label={
            buildingCorridor
              ? "Construction du cycle…"
              : "Construire le cycle"
          }
          busy={buildingCorridor}
          disabled={!canBuildCorridor || ctaDisabled}
          onClick={onCta}
          progressPhase={buildingCorridor ? "corridor" : null}
        />
      )}
      {activeStep === 3 && (
        <WizardCta
          label={
            generatingCycle || busy
              ? "Génération du cycle…"
              : paramsDirty
                ? "Appliquer et générer"
                : "Générer le cycle"
          }
          busy={generatingCycle || analyzing || buildingCorridor}
          disabled={!canAnalyze || ctaDisabled}
          onClick={onCta}
          progressPhase={
            generatingCycle
              ? "generating"
              : buildingCorridor
                ? "corridor"
                : analyzing
                  ? "analyzing"
                  : null
          }
        />
      )}
      {activeStep === 4 && (
        <WizardCta
          label="Analyser dans Versus"
          busy={false}
          disabled={!profile || profile.time.length < 2}
          onClick={onCta}
        />
      )}
    </aside>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-2 py-2">
      <div className="text-[10px] font-medium uppercase text-slate-500">
        {label}
      </div>
      <div className="text-sm font-semibold tabular-nums text-slate-900">
        {value}
      </div>
    </div>
  );
}

function formatKpiDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h} h ${m % 60} min`;
  }
  return `${m} min ${s} s`;
}

function corridorErrorHint(building: boolean, canBuild: boolean) {
  if (building) return null;
  if (!canBuild) {
    return (
      <p className="text-[11px] text-slate-500">
        Calculez d’abord l’itinéraire (étape 1).
      </p>
    );
  }
  return (
    <p className="text-[11px] text-slate-400">
      Le bouton reconstruit pente, feux et enveloppes si vous avez modifié les
      masques.
    </p>
  );
}
