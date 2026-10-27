/** Local vehicle catalog (WLTP-style mass + road load F0/F1/F2). */

import { migrateLegacyLibraries } from "@/lib/localStorageMigrate";

const STORAGE_KEY = "cyclegen.vehicles.v3";

export type MassCode =
  | "MVODM"
  | "MMAC"
  | "MRODM"
  | "TM"
  | "RM";

export const MASS_CODE_LABEL: Record<MassCode, string> = {
  MVODM: "MVODM — masse à vide en ordre de marche",
  MMAC: "MMAC — masse max. autorisée en charge",
  MRODM: "MRODM — masse en running order (WLTP)",
  TM: "TM — test mass (WLTP)",
  RM: "RM — reference mass",
};

export type VehiclePowertrain = "ice" | "hev" | "bev" | "unknown";

export type VehicleCard = {
  id: string;
  code: string;
  name: string;
  massCode: MassCode;
  mass_kg: number;
  f0_n: number;
  f1_n_per_kph: number;
  f2_n_per_kph2: number;
  r_dyn_m: number;
  /**
   * Max |hydraulic brake torque| at wheels (N·m).
   * When wheel speed ≈ 0, τ_wheel is set to −τ_brake_max (EP-SIM standstill rule).
   */
  tau_brake_max_nm?: number | null;
  v_max_kmh: number | null;
  power_kw: number | null;
  powertrain: VehiclePowertrain;
  /** Optional geometry / energy metadata (AVL CRUISE, CoC, …). */
  battery_kwh?: number | null;
  length_m?: number | null;
  width_m?: number | null;
  height_m?: number | null;
  wheelbase_m?: number | null;
  tyre?: string | null;
  tyre_diameter_m?: number | null;
  /** Cornering stiffness (AVL units, often N/°). Informational until lateral model uses it. */
  cornering_stiffness?: number | null;
  notes?: string;
  source?: string;
  milestone?: string;
};

/**
 * Seed catalog: OEM Renault (user) + BEV engineering proxies.
 * Official CoC F0/F1/F2 are rarely public — proxies are labeled as such.
 */
