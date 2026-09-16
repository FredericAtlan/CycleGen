/** Full-resolution cycle rows for CSV / Excel export (no chart downsampling). */

import type { ConsolidatedProfile, LatLon, SpatialCorridor } from "@/lib/types";
import { DEFAULT_A_Y, type DriverPhysics } from "@/lib/driverPresets";
import {
  sampleCurvatureAlongProfile,
  sampleLimitsAlongProfile,
} from "@/lib/cycleMetrics";
import type { VehicleCard } from "@/lib/vehicleLibrary";
import {
  lateralAccelApprox,
  mechanicalPowerSample,
} from "@/lib/vehiclePower";
import { slopeFromRad } from "@/lib/units";

function finiteOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function sampleVcurve(
  corridor: SpatialCorridor | null,
  s: number
): number | null {
  const S = corridor?.S;
  const Vc = corridor?.V_curve;
  if (!S?.length || !Vc?.length) return null;
  if (s <= S[0]) return Vc[0];
  if (s >= S[S.length - 1]) return Vc[Vc.length - 1];
  let lo = 0;
  let hi = S.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (S[mid] <= s) lo = mid;
    else hi = mid;
  }
  const ds = S[hi] - S[lo];
  if (ds < 1e-9) return Vc[lo];
  const u = (s - S[lo]) / ds;
  return Vc[lo] + u * (Vc[hi] - Vc[lo]);
}

/** Nearest corridor / polyline point for a curvilinear abscissa (m). */
function latLonAtS(
  S: number[] | null | undefined,
  geometry: LatLon[] | null | undefined,
  s_m: number
): { lat: number; lon: number } | null {
  if (!S?.length || !geometry?.length) return null;
  const n = Math.min(S.length, geometry.length);
  if (n === 0) return null;
  if (s_m <= S[0]) return geometry[0] ?? null;
  if (s_m >= S[n - 1]) return geometry[n - 1] ?? null;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (S[mid] <= s_m) lo = mid;
    else hi = mid;
  }
  const dLo = Math.abs(S[lo] - s_m);
  const dHi = Math.abs(S[hi] - s_m);
  return geometry[dLo <= dHi ? lo : hi] ?? null;
}

export type ExportCycleRow = {
  /** Primary */
  time_s: number;
  position_m: number;
  /** GPS along corridor (WGS84). */
  lat_deg: number | null;
  lon_deg: number | null;
  v_kmh: number;
  /** Posted / OSM legal limit along S (km/h). */
  v_legal_kmh: number | null;
  /** Traffic free-flow / Mapbox flow limit along S (km/h). */
  v_traffic_kmh: number | null;
  /** Curve comfort limit √(a_y·R) along S (km/h); null if non-binding. */
  v_curve_kmh: number | null;
  /** Combined envelope min(legal, traffic, curve) along S (km/h). */
  v_envelope_kmh: number | null;
  /** Driver longitudinal accel ceiling a_max (m/s²). */
  a_lon_max_mps2: number | null;
  /** Driver comfort brake floor −b_comf (m/s²). */
  a_lon_min_mps2: number | null;
  /** Lateral comfort ceiling a_y (m/s²). */
  a_lat_max_mps2: number | null;
  /** Radius of curvature R(s) from corridor geometry (m). */
  R_m: number | null;
  /** Signed curvature κ = ±1/R (1/m); + = left turn in local ENU. */
  kappa_1_per_m: number | null;
  slope_pct: number;
  /** Secondary / analysis */
  v_mps: number;
  a_lon_mps2: number;
  jerk_lon_mps3: number;
  a_lat_mps2: number;
  f_road_n: number | null;
  f_grade_n: number | null;
  f_inertia_n: number | null;
  f_trac_n: number | null;
  p_wheel_kw: number | null;
  p_trac_kw: number | null;
  p_regen_kw: number | null;
  wheel_torque_nm: number | null;
  wheel_rpm: number | null;
  wheel_omega_rad_s: number | null;
};

