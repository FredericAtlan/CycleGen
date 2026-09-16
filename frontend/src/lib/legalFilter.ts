/** Filtrage spatial de V_legal (limites postées) — options Studio → API. */

export type LegalSmoothMode = "none" | "majority" | "min" | "mean_snap";

export type LegalFilterOptions = {
  /** Spatial filter mode on posted speeds along S. */
  mode: LegalSmoothMode;
  /** Sliding window width (m) for majority / min / mean. */
  windowM: number;
  /** Minimum plateau length (m) before a limit change is accepted (debounce). */
  minRunM: number;
};

export const DEFAULT_LEGAL_FILTER: LegalFilterOptions = {
  mode: "majority",
  windowM: 250,
  minRunM: 120,
};

export const LEGAL_SMOOTH_MODES: {
  id: LegalSmoothMode;
  label: string;
  hint: string;
}[] = [
  {
    id: "none",
    label: "Aucun",
    hint: "V_legal brut (snap + OSM) — peut sauter à chaque segment",
  },
  {
    id: "majority",
    label: "Majorité",
    hint: "Valeur postée la plus fréquente dans la fenêtre spatiale — coupe les plaques parasites",
  },
  {
    id: "min",
    label: "Min",
    hint: "Plus bas panneau dans la fenêtre — conservateur (sécurité)",
  },
  {
    id: "mean_snap",
    label: "Moy. + snap",
    hint: "Moyenne glissante puis re-snap aux panneau 30/50/70/…",
  },
];

export const LEGAL_WINDOW_OPTIONS_M = [100, 150, 250, 400, 600] as const;
export const LEGAL_MIN_RUN_OPTIONS_M = [0, 50, 80, 120, 200] as const;

export const LEGAL_WINDOW_M_MIN = 0;
export const LEGAL_WINDOW_M_MAX = 1000;
export const LEGAL_MIN_RUN_M_MIN = 0;
export const LEGAL_MIN_RUN_M_MAX = 500;

export function clampLegalWindowM(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_LEGAL_FILTER.windowM;
  return Math.min(LEGAL_WINDOW_M_MAX, Math.max(LEGAL_WINDOW_M_MIN, Math.round(raw)));
}

export function clampLegalMinRunM(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_LEGAL_FILTER.minRunM;
  return Math.min(
    LEGAL_MIN_RUN_M_MAX,
    Math.max(LEGAL_MIN_RUN_M_MIN, Math.round(raw))
  );
}

export function normalizeLegalFilter(
  raw: Partial<LegalFilterOptions> | null | undefined
): LegalFilterOptions {
  const mode =
    raw?.mode && LEGAL_SMOOTH_MODES.some((m) => m.id === raw.mode)
      ? raw.mode
      : DEFAULT_LEGAL_FILTER.mode;
  return {
    mode,
    windowM: clampLegalWindowM(
      raw?.windowM ?? DEFAULT_LEGAL_FILTER.windowM
    ),
    minRunM: clampLegalMinRunM(
      raw?.minRunM ?? DEFAULT_LEGAL_FILTER.minRunM
    ),
  };
}

export function legalFilterKey(opts: LegalFilterOptions): string {
  const o = normalizeLegalFilter(opts);
  return `${o.mode}:${o.windowM}:${o.minRunM}`;
}

export function resolveLegalFilter(opts: LegalFilterOptions): {
  mode: LegalSmoothMode;
  windowM: number;
  minRunM: number;
} {
  const o = normalizeLegalFilter(opts);
  return {
    mode: o.mode,
    windowM: o.windowM,
    minRunM: o.minRunM,
  };
}
