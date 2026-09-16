import type { DriverProfile } from "./types";

/** Full IDM / comfort physics exposed in the Conducteur UI. */
export type DriverPhysics = {
  a_max: number;
  b_comf: number;
  speed_factor: number;
  /** IDM time headway T (s). */
  T: number;
  /** Scan horizon time T_h (s): D_horizon = v · T_h. */
  T_h: number;
  /** Minimum bumper-to-bumper gap at stop (m). */
  s0: number;
  /** Max |da/dt| when accelerating (m/s³). */
  jerk_max: number;
  /** Max |da/dt| when braking (m/s³). */
  jerk_brake_max: number;
};

export type DriverPresetMeta = {
  id: DriverProfile;
  /** UI preset key (may share Markov base with another preset). */
  presetId: string;
  label: string;
  blurb: string;
  physics: DriverPhysics;
  a_y: number;
};

/** Default overspeed for Sport (+10 % → speed_factor 1.10). */
export const DEFAULT_SPORTIF_OVERSPEED_PCT = 10;

export const SPORTIF_OVERSPEED_PCT_MIN = -10;
export const SPORTIF_OVERSPEED_PCT_MAX = 50;

export function speedFactorToOverspeedPct(sf: number): number {
  return Math.round((sf - 1) * 100);
}

export function overspeedPctToSpeedFactor(pct: number): number {
  return Math.round((1 + pct / 100) * 100) / 100;
}

/** Gemini / AVL matrix — macroscopic driver presets. */
export const DRIVER_PRESETS: DriverPresetMeta[] = [
  {
    id: "Eco",
    presetId: "eco",
    label: "Eco",
    blurb: "Anticipation longue, pédales douces — bilan énergie minimal.",
    a_y: 2.0,
    physics: {
      a_max: 1.2,
      b_comf: 1.2,
      jerk_max: 0.5,
      jerk_brake_max: 1.5,
      T: 2.0,
      T_h: 5.0,
      s0: 3.0,
      speed_factor: 0.95,
    },
  },
  {
    id: "Normal",
    presetId: "normal",
    label: "Normal",
    blurb: "Conducteur moyen — accélération / freinage symétriques.",
    a_y: 3.0,
    physics: {
      a_max: 2.0,
      b_comf: 2.0,
      jerk_max: 1.5,
      jerk_brake_max: 3.0,
      T: 1.5,
      T_h: 3.5,
      s0: 2.0,
      speed_factor: 1.05,
    },
  },
  {
    id: "Sportif",
    presetId: "sport",
    label: "Sport",
    blurb: "Horizon court, freinages secs, a_y élevé — fading / énergie lourds.",
    a_y: 5.0,
    physics: {
      a_max: 3.5,
      b_comf: 3.5,
      jerk_max: 3.0,
      jerk_brake_max: 5.0,
      T: 1.0,
      T_h: 2.5,
      s0: 1.5,
      speed_factor: 1.1,
    },
  },
];

/** Standard AVL = BCB rétro-ingénierie (conservé). */
export const BCB_DRIVER_PHYSICS: DriverPhysics = {
  a_max: 2.58,
  b_comf: 1.71,
  jerk_max: 0.96,
  jerk_brake_max: 2.93,
  T: 1.4,
  T_h: 4.0,
  s0: 2.5,
  speed_factor: 1.05,
};

export const BCB_DRIVER_A_Y = 3.5;

export const AVL_PRESET: DriverPresetMeta = {
  id: "Normal",
  presetId: "avl",
  label: "Standard AVL",
  blurb:
    "Signature BCB / AVL CRUISE — accélération volontaire, freinage anticipatif asymétrique.",
  a_y: BCB_DRIVER_A_Y,
  physics: { ...BCB_DRIVER_PHYSICS },
};

/** All selectable UI presets (Eco · Normal · Sport · Standard AVL). */
export const UI_DRIVER_PRESETS: DriverPresetMeta[] = [
  ...DRIVER_PRESETS,
  AVL_PRESET,
];

export function presetFor(profile: DriverProfile): DriverPresetMeta {
  return (
    DRIVER_PRESETS.find((p) => p.id === profile) ?? DRIVER_PRESETS[1]
  );
}

export function uiPresetById(presetId: string): DriverPresetMeta | undefined {
  return UI_DRIVER_PRESETS.find((p) => p.presetId === presetId);
}

export function physicsEqual(a: DriverPhysics, b: DriverPhysics): boolean {
  return (
    a.a_max === b.a_max &&
    a.b_comf === b.b_comf &&
    a.speed_factor === b.speed_factor &&
    a.T === b.T &&
    a.T_h === b.T_h &&
    a.s0 === b.s0 &&
    a.jerk_max === b.jerk_max &&
    a.jerk_brake_max === b.jerk_brake_max
  );
}

export const DEFAULT_MAX_SPEED_KMH = 130;
export const DEFAULT_A_Y = BCB_DRIVER_A_Y;
export const DEFAULT_DRIVER_PROFILE: DriverProfile = "Normal";

export function defaultDriverPhysics(): DriverPhysics {
  return { ...BCB_DRIVER_PHYSICS };
}

/** Fill missing keys from AVL defaults (zones / legacy storage). */
export function completePhysics(
  partial: Partial<DriverPhysics> | null | undefined
): DriverPhysics {
  return { ...BCB_DRIVER_PHYSICS, ...(partial ?? {}) };
}

/** Match UI preset from physics + a_y, or null if custom. */
export function matchUiPreset(
  physics: DriverPhysics,
  aY: number
): DriverPresetMeta | null {
  for (const p of UI_DRIVER_PRESETS) {
    if (physicsEqual(physics, p.physics) && Math.abs(aY - p.a_y) < 0.05) {
      return p;
    }
  }
  return null;
}

/** French tooltips for the 3 UI blocks (Gemini). */
export const DRIVER_UI_DOCS = {
  a_max: {
    title: "a_max — accélération max",
    body: "Plafond d’accélération en ligne droite dégagée.",
  },
  b_comf: {
    title: "b_comf — freinage confort",
    body: "Force de freinage nominale anticipée (hors urgence).",
  },
  jerk_max: {
    title: "Jerk+ — attaque accélérateur",
    body: "Vitesse d’enfoncement de la pédale d’accélérateur (lissage de traction).",
  },
  jerk_brake_max: {
    title: "Jerk− — attaque frein",
    body: "Vitesse d’attaque de la pédale de frein (mordant).",
  },
  T: {
    title: "T — time headway IDM",
    body: "Marge de sécurité temporelle séparant le véhicule de l’obstacle.",
  },
  T_h: {
    title: "T_h — horizon d’anticipation",
    body: "Temps de projection pour scanner virages et limites (D = v · T_h).",
  },
  s0: {
    title: "s₀ — gap minimal",
    body: "Espace conservé à l’arrêt complet face à un obstacle.",
  },
  speed_factor: {
    title: "Speed factor",
    body: "Tolérance par rapport à la vitesse limite (0,9 = prudent, 1,1 = +10 %).",
  },
  a_y: {
    title: "a_y — latéral",
    body: "Tolérance centrifuge en courbe : V = √(a_y · R).",
  },
} as const;
