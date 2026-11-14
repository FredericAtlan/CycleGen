/** Traceability + structural sim params for chart inspect / export. */

import type { DriverPhysics } from "@/lib/driverPresets";
import type { EnvelopeMask } from "@/lib/corridorEdit";
import {
  gradeToPct,
  SLOPE_SMOOTH_PRESETS,
  type SlopeAlgoOptions,
} from "@/lib/slopeAlgo";
import type { VehicleCard } from "@/lib/vehicleLibrary";

export type InspectMetaEntry = {
  key: string;
  label: string;
  value: string;
  group: "trace" | "sim" | "vehicle" | "route" | "slope" | "driver";
};

export type InspectRunMeta = {
  entries: InspectMetaEntry[];
};

const ENVELOPE_LABELS: Record<keyof EnvelopeMask, string> = {
  legal: "légal (Mapbox)",
  traffic: "trafic",
  curve: "virage (confort)",
};

function formatEnvelopeSummary(mask: EnvelopeMask): string {
  const on = (Object.keys(ENVELOPE_LABELS) as (keyof EnvelopeMask)[])
    .filter((k) => mask[k])
    .map((k) => ENVELOPE_LABELS[k]);
  return on.length ? on.join(" + ") : "aucune (enveloppe inchangée)";
}

function formatSmoothPreset(id: SlopeAlgoOptions["smoothPreset"]): string {
  const p = SLOPE_SMOOTH_PRESETS.find((x) => x.id === id);
  if (!p) return id;
  return `${p.label} (Z±${Math.round(p.sgMinSpanM / 2)} m · w=${p.smoothWindow}, poly=${p.polyorder})`;
}