const SEED: VehicleCard[] = [
  {
    id: "renault-cspace-leapfrog-apr2bis",
    code: "C-SPACE / Leapfrog",
    name: "C-Space / Leapfrog",
    massCode: "TM",
    mass_kg: 2034,
    f0_n: 125.5,
    f1_n_per_kph: -0.0211,
    f2_n_per_kph2: 0.0375,
    r_dyn_m: 0.325,
    v_max_kmh: 160,
    power_kw: null,
    powertrain: "bev",
    milestone: "APR2 bis",
    notes: "Road load constructeur — milestone APR2 bis.",
    source: "Renault · APR2 bis",
  },
  {
    id: "renault-xspace-apr2bis",
    code: "Grossglockner",
    name: "Grossglockner",
    massCode: "TM",
    mass_kg: 2556,
    f0_n: 163.2,
    f1_n_per_kph: -0.0145,
    f2_n_per_kph2: 0.0422,
    r_dyn_m: 0.356,
    tau_brake_max_nm: 10000,
    v_max_kmh: 160,
    power_kw: null,
    powertrain: "bev",
    milestone: "APR2 bis",
    notes:
      "Road load constructeur — milestone APR2 bis. r_dyn=0.356 m (EP-SIM Space). τ_brake_max=10 kN·m à roue arrêtée (Grossglockner EP-SIM).",
    source: "Renault · APR2 bis · EP-SIM Space",
  },
  {
    id: "seed-bcb",
    code: "BCB",
    name: "BCB",
    massCode: "TM",
    mass_kg: 1736,
    f0_n: 118.3,
    f1_n_per_kph: 0.422,
    f2_n_per_kph2: 0.03642,
    r_dyn_m: 0.34,
    tau_brake_max_nm: null,
    v_max_kmh: 160,
    power_kw: 160,
    powertrain: "bev",
    battery_kwh: 60,
    length_m: 4.2,
    width_m: 1.86,
    height_m: 1.51,
    wheelbase_m: 2.69,
    tyre: "215/40R20",
    tyre_diameter_m: 0.68,
    cornering_stiffness: 850,
    notes:
      "AVL CRUISE — epwt 160 kW / 60 kWh. Coast-down F0/F1/F2 + body/tyre from Vehicle Data. r_dyn = Ø/2 = 0,34 m.",
    source: "AVL CRUISE · Vehicle Data BCB",
  },
  {
    id: "seed-zoe-bev",
    code: "ZOE-R135",
    name: "Renault Zoé R135 (proxy ingénierie)",
    massCode: "TM",
    mass_kg: 1575,
    f0_n: 118,
    f1_n_per_kph: 0.42,
    f2_n_per_kph2: 0.029,
    r_dyn_m: 0.312,
    v_max_kmh: 140,
    power_kw: 100,
    powertrain: "bev",
    notes:
      "Proxy CycleGen — F0/F1/F2 non officiels (ordre de grandeur BEV citadin).",
    source: "CycleGen · proxy BEV public",
  },
  {
    id: "seed-leaf-bev",
    code: "LEAF-40",
    name: "Nissan Leaf 40 kWh (proxy ingénierie)",
    massCode: "TM",
    mass_kg: 1580,
    f0_n: 120,
    f1_n_per_kph: 0.55,
    f2_n_per_kph2: 0.032,
    r_dyn_m: 0.316,
    v_max_kmh: 144,
    power_kw: 110,
    powertrain: "bev",
    notes: "Proxy CycleGen — coast-down type BEV compact.",
    source: "CycleGen · proxy BEV public",
  },
  {
    id: "seed-id3-bev",
    code: "ID3-58",
    name: "Volkswagen ID.3 Pro (proxy ingénierie)",
    massCode: "TM",
    mass_kg: 1810,
    f0_n: 127.3,
    f1_n_per_kph: 0.83,
    f2_n_per_kph2: 0.0253,
    r_dyn_m: 0.33,
    v_max_kmh: 160,
    power_kw: 150,
    powertrain: "bev",
    notes:
      "Ordre de grandeur issu d’analyses open (ex. RLC dérivés) — pas un CoC.",
    source: "CycleGen · proxy BEV (littérature open)",
  },
  {
    id: "seed-model3-bev",
    code: "M3-RWD",
    name: "Tesla Model 3 RWD (proxy ingénierie)",
    massCode: "TM",
    mass_kg: 1760,
    f0_n: 115,
    f1_n_per_kph: 0.35,
    f2_n_per_kph2: 0.024,
    r_dyn_m: 0.335,
    v_max_kmh: 225,
    power_kw: 208,
    powertrain: "bev",
    notes: "Proxy CycleGen — Cx bas typique berline BEV.",
    source: "CycleGen · proxy BEV public",
  },
  {
    id: "seed-ioniq5-bev",
    code: "IONIQ5",
    name: "Hyundai Ioniq 5 (proxy ingénierie)",
    massCode: "TM",
    mass_kg: 2020,
    f0_n: 135,
    f1_n_per_kph: 0.6,
    f2_n_per_kph2: 0.036,
    r_dyn_m: 0.34,
    v_max_kmh: 185,
    power_kw: 160,
    powertrain: "bev",
    notes: "Proxy CycleGen — SUV/crossover BEV.",
    source: "CycleGen · proxy BEV public",
  },
  {
    id: "seed-bev-tm",
    code: "BEV-C-TM",
    name: "BEV compact — masse d’essai type",
    massCode: "TM",
    mass_kg: 1810,
    f0_n: 102,
    f1_n_per_kph: 0.48,
    f2_n_per_kph2: 0.028,
    r_dyn_m: 0.322,
    v_max_kmh: 160,
    power_kw: 150,
    powertrain: "bev",
    notes: "Seed générique CycleGen.",
    source: "CycleGen seed",
  },
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function asNum(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function normalize(raw: unknown): VehicleCard | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id : "";
  const code = typeof raw.code === "string" ? raw.code : "";
  const name = typeof raw.name === "string" ? raw.name : "";
  if (!id || !code || !name) return null;
  const massCode = (
    ["MVODM", "MMAC", "MRODM", "TM", "RM"] as MassCode[]
  ).includes(raw.massCode as MassCode)
    ? (raw.massCode as MassCode)
    : "TM";
  const pt = raw.powertrain;
  const powertrain: VehiclePowertrain =
    pt === "ice" || pt === "hev" || pt === "bev" || pt === "unknown"
      ? pt
      : "unknown";
  return {
    id,
    code,
    name,
    massCode,
    mass_kg: asNum(raw.mass_kg, 1500),
    f0_n: asNum(raw.f0_n, 90),
    f1_n_per_kph: asNum(raw.f1_n_per_kph, 0.5),
    f2_n_per_kph2: asNum(raw.f2_n_per_kph2, 0.03),
    r_dyn_m: asNum(raw.r_dyn_m, 0.31),
    tau_brake_max_nm:
      typeof raw.tau_brake_max_nm === "number" &&
      Number.isFinite(raw.tau_brake_max_nm) &&
      raw.tau_brake_max_nm > 0
        ? raw.tau_brake_max_nm
        : null,
    v_max_kmh:
      typeof raw.v_max_kmh === "number" && Number.isFinite(raw.v_max_kmh)
        ? raw.v_max_kmh
        : null,
    power_kw:
      typeof raw.power_kw === "number" && Number.isFinite(raw.power_kw)
        ? raw.power_kw
        : null,
    powertrain,
    battery_kwh:
      typeof raw.battery_kwh === "number" && Number.isFinite(raw.battery_kwh)
        ? raw.battery_kwh
        : null,
    length_m:
      typeof raw.length_m === "number" && Number.isFinite(raw.length_m)
        ? raw.length_m
        : null,
    width_m:
      typeof raw.width_m === "number" && Number.isFinite(raw.width_m)
        ? raw.width_m
        : null,
    height_m:
      typeof raw.height_m === "number" && Number.isFinite(raw.height_m)
        ? raw.height_m
        : null,
    wheelbase_m:
      typeof raw.wheelbase_m === "number" && Number.isFinite(raw.wheelbase_m)
        ? raw.wheelbase_m
        : null,
    tyre: typeof raw.tyre === "string" ? raw.tyre : null,
    tyre_diameter_m:
      typeof raw.tyre_diameter_m === "number" &&
      Number.isFinite(raw.tyre_diameter_m)
        ? raw.tyre_diameter_m
        : null,
    cornering_stiffness:
      typeof raw.cornering_stiffness === "number" &&
      Number.isFinite(raw.cornering_stiffness)
        ? raw.cornering_stiffness
        : null,
    notes: typeof raw.notes === "string" ? raw.notes : undefined,
    source: typeof raw.source === "string" ? raw.source : undefined,
    milestone: typeof raw.milestone === "string" ? raw.milestone : undefined,
  };
}

function mergeSeeds(stored: VehicleCard[]): VehicleCard[] {
  // Seed OEM cards always win (keeps r_dyn / τ_brake updates); user extras kept.
  const seedIds = new Set(SEED.map((s) => s.id));
  return [...SEED, ...stored.filter((v) => !seedIds.has(v.id))];
}

function readAll(): VehicleCard[] {
  if (typeof window === "undefined") return [...SEED];
  migrateLegacyLibraries();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      writeAll(SEED);
      return [...SEED];
    }
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data) || data.length === 0) {
      writeAll(SEED);
      return [...SEED];
    }
    const list = data
      .map((v) => normalize(v))
      .filter((v): v is VehicleCard => v != null);
    const merged = mergeSeeds(list.length ? list : SEED);
    writeAll(merged);
    return merged;
  } catch {
    return [...SEED];
  }
}

function writeAll(list: VehicleCard[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function listVehicles(): VehicleCard[] {
  return readAll();
}

export function getVehicle(id: string): VehicleCard | null {
  return readAll().find((v) => v.id === id) ?? null;
}

export function saveVehicle(
  input: Omit<VehicleCard, "id"> & { id?: string }
): VehicleCard {
  const id =
    input.id ??
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `veh-${crypto.randomUUID()}`
      : `veh-${Date.now()}`);
  const card: VehicleCard = { ...input, id };
  const next = [card, ...readAll().filter((v) => v.id !== id)];
  writeAll(next);
  return card;
}

export function deleteVehicle(id: string): void {
  // Keep OEM seeds
  if (SEED.some((s) => s.id === id && s.source?.startsWith("Renault"))) return;
  writeAll(readAll().filter((v) => v.id !== id));
}

export function listSeedVehicles(): VehicleCard[] {
  return [...SEED];
}
