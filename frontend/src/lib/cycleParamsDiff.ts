/**
 * Structural cycle params fingerprint + human-readable before→after diffs
 * for the « régénérer » warning.
 */

import type { EnvelopeMask } from "@/lib/corridorEdit";
import type { DriverPhysics } from "@/lib/driverPresets";
import { completePhysics } from "@/lib/driverPresets";
import type { DriverProfile, SimEngine } from "@/lib/types";

export type CycleFeuxSnap = { s: number; m: string };

export type CycleZoneSnap = {
  s0: number;
  s1: number;
  a_max: number;
  b_comf: number;
  speed_factor: number;
  a_y: number | null;
};

export type CycleParamsSnapshot = {
  routeKey: string;
  aY: number;
  envelopeMask: EnvelopeMask;
  slope: string;
  /** Filtrage V_legal (mode:window:minRun). */
  legal?: string;
  includeTrafficLights: boolean;
  physics: DriverPhysics;
  maxSpeedKmh: number | null;
  driverProfile: DriverProfile;
  driverZones: CycleZoneSnap[] | null;
  preferredEngine: SimEngine;
  feux: CycleFeuxSnap[];
};

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function asPhysics(v: unknown): DriverPhysics | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const a_max = Number(o.a_max);
  const b_comf = Number(o.b_comf);
  const speed_factor = Number(o.speed_factor);
  if (![a_max, b_comf, speed_factor].every(Number.isFinite)) return null;
  return completePhysics({
    a_max: round3(a_max),
    b_comf: round3(b_comf),
    speed_factor: round3(speed_factor),
    T: Number.isFinite(Number(o.T)) ? round3(Number(o.T)) : undefined,
    T_h: Number.isFinite(Number(o.T_h)) ? round3(Number(o.T_h)) : undefined,
    s0: Number.isFinite(Number(o.s0)) ? round3(Number(o.s0)) : undefined,
    jerk_max: Number.isFinite(Number(o.jerk_max))
      ? round3(Number(o.jerk_max))
      : undefined,
    jerk_brake_max: Number.isFinite(Number(o.jerk_brake_max))
      ? round3(Number(o.jerk_brake_max))
      : undefined,
  });
}

function asMask(v: unknown): EnvelopeMask {
  if (!v || typeof v !== "object") {
    return { legal: true, traffic: true, curve: true };
  }
  const o = v as Record<string, unknown>;
  return {
    legal: o.legal !== false,
    traffic: o.traffic !== false,
    curve: o.curve !== false,
  };
}

function asFeux(v: unknown): CycleFeuxSnap[] {
  if (!Array.isArray(v)) return [];
  return v.map((item) => {
    if (!item || typeof item !== "object") return { s: 0, m: "stochastic" };
    const o = item as Record<string, unknown>;
    return {
      s: Math.round(Number(o.s) * 10) / 10 || 0,
      m: typeof o.m === "string" ? o.m : "stochastic",
    };
  });
}

function asZones(v: unknown): CycleZoneSnap[] | null {
  if (v == null) return null;
  if (!Array.isArray(v)) return null;
  if (!v.length) return null;
  return v.map((item) => {
    const o = (item ?? {}) as Record<string, unknown>;
    const phys =
      asPhysics(o) ??
      asPhysics({
        a_max: o.a_max,
        b_comf: o.b_comf,
        speed_factor: o.speed_factor,
      }) ?? {
        a_max: 0,
        b_comf: 0,
        speed_factor: 1,
      };
    return {
      s0: Number(o.s0) || 0,
      s1: Number(o.s1) || 0,
      a_max: phys.a_max,
      b_comf: phys.b_comf,
      speed_factor: phys.speed_factor,
      a_y: o.a_y == null ? null : round3(Number(o.a_y)),
    };
  });
}

/** Normalize current or legacy fingerprints into a comparable snapshot. */
export function coerceCycleParamsSnapshot(
  raw: unknown
): CycleParamsSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  // Current flat shape
  if (typeof o.routeKey === "string" && o.physics) {
    const physics = asPhysics(o.physics);
    if (!physics) return null;
    return {
      routeKey: o.routeKey,
      aY: round3(Number(o.aY) || 0),
      envelopeMask: asMask(o.envelopeMask),
      slope: typeof o.slope === "string" ? o.slope : "",
      legal: typeof o.legal === "string" ? o.legal : "",
      includeTrafficLights: !!o.includeTrafficLights,
      physics,
      maxSpeedKmh:
        o.maxSpeedKmh == null || o.maxSpeedKmh === ""
          ? null
          : Number(o.maxSpeedKmh),
      driverProfile: (o.driverProfile as DriverProfile) ?? "Normal",
      driverZones: asZones(o.driverZones),
      preferredEngine: (o.preferredEngine as SimEngine) ?? "idm",
      feux: asFeux(o.feux),
    };
  }

  // Legacy shape: { envelopeKey: JSON-string, physics, … }
  let env: Record<string, unknown> = {};
  if (typeof o.envelopeKey === "string") {
    try {
      env = JSON.parse(o.envelopeKey) as Record<string, unknown>;
    } catch {
      env = {};
    }
  } else if (o.envelopeKey && typeof o.envelopeKey === "object") {
    env = o.envelopeKey as Record<string, unknown>;
  }

  const physics = asPhysics(o.physics);
  if (!physics) return null;

  return {
    routeKey: typeof env.routeKey === "string" ? env.routeKey : "",
    aY: round3(Number(env.aY) || 0),
    envelopeMask: asMask(env.envelopeMask),
    slope: typeof env.slope === "string" ? env.slope : "",
    includeTrafficLights: o.includeTrafficLights !== false,
    physics,
    maxSpeedKmh:
      o.maxSpeedKmh == null || o.maxSpeedKmh === ""
        ? null
        : Number(o.maxSpeedKmh),
    driverProfile: (o.driverProfile as DriverProfile) ?? "Normal",
    driverZones: asZones(
      o.driverZonesEnabled === false ? null : o.driverZones
    ),
    preferredEngine: (o.preferredEngine as SimEngine) ?? "idm",
    feux: asFeux(o.feux),
  };
}