export function buildInspectRunMeta(args: {
  routeLabel?: string | null;
  saveTitle?: string | null;
  originLat?: number | null;
  originLon?: number | null;
  destLat?: number | null;
  destLon?: number | null;
  trafficSource?: string | null;
  engine?: string | null;
  driverProfile?: string | null;
  /** Library id / display name for named driver. */
  driverId?: string | null;
  driverName?: string | null;
  physics?: DriverPhysics | null;
  aY?: number | null;
  maxSpeedKmh?: number | null;
  vehicle?: VehicleCard | null;
  envelopeMask?: EnvelopeMask | null;
  /** Whether TLS events are applied in the cycle. */
  includeTrafficLights?: boolean;
  feuxCount?: number | null;
  slopeAlgo?: SlopeAlgoOptions | null;
  routingProfile?: string | null;
  departAt?: string | null;
  driverZonesEnabled?: boolean;
  driverZonesCount?: number;
  profileStatus?: string | null;
  distanceM?: number | null;
  durationS?: number | null;
  avgSpeedKmh?: number | null;
  generatedAt?: string | null;
}): InspectRunMeta {
  const entries: InspectMetaEntry[] = [];
  const push = (
    group: InspectMetaEntry["group"],
    key: string,
    label: string,
    value: string | number | null | undefined
  ) => {
    if (value == null || value === "") return;
    entries.push({ group, key, label, value: String(value) });
  };

  const fmtGps = (lat?: number | null, lon?: number | null) => {
    if (
      lat == null ||
      lon == null ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon)
    ) {
      return null;
    }
    return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  };
  const gpsA = fmtGps(args.originLat, args.originLon);
  const gpsB = fmtGps(args.destLat, args.destLon);

  const when = args.generatedAt ?? new Date().toISOString();
  push("trace", "origin", "Origine", "CycleGen");
  push("trace", "generated_at", "Généré le", when);
  push("trace", "status", "Statut profil", args.profileStatus);
  push("trace", "traffic_source", "Source trafic", args.trafficSource);
  push("trace", "titre", "Nom de l’étude", args.saveTitle);
  push("route", "route", "Trajet", args.routeLabel);
  push("route", "gps_depart", "GPS départ", gpsA);
  push("route", "gps_arrivee", "GPS arrivée", gpsB);
  if (args.originLat != null && Number.isFinite(args.originLat)) {
    push("route", "origin_lat", "Latitude départ", args.originLat.toFixed(6));
  }
  if (args.originLon != null && Number.isFinite(args.originLon)) {
    push("route", "origin_lon", "Longitude départ", args.originLon.toFixed(6));
  }
  if (args.destLat != null && Number.isFinite(args.destLat)) {
    push("route", "destination_lat", "Latitude arrivée", args.destLat.toFixed(6));
  }
  if (args.destLon != null && Number.isFinite(args.destLon)) {
    push(
      "route",
      "destination_lon",
      "Longitude arrivée",
      args.destLon.toFixed(6)
    );
  }
  push("route", "routing", "Profil routage", args.routingProfile);
  push("route", "depart_at", "Heure départ", args.departAt);
  if (args.distanceM != null && Number.isFinite(args.distanceM)) {
    push(
      "route",
      "distance_m",
      "Distance",
      args.distanceM >= 1000
        ? `${(args.distanceM / 1000).toFixed(3)} km`
        : `${Math.round(args.distanceM)} m`
    );
  }
  if (args.durationS != null && Number.isFinite(args.durationS)) {
    push("route", "duration_s", "Durée", `${args.durationS.toFixed(1)} s`);
  }
  if (args.avgSpeedKmh != null && Number.isFinite(args.avgSpeedKmh)) {
    push(
      "route",
      "v_mean",
      "v moyenne",
      `${args.avgSpeedKmh.toFixed(2)} km/h`
    );
  }

  push("sim", "engine", "Moteur", args.engine?.toUpperCase());
  push(
    "driver",
    "driver_name",
    "Conducteur (bibliothèque)",
    args.driverName ?? null
  );
  push("driver", "driver_id", "ID conducteur", args.driverId ?? null);
  push("driver", "driver", "Profil base (Markov)", args.driverProfile);
  if (args.physics) {
    push("driver", "a_max", "a_max", `${args.physics.a_max} m/s²`);
    push("driver", "b_comf", "b_comf", `${args.physics.b_comf} m/s²`);
    push(
      "driver",
      "speed_factor",
      "speed_factor",
      String(args.physics.speed_factor)
    );
    push("driver", "T", "T (headway)", `${args.physics.T} s`);
    push("driver", "T_h", "T_h (horizon)", `${args.physics.T_h} s`);
    push("driver", "s0", "s₀", `${args.physics.s0} m`);
    push("driver", "jerk_max", "Jerk+", `${args.physics.jerk_max} m/s³`);
    push(
      "driver",
      "jerk_brake_max",
      "Jerk−",
      `${args.physics.jerk_brake_max} m/s³`
    );
  }
  if (args.aY != null) {
    push(
      "sim",
      "a_y",
      "a_y (confort virage)",
      `${args.aY} m/s² — V_curve = √(a_y·R)`
    );
  }
  if (args.maxSpeedKmh != null) {
    push(
      "sim",
      "vmax",
      "Vmax véhicule",
      `${args.maxSpeedKmh} km/h (plafond après enveloppe)`
    );
  }

  if (args.envelopeMask) {
    push(
      "sim",
      "envelope",
      "Limites de roulage (enveloppe)",
      formatEnvelopeSummary(args.envelopeMask)
    );
    push(
      "sim",
      "limite_legal",
      "Limite légale",
      args.envelopeMask.legal ? "oui (prise en compte)" : "non (ignorée)"
    );
    push(
      "sim",
      "limite_trafic",
      "Limite trafic",
      args.envelopeMask.traffic ? "oui (prise en compte)" : "non (ignorée)"
    );
    push(
      "sim",
      "limite_virage",
      "Limite virage",
      args.envelopeMask.curve ? "oui (prise en compte)" : "non (ignorée)"
    );
  }

  if (args.includeTrafficLights != null) {
    push(
      "sim",
      "feux_actifs",
      "Feux de circulation",
      args.includeTrafficLights
        ? "oui — arrêt / phases TLS inclus dans le cycle"
        : "non — feux ignorés pour ce cycle"
    );
  }
  if (args.feuxCount != null) {
    push(
      "sim",
      "feux_count",
      "Nombre de feux sur le trajet",
      String(args.feuxCount)
    );
  }
  push(
    "sim",
    "zones",
    "Zones conducteur",
    args.driverZonesEnabled
      ? `oui (${args.driverZonesCount ?? 0})`
      : "non"
  );

  if (args.slopeAlgo) {
    const sa = args.slopeAlgo;
    push(
      "slope",
      "pente_lissage",
      "Calcul pente — lissage DEM",
      formatSmoothPreset(sa.smoothPreset)
    );
    push(
      "slope",
      "pente_max_grade",
      "Calcul pente — clamp |dz/ds| max",
      `${gradeToPct(sa.maxGrade)} % (réparation DEM au-delà)`
    );
    const trapL =
      sa.trapLengthM != null && Number.isFinite(sa.trapLengthM)
        ? sa.trapLengthM
        : null;
    push(
      "slope",
      "pente_trapezes",
      "Calcul pente — taille des trapèzes L",
      trapL != null ? `${trapL} m` : null
    );
    push(
      "slope",
      "pente_plancher",
      "Pente min imposée (plancher)",
      sa.alphaMinPct != null && Number.isFinite(sa.alphaMinPct)
        ? `${sa.alphaMinPct} % grade`
        : "aucune"
    );
    push(
      "slope",
      "pente_plafond",
      "Pente max imposée (plafond)",
      sa.alphaMaxPct != null && Number.isFinite(sa.alphaMaxPct)
        ? `${sa.alphaMaxPct} % grade`
        : "aucune"
    );
  }

  const v = args.vehicle;
  if (v) {
    push("vehicle", "veh_code", "Véhicule", `${v.code} · ${v.name}`);
    push("vehicle", "mass", "Masse", `${v.mass_kg} kg (${v.massCode})`);
    push("vehicle", "f0", "F0", `${v.f0_n} N`);
    push("vehicle", "f1", "F1", `${v.f1_n_per_kph} N/(km/h)`);
    push("vehicle", "f2", "F2", `${v.f2_n_per_kph2} N/(km/h)²`);
    push("vehicle", "r_dyn", "r_dyn", `${v.r_dyn_m} m`);
    if (v.tau_brake_max_nm != null) {
      push(
        "vehicle",
        "tau_brake_max",
        "τ_brake max",
        `${v.tau_brake_max_nm} N·m`
      );
    }
    if (v.power_kw != null) {
      push("vehicle", "p_nom", "P nominale", `${v.power_kw} kW`);
    }
    if (v.source) push("vehicle", "veh_src", "Source véhicule", v.source);
    if (v.milestone) push("vehicle", "milestone", "Milestone", v.milestone);
  }

  return { entries };
}

export function metaLinesForCsv(meta: InspectRunMeta | null | undefined): string[] {
  if (!meta?.entries.length) return [];
  return meta.entries.map((e) => `# ${e.key}=${e.value}`);
}