export function buildExportCycleRows(args: {
  profile: ConsolidatedProfile;
  corridor?: SpatialCorridor | null;
  vehicle?: VehicleCard | null;
  aY?: number;
  physics?: DriverPhysics | null;
  /** Optional GPS polyline if corridor.geometry is missing. */
  geometry?: LatLon[] | null;
}): ExportCycleRow[] {
  const {
    profile,
    corridor = null,
    vehicle = null,
    aY = DEFAULT_A_Y,
    physics = null,
    geometry = null,
  } = args;
  const n = Math.min(
    profile.time.length,
    profile.velocity.length,
    profile.position.length
  );
  const limits = sampleLimitsAlongProfile(profile, corridor);
  const curvature = sampleCurvatureAlongProfile(profile, corridor);
  const S = corridor?.S ?? null;
  const geo = corridor?.geometry?.length
    ? corridor.geometry
    : geometry?.length
      ? geometry
      : null;
  const aLonMax =
    physics && Number.isFinite(physics.a_max) ? physics.a_max : null;
  const aLonMin =
    physics && Number.isFinite(physics.b_comf) ? -physics.b_comf : null;
  const aLatMax = Number.isFinite(aY) ? aY : null;
  const rows: ExportCycleRow[] = [];

  for (let i = 0; i < n; i++) {
    const t = profile.time[i];
    const s = profile.position[i] ?? 0;
    const v = profile.velocity[i] ?? 0;
    const a =
      profile.acceleration?.[i] ??
      (i > 0
        ? (v - (profile.velocity[i - 1] ?? 0)) /
          Math.max(1e-3, t - profile.time[i - 1])
        : 0);
    const alpha = profile.slope?.[i] ?? 0;
    const vc = sampleVcurve(corridor, s);
    const a_lat = lateralAccelApprox(v, vc, aY);
    const gps = latLonAtS(S, geo, s);
    const pow = vehicle
      ? mechanicalPowerSample({
          v_mps: v,
          a_lon_mps2: a,
          alpha_rad: alpha,
          vehicle,
        })
      : null;
    const rDyn =
      vehicle && vehicle.r_dyn_m > 0.05 ? vehicle.r_dyn_m : null;
    const omega = rDyn != null ? Math.max(0, v) / rDyn : null;

    rows.push({
      time_s: t,
      position_m: s,
      lat_deg: gps?.lat ?? null,
      lon_deg: gps?.lon ?? null,
      v_kmh: v * 3.6,
      v_legal_kmh: finiteOrNull(limits?.legal_kmh[i]),
      v_traffic_kmh: finiteOrNull(limits?.traffic_kmh[i]),
      v_curve_kmh: finiteOrNull(limits?.curve_kmh[i]),
      v_envelope_kmh: finiteOrNull(limits?.envelope_kmh[i]),
      a_lon_max_mps2: aLonMax,
      a_lon_min_mps2: aLonMin,
      a_lat_max_mps2: aLatMax,
      R_m: finiteOrNull(curvature?.R_m[i]),
      kappa_1_per_m: finiteOrNull(curvature?.kappa_1_per_m[i]),
      slope_pct: slopeFromRad(alpha, "percent"),
      v_mps: v,
      a_lon_mps2: a,
      jerk_lon_mps3: 0, // filled in 2nd pass
      a_lat_mps2: a_lat,
      f_road_n: pow?.f_road_n ?? null,
      f_grade_n: pow?.f_grade_n ?? null,
      f_inertia_n: pow?.f_inertia_n ?? null,
      f_trac_n: pow?.f_trac_n ?? null,
      p_wheel_kw: pow != null ? pow.p_mech_w / 1000 : null,
      p_trac_kw: pow?.p_trac_kw ?? null,
      p_regen_kw: pow?.p_regen_kw ?? null,
      wheel_torque_nm: pow?.wheel_torque_nm ?? null,
      wheel_rpm:
        pow?.wheel_rpm ??
        (omega != null ? (omega * 60) / (2 * Math.PI) : null),
      wheel_omega_rad_s: omega,
    });
  }

  for (let i = 0; i < rows.length; i++) {
    if (i === 0) {
      rows[i].jerk_lon_mps3 = 0;
      continue;
    }
    const dt = Math.max(1e-3, rows[i].time_s - rows[i - 1].time_s);
    rows[i].jerk_lon_mps3 =
      (rows[i].a_lon_mps2 - rows[i - 1].a_lon_mps2) / dt;
  }

  return rows;
}