export function buildCycleParamsSnapshot(args: {
  routeKey: string;
  aY: number;
  envelopeMask: EnvelopeMask;
  slopeKey: string;
  legalKey?: string;
  includeTrafficLights: boolean;
  physics: DriverPhysics;
  maxSpeedKmh: number | null;
  driverProfile: DriverProfile;
  driverZonesEnabled: boolean;
  driverZones: {
    s0_m: number;
    s1_m: number | null;
    physics: DriverPhysics;
    a_y?: number | null;
  }[];
  preferredEngine: SimEngine;
  feux: CycleFeuxSnap[];
}): CycleParamsSnapshot {
  const zones =
    args.driverZonesEnabled && args.driverZones.length
      ? args.driverZones.map((z) => ({
          s0: Math.round(z.s0_m * 10) / 10,
          s1: z.s1_m == null ? -1 : Math.round(z.s1_m * 10) / 10,
          a_max: round3(z.physics.a_max),
          b_comf: round3(z.physics.b_comf),
          speed_factor: round3(z.physics.speed_factor),
          a_y: z.a_y == null ? null : round3(z.a_y),
        }))
      : null;

  return {
    routeKey: args.routeKey,
    aY: round3(args.aY),
    envelopeMask: {
      legal: !!args.envelopeMask.legal,
      traffic: !!args.envelopeMask.traffic,
      curve: !!args.envelopeMask.curve,
    },
    slope: args.slopeKey,
    legal: args.legalKey ?? "",
    includeTrafficLights: !!args.includeTrafficLights,
    physics: completePhysics({
      a_max: round3(args.physics.a_max),
      b_comf: round3(args.physics.b_comf),
      speed_factor: round3(args.physics.speed_factor),
      T: round3(args.physics.T),
      T_h: round3(args.physics.T_h),
      s0: round3(args.physics.s0),
      jerk_max: round3(args.physics.jerk_max),
      jerk_brake_max: round3(args.physics.jerk_brake_max),
    }),
    maxSpeedKmh: args.maxSpeedKmh,
    driverProfile: args.driverProfile,
    driverZones: zones,
    preferredEngine: args.preferredEngine,
    feux: args.feux,
  };
}

export function cycleParamsKeyOf(snap: CycleParamsSnapshot): string {
  return JSON.stringify(snap);
}

