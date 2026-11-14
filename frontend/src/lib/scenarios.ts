import type { ConsolidatedProfile } from "./types";

/** Compare modes embedded in the main pipeline (not a dedicated Scenarios tab). */
export type CompareMode =
  | "off"
  | "peak_night"
  | "drivers"
  | "tls"
  | "seeds"
  | "speed_cap";

export type CompareModeDef = {
  id: CompareMode;
  label: string;
  hint: string;
  /** Needs a built spatial corridor (same geometry). */
  needsCorridor: boolean;
  /** Needs A/B endpoints + routing (re-analyze with different depart_at). */
  needsRouteEnds: boolean;
};

export const COMPARE_MODES: CompareModeDef[] = [
  {
    id: "off",
    label: "Off",
    hint: "Single simulation only",
    needsCorridor: false,
    needsRouteEnds: false,
  },
  {
    id: "peak_night",
    label: "A · Pointe/Nuit",
    hint: "Vague 1 — même A→B, Mapbox depart_at pointe vs nuit (stops, durée)",
    needsCorridor: false,
    needsRouteEnds: true,
  },
  {
    id: "drivers",
    label: "C · 3 conducteurs",
    hint: "Vague 1 — Eco / Normal / Agressif sur le cycle courant",
    needsCorridor: true,
    needsRouteEnds: false,
  },
  {
    id: "tls",
    label: "D · Feux",
    hint: "Vague 1 — TLS green_wave vs stochastic",
    needsCorridor: true,
    needsRouteEnds: false,
  },
  {
    id: "seeds",
    label: "F · 3 graines",
    hint: "Vague 2 — Normal × seeds 1/2/3 (Markov / TLS)",
    needsCorridor: true,
    needsRouteEnds: false,
  },
  {
    id: "speed_cap",
    label: "G · Cap 90·130",
    hint: "Vague 2 — max_speed 90 vs 130 km/h",
    needsCorridor: true,
    needsRouteEnds: false,
  },
];

export function compareModeById(id: CompareMode): CompareModeDef {
  return COMPARE_MODES.find((m) => m.id === id) ?? COMPARE_MODES[0];
}

/** Legacy catalog ids kept for docs / science mapping. */
export type ScenarioId = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I";

export type ScenarioDef = {
  id: ScenarioId;
  title: string;
  objective: string;
  compareMode?: CompareMode;
  /** How it surfaces in UI after refactor */
  ui: string;
};

export const SCENARIO_CATALOG: ScenarioDef[] = [
  {
    id: "A",
    title: "Congestion pointe / nuit",
    objective: "Même trajet, depart_at pointe vs nuit — stops, durée, fluidité.",
    compareMode: "peak_night",
    ui: "Chip Pointe/Nuit + Comparer variantes",
  },
  {
    id: "B",
    title: "Audit sécurité",
    objective: "max |a|, |a|/g, gate Markov, clips sur le profil consolidé.",
    ui: "Bandeau sécurité sous le profil",
  },
  {
    id: "C",
    title: "Multi-profils",
    objective: "Eco / Normal / Agressif, overlay v(t), RPA.",
    compareMode: "drivers",
    ui: "Chip 3 conducteurs",
  },
  {
    id: "D",
    title: "TLS what-if",
    objective: "Onde verte vs stochastique — Δ arrêts.",
    compareMode: "tls",
    ui: "Chip Feux",
  },
  {
    id: "E",
    title: "Murs de pente",
    objective: "Warnings imputation ponts/tunnels / spikes α.",
    ui: "Panneau Imputations (sidebar / cycle)",
  },
  {
    id: "F",
    title: "Variabilité seed",
    objective: "Trois graines Normal — robustesse Markov/TLS.",
    compareMode: "seeds",
    ui: "Chip 3 graines",
  },
  {
    id: "G",
    title: "Cap vitesse",
    objective: "max_speed 90 vs 130 km/h.",
    compareMode: "speed_cap",
    ui: "Chip Cap 90·130",
  },
  {
    id: "H",
    title: "Recalage GPS",
    objective: "Inject corpus geo → compare gen vs référence.",
    ui: "Workspace Inject + Comparer (corpus)",
  },
  {
    id: "I",
    title: "Stress alpin",
    objective: "Trajet montagne + a_y + warnings pente.",
    ui: "GPS A/B + a_y (pas de chip dédié)",
  },
];

const STOP_THRESH_MPS = 0.5;
const STOP_MIN_DURATION_S = 0.99;

export type ClientProfileKpis = {
  duration_s: number;
  mean_speed_kmh: number;
  stops: number;
  rpa: number;
};

export function countStops(
  velocity: number[],
  time: number[],
  thresh = STOP_THRESH_MPS
): number {
  const n = Math.min(velocity.length, time.length);
  if (n === 0) return 0;
  let events = 0;
  let i = 0;
  while (i < n) {
    if ((velocity[i] ?? 0) >= thresh) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < n && (velocity[j] ?? 0) < thresh) j += 1;
    let dur: number;
    if (j < n) {
      dur = (time[j] ?? 0) - (time[i] ?? 0);
    } else if (n > 1) {
      const dt = (time[1] ?? 0) - (time[0] ?? 0);
      dur = (time[n - 1] ?? 0) - (time[i] ?? 0) + Math.max(dt, 0);
    } else {
      dur = STOP_MIN_DURATION_S;
    }
    if (dur >= STOP_MIN_DURATION_S) events += 1;
    i = j;
  }
  return events;
}

export function computeRpa(profile: ConsolidatedProfile): number {
  if (profile.rpa != null && Number.isFinite(profile.rpa)) return profile.rpa;
  const { time: t, velocity: v, acceleration: a, position: s } = profile;
  const n = Math.min(t.length, v.length, a.length);
  if (n < 2) return 0;
  let integral = 0;
  for (let i = 0; i < n - 1; i++) {
    const dt = (t[i + 1] ?? 0) - (t[i] ?? 0);
    if (dt <= 0) continue;
    const ap = Math.max(0, a[i] ?? 0);
    const vm = 0.5 * ((v[i] ?? 0) + (v[i + 1] ?? 0));
    integral += ap * vm * dt;
  }
  const dist =
    s.length >= 2
      ? Math.max(0, (s[s.length - 1] ?? 0) - (s[0] ?? 0))
      : Math.max(
          1e-3,
          v.slice(0, n - 1).reduce((acc, vi, i) => {
            const dt = (t[i + 1] ?? 0) - (t[i] ?? 0);
            return acc + Math.max(0, vi) * Math.max(0, dt);
          }, 0)
        );
  return dist > 1e-3 ? integral / dist : 0;
}

export function computeClientProfileKpis(
  profile: ConsolidatedProfile
): ClientProfileKpis {
  const duration_s =
    profile.total_duration_s ??
    profile.time[profile.time.length - 1] ??
    0;
  const mean_speed_kmh =
    profile.average_speed_kmh ??
    (duration_s > 0 && profile.position.length
      ? ((profile.position[profile.position.length - 1] ?? 0) / duration_s) *
        3.6
      : 0);
  return {
    duration_s,
    mean_speed_kmh,
    stops: profile.stops ?? countStops(profile.velocity, profile.time),
    rpa: computeRpa(profile),
  };
}

/** @deprecated use COMPARE_MODES */
export const SCENARIOS = SCENARIO_CATALOG;
/** @deprecated */
export function scenarioById(id: ScenarioId) {
  return SCENARIO_CATALOG.find((s) => s.id === id) ?? SCENARIO_CATALOG[0];
}