/** Column order: GPS + limites vitesse/accélération en tête, puis analyse. */
export const EXPORT_COLUMN_KEYS: (keyof ExportCycleRow)[] = [
  "time_s",
  "position_m",
  "lat_deg",
  "lon_deg",
  "v_kmh",
  "v_legal_kmh",
  "v_traffic_kmh",
  "v_curve_kmh",
  "v_envelope_kmh",
  "a_lon_mps2",
  "a_lon_max_mps2",
  "a_lon_min_mps2",
  "a_lat_mps2",
  "a_lat_max_mps2",
  "jerk_lon_mps3",
  "slope_pct",
  "R_m",
  "kappa_1_per_m",
  "v_mps",
  "f_road_n",
  "f_grade_n",
  "f_inertia_n",
  "f_trac_n",
  "p_wheel_kw",
  "p_trac_kw",
  "p_regen_kw",
  "wheel_torque_nm",
  "wheel_rpm",
  "wheel_omega_rad_s",
];

export const EXPORT_COLUMN_LABELS: Record<keyof ExportCycleRow, string> = {
  time_s: "time_s",
  position_m: "position_m",
  lat_deg: "lat_deg",
  lon_deg: "lon_deg",
  v_kmh: "v_kmh",
  v_legal_kmh: "v_legal_kmh",
  v_traffic_kmh: "v_traffic_kmh",
  v_curve_kmh: "v_curve_kmh",
  v_envelope_kmh: "v_envelope_kmh",
  a_lon_mps2: "a_lon_mps2",
  a_lon_max_mps2: "a_lon_max_mps2",
  a_lon_min_mps2: "a_lon_min_mps2",
  a_lat_mps2: "a_lat_mps2",
  a_lat_max_mps2: "a_lat_max_mps2",
  jerk_lon_mps3: "jerk_lon_mps3",
  slope_pct: "slope_pct",
  R_m: "R_m",
  kappa_1_per_m: "kappa_1_per_m",
  v_mps: "v_mps",
  f_road_n: "f_road_n",
  f_grade_n: "f_grade_n",
  f_inertia_n: "f_inertia_n",
  f_trac_n: "f_trac_n",
  p_wheel_kw: "p_wheel_kw",
  p_trac_kw: "p_trac_kw",
  p_regen_kw: "p_regen_kw",
  wheel_torque_nm: "wheel_torque_nm",
  wheel_rpm: "wheel_rpm",
  wheel_omega_rad_s: "wheel_omega_rad_s",
};

/** Human description + unit for each export column. */
export const EXPORT_COLUMN_META: Record<
  keyof ExportCycleRow,
  { description: string; unit: string }