export function parseCycleParamsSnapshot(
  raw: string | null | undefined
): CycleParamsSnapshot | null {
  if (!raw) return null;
  try {
    return coerceCycleParamsSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

function fmtNum(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  const s = n.toFixed(digits);
  return s.replace(/\.?0+$/, "") || "0";
}

function fmtOnOff(v: boolean): string {
  return v ? "ON" : "OFF";
}

function fmtMaxSpeed(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "aucun" : `${fmtNum(v, 0)} km/h`;
}

function fmtZones(z: CycleZoneSnap[] | null | undefined): string {
  if (!z?.length) return "désactivées";
  return `${z.length} zone${z.length > 1 ? "s" : ""}`;
}

function fmtFeux(f: CycleFeuxSnap[] | undefined): string {
  const n = f?.length ?? 0;
  if (!n) return "aucun";
  const gw = f!.filter((x) => x.m === "green_wave").length;
  return gw > 0 ? `${n} (${gw} onde verte)` : String(n);
}

function fmtSlope(key: string | undefined): string {
  if (!key) return "—";
  return key.split(":")[0] ?? key;
}

function pushChange(
  lines: string[],
  label: string,
  before: string,
  after: string
) {
  if (before === after) return;
  lines.push(`${label} : ${before} → ${after}`);
}

/**
 * Human-readable list of structural changes (before → after).
 */
export function diffCycleParamsLines(
  before: CycleParamsSnapshot | null,
  after: CycleParamsSnapshot
): string[] {
  if (!before) {
    return ["État précédent indisponible — régénérez une fois pour calibrer."];
  }

  const lines: string[] = [];

  if (before.routeKey !== after.routeKey) {
    lines.push("Trajet / horaires / vias : modifié");
  }

  pushChange(
    lines,
    "Accél. latérale aᵧ",
    `${fmtNum(before.aY)} m/s²`,
    `${fmtNum(after.aY)} m/s²`
  );

  pushChange(
    lines,
    "Masque légal",
    fmtOnOff(!!before.envelopeMask?.legal),
    fmtOnOff(!!after.envelopeMask.legal)
  );
  pushChange(
    lines,
    "Masque trafic",
    fmtOnOff(!!before.envelopeMask?.traffic),
    fmtOnOff(!!after.envelopeMask.traffic)
  );
  pushChange(
    lines,
    "Masque virage",
    fmtOnOff(!!before.envelopeMask?.curve),
    fmtOnOff(!!after.envelopeMask.curve)
  );

  if (before.slope !== after.slope) {
    const bp = fmtSlope(before.slope);
    const ap = fmtSlope(after.slope);
    if (bp !== ap) {
      lines.push(`Algo pente : ${bp} → ${ap}`);
    } else {
      lines.push(`Réglages pente : modifiés (${ap})`);
    }
  }

  if ((before.legal ?? "") !== (after.legal ?? "")) {
    lines.push(
      `Filtre V_légal : ${before.legal || "—"} → ${after.legal || "—"}`
    );
  }

  pushChange(
    lines,
    "Feux tricolores (inclusion)",
    fmtOnOff(!!before.includeTrafficLights),
    fmtOnOff(!!after.includeTrafficLights)
  );

  pushChange(
    lines,
    "Profil conducteur",
    String(before.driverProfile ?? "—"),
    String(after.driverProfile)
  );
  pushChange(
    lines,
    "a_max",
    `${fmtNum(before.physics?.a_max ?? NaN)} m/s²`,
    `${fmtNum(after.physics.a_max)} m/s²`
  );
  pushChange(
    lines,
    "b_comf",
    `${fmtNum(before.physics?.b_comf ?? NaN)} m/s²`,
    `${fmtNum(after.physics.b_comf)} m/s²`
  );
  pushChange(
    lines,
    "Facteur vitesse",
    fmtNum(before.physics?.speed_factor ?? NaN, 3),
    fmtNum(after.physics.speed_factor, 3)
  );
  pushChange(
    lines,
    "T (headway)",
    `${fmtNum(before.physics?.T ?? NaN, 2)} s`,
    `${fmtNum(after.physics.T, 2)} s`
  );
  pushChange(
    lines,
    "T_h (horizon)",
    `${fmtNum(before.physics?.T_h ?? NaN, 2)} s`,
    `${fmtNum(after.physics.T_h, 2)} s`
  );
  pushChange(
    lines,
    "s₀",
    `${fmtNum(before.physics?.s0 ?? NaN, 2)} m`,
    `${fmtNum(after.physics.s0, 2)} m`
  );
  pushChange(
    lines,
    "Jerk+",
    `${fmtNum(before.physics?.jerk_max ?? NaN, 2)} m/s³`,
    `${fmtNum(after.physics.jerk_max, 2)} m/s³`
  );
  pushChange(
    lines,
    "Jerk−",
    `${fmtNum(before.physics?.jerk_brake_max ?? NaN, 2)} m/s³`,
    `${fmtNum(after.physics.jerk_brake_max, 2)} m/s³`
  );

  pushChange(
    lines,
    "Plafond Vmax",
    fmtMaxSpeed(before.maxSpeedKmh),
    fmtMaxSpeed(after.maxSpeedKmh)
  );

  const bz = JSON.stringify(before.driverZones ?? null);
  const az = JSON.stringify(after.driverZones ?? null);
  if (bz !== az) {
    const sameCount =
      (before.driverZones?.length ?? 0) > 0 &&
      (after.driverZones?.length ?? 0) > 0 &&
      fmtZones(before.driverZones) === fmtZones(after.driverZones);
    lines.push(
      sameCount
        ? "Zones conducteur : paramètres / bornes modifiés"
        : `Zones conducteur : ${fmtZones(before.driverZones)} → ${fmtZones(after.driverZones)}`
    );
  }

  pushChange(
    lines,
    "Moteur",
    String(before.preferredEngine ?? "—").toUpperCase(),
    String(after.preferredEngine).toUpperCase()
  );

  const bf = JSON.stringify(before.feux ?? []);
  const af = JSON.stringify(after.feux ?? []);
  if (bf !== af) {
    lines.push(
      `Feux (positions / modes) : ${fmtFeux(before.feux)} → ${fmtFeux(after.feux)}`
    );
  }

  return lines.length
    ? lines
    : ["Différence détectée (détail indisponible)."];
}

export function formatStaleCycleMessage(diffLines: string[]): {
  message: string;
  lines: string[];
} {
  return {
    message: "Paramètres structurants modifiés — régénérez si besoin",
    lines: diffLines,
  };
}