> = {
  time_s: {
    description: "Base de temps du cycle",
    unit: "s",
  },
  position_m: {
    description: "Abscisse curviligne le long du trajet",
    unit: "m",
  },
  lat_deg: {
    description: "Latitude WGS84 le long du corridor (géométrie projetée sur S)",
    unit: "°",
  },
  lon_deg: {
    description: "Longitude WGS84 le long du corridor (géométrie projetée sur S)",
    unit: "°",
  },
  v_kmh: {
    description: "Vitesse véhicule (prioritaire)",
    unit: "km/h",
  },
  v_legal_kmh: {
    description: "Limite légale / OSM maxspeed le long de S",
    unit: "km/h",
  },
  v_traffic_kmh: {
    description: "Limite trafic (Mapbox flow / free-flow) le long de S",
    unit: "km/h",
  },
  v_curve_kmh: {
    description: "Limite virage √(a_y·R) ; vide si non contraignant (>160 km/h)",
    unit: "km/h",
  },
  v_envelope_kmh: {
    description: "Enveloppe min(légal, trafic, courbe) utilisée par le solveur",
    unit: "km/h",
  },
  a_lon_mps2: {
    description: "Accélération longitudinale réalisée",
    unit: "m/s²",
  },
  a_lon_max_mps2: {
    description: "Limite accélération longitudinale conducteur (a_max)",
    unit: "m/s²",
  },
  a_lon_min_mps2: {
    description: "Limite freinage confort conducteur (−b_comf)",
    unit: "m/s²",
  },
  a_lat_mps2: {
    description: "Accélération latérale approx. v²·a_y / V_curve²",
    unit: "m/s²",
  },
  a_lat_max_mps2: {
    description: "Limite accélération latérale confort (a_y)",
    unit: "m/s²",
  },
  jerk_lon_mps3: {
    description: "Jerk longitudinal (da/dt)",
    unit: "m/s³",
  },
  slope_pct: {
    description: "Pente grade = 100·tan(α) (prioritaire)",
    unit: "%",
  },
  R_m: {
    description:
      "Rayon de courbure géométrique R(s) (corde ~25 m + médiane spatiale 150 m)",
    unit: "m",
  },
  kappa_1_per_m: {
    description: "Courbure signée κ = ±1/R (+ = virage à gauche en ENU local)",
    unit: "1/m",
  },
  v_mps: {
    description: "Vitesse véhicule",
    unit: "m/s",
  },
  f_road_n: {
    description: "Road load F0+F1·v+F2·v²",
    unit: "N",
  },
  f_grade_n: {
    description: "Force de pente m·g·sin(α)",
    unit: "N",
  },
  f_inertia_n: {
    description: "Force d’inertie m·a_lon",
    unit: "N",
  },
  f_trac_n: {
    description: "Force longitudinale aux roues",
    unit: "N",
  },
  p_wheel_kw: {
    description: "Puissance mécanique signée aux roues",
    unit: "kW",
  },
  p_trac_kw: {
    description:
      "Partie traction max(P,0) aux roues ; 0 hors effort moteur — moyenne diluée par les zéros",
    unit: "kW",
  },
  p_regen_kw: {
    description:
      "Demande de freinage aux roues |P| si P<0 (méca + éventuelle regen machine, non séparés) ; 0 hors freinage — moyenne diluée par les zéros",
    unit: "kW",
  },
  wheel_torque_nm: {
    description:
      "Couple à la roue τ = F_trac · r_dyn (si v≈0 et τ_brake_max défini → −τ_brake_max)",
    unit: "N·m",
  },
  wheel_rpm: {
    description: "Vitesse de rotation roue",
    unit: "tr/min",
  },
  wheel_omega_rad_s: {
    description: "Vitesse angulaire roue",
    unit: "rad/s",
  },
};

export type ColumnSeriesStats = {
  min: number;
  max: number;
  /** Arithmetic mean over all finite samples (zeros included). */
  mean: number;
  count: number;
  /** Mean over samples with |v| > eps; null if none. */
  meanActive: number | null;
  /** Fraction of active samples. */
  duty: number;
};

const ZERO_INFLATED_EXPORT_KEYS = new Set<keyof ExportCycleRow>([
  "p_regen_kw",
  "p_trac_kw",
]);

/** Min / max / mean over finite numeric samples of one column. */
export function columnSeriesStats(
  rows: ExportCycleRow[],
  key: keyof ExportCycleRow
): ColumnSeriesStats | null {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  let sumActive = 0;
  let nActive = 0;
  const eps = 1e-9;
  for (const row of rows) {
    const v = row[key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    min = Math.min(min, v);
    max = Math.max(max, v);
    sum += v;
    count += 1;
    if (Math.abs(v) > eps) {
      sumActive += v;
      nActive += 1;
    }
  }
  if (count === 0) return null;
  return {
    min,
    max,
    mean: sum / count,
    count,
    meanActive: nActive > 0 ? sumActive / nActive : null,
    duty: nActive / count,
  };
}

export function exportColumnIsZeroInflated(key: keyof ExportCycleRow): boolean {
  return ZERO_INFLATED_EXPORT_KEYS.has(key);
}
