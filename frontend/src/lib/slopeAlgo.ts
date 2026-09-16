/** Slope / elevation processing options (corridor build). */

export type SlopeSmoothPreset = "fine" | "normal" | "avl" | "strong";

export type SlopeAlgoOptions = {
  /** Spatial-Z (+ SG polish) strength on DEM altitude. */
  smoothPreset: SlopeSmoothPreset;
  /**
   * Max |dz/ds| before linear repair (rise/run).
   * 0.15 ≈ 15 % grade (default). Large values ≈ disable DEM step clamp.
   */
  maxGrade: number;
  /**
   * Hard floor on resulting slope (% grade). Null = no floor.
   * Example: -12 keeps descents from going steeper than −12 %.
   */
  alphaMinPct: number | null;
  /** Hard ceiling on resulting slope (% grade). Null = no ceiling. */
  alphaMaxPct: number | null;
  /**
   * Trapezoid segment length L (m) for piecewise slope aggregation.
   * Default 50 m. Backend builds slope_profile bands from these traps.
   */
  trapLengthM: number;
};

export const DEFAULT_SLOPE_ALGO: SlopeAlgoOptions = {
  /** Calibrated on AVL CRUISE N90 Bourg-St-Maurice → Albertville. */
  smoothPreset: "avl",
  maxGrade: 0.15,
  alphaMinPct: null,
  alphaMaxPct: null,
  trapLengthM: 50,
};

/** Idle delay before auto-rebuild when contraintes params change (ms). */
export const CONSTRAINTS_REBUILD_DEBOUNCE_MS = 2500;

/** Preset buttons for trapezoid length L (m). */
export const TRAP_LENGTH_OPTIONS: {
  value: number;
  label: string;
  hint: string;
}[] = [
  { value: 25, label: "25 m", hint: "Trapèzes courts — plus de détail" },
  { value: 50, label: "50 m", hint: "Réf. AVL N90 — paliers cohérents" },
  { value: 75, label: "75 m", hint: "Un peu plus moyenné" },
  { value: 100, label: "100 m", hint: "Trapèzes larges — pente moyennée" },
  { value: 200, label: "200 m", hint: "Très large — profil lissé" },
];

export const TRAP_LENGTH_M_MIN = 10;
export const TRAP_LENGTH_M_MAX = 500;

export function clampTrapLengthM(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_SLOPE_ALGO.trapLengthM;
  return Math.min(
    TRAP_LENGTH_M_MAX,
    Math.max(TRAP_LENGTH_M_MIN, Math.round(raw))
  );
}

/**
 * Spatial-Z presets.
 * AVL N90 (54 km, slope −7.2…+6.7 %, zero abrupt steps): autocorr ~1/e ≈ 250–300 m;
 * trap L=50 m keeps within-band RMSE ≈ 0.16 % like the AVL profile.
 */
export const SLOPE_SMOOTH_PRESETS: {
  id: SlopeSmoothPreset;
  label: string;
  /** Short label with maths for UI buttons. */
  valueLabel: string;
  hint: string;
  /** Odd SG polish window (sample count), raised further if span needs it. */
  smoothWindow: number;
  /** Spatial MA window on Z along S (m) — primary anti-sawtooth filter. */
  sgMinSpanM: number;
  /** Polynomial order (backend default / contract). */
  polyorder: number;
  /** Optional recommended trap length when selecting this preset. */
  suggestedTrapLengthM?: number;
}[] = [
  {
    id: "fine",
    label: "Fin",
    valueLabel: "Z±40 m",
    hint: "Moyenne Z 80 m — détail DEM (peut garder du bruit)",
    smoothWindow: 5,
    sgMinSpanM: 80,
    polyorder: 3,
    suggestedTrapLengthM: 25,
  },
  {
    id: "normal",
    label: "Normal",
    valueLabel: "Z±75 m",
    hint: "Moyenne Z 150 m — compromis Studio générique",
    smoothWindow: 11,
    sgMinSpanM: 150,
    polyorder: 3,
    suggestedTrapLengthM: 50,
  },
  {
    id: "avl",
    label: "AVL N90",
    valueLabel: "Z±125 m",
    hint:
      "Calé sur Simulation_BCB N90 BSM→Albertville : longueur de corrélation ~250 m, paliers 50 m, grades ±7 %",
    smoothWindow: 15,
    sgMinSpanM: 250,
    polyorder: 3,
    suggestedTrapLengthM: 50,
  },
  {
    id: "strong",
    label: "Vallée",
    valueLabel: "Z±150 m",
    hint: "Moyenne Z 300 m — très lisse, peu de micro-relief",
    smoothWindow: 21,
    sgMinSpanM: 300,
    polyorder: 3,
    suggestedTrapLengthM: 100,
  },
];

/** Preset buttons for DEM |dz/ds| clamp (rise/run). */
export const MAX_GRADE_OPTIONS: {
  value: number;
  label: string;
  hint: string;
}[] = [
  {
    value: 0.15,
    label: "15 %",
    hint: "Défaut — AVL N90 reste dans ±7 %, largement OK",
  },
  {
    value: 0.25,
    label: "25 %",
    hint: "Alpin — fortes descentes/montées",
  },
  {
    value: 0.4,
    label: "40 %",
    hint: "Très permissif",
  },
  {
    value: 1.0,
    label: "100 %",
    hint: "Presque sans réparation DEM",
  },
  {
    value: 5.0,
    label: "500 %",
    hint: "Pratiquement sans clamp DEM",
  },
];

export const MAX_GRADE_PCT_MIN = 1;
export const MAX_GRADE_PCT_MAX = 2000;

export function gradeToPct(riseRun: number): number {
  return Math.round(riseRun * 1000) / 10; // 1 decimal
}

export function pctToGrade(pct: number): number {
  return pct / 100;
}

export function resolveSlopeAlgo(opts: SlopeAlgoOptions): {
  smoothWindow: number;
  sgMinSpanM: number;
  maxGrade: number;
  alphaMinPct: number | null;
  alphaMaxPct: number | null;
  trapLengthM: number;
} {
  const preset =
    SLOPE_SMOOTH_PRESETS.find((p) => p.id === opts.smoothPreset) ??
    SLOPE_SMOOTH_PRESETS.find((p) => p.id === "avl") ??
    SLOPE_SMOOTH_PRESETS[1];
  let minPct = opts.alphaMinPct;
  let maxPct = opts.alphaMaxPct;
  if (
    minPct != null &&
    maxPct != null &&
    Number.isFinite(minPct) &&
    Number.isFinite(maxPct) &&
    minPct > maxPct
  ) {
    const t = minPct;
    minPct = maxPct;
    maxPct = t;
  }
  return {
    smoothWindow: preset.smoothWindow,
    sgMinSpanM: preset.sgMinSpanM,
    maxGrade: Math.min(
      MAX_GRADE_PCT_MAX / 100,
      Math.max(MAX_GRADE_PCT_MIN / 100, opts.maxGrade)
    ),
    alphaMinPct: minPct,
    alphaMaxPct: maxPct,
    trapLengthM: clampTrapLengthM(opts.trapLengthM),
  };
}

export function slopeAlgoKey(opts: SlopeAlgoOptions): string {
  const r = resolveSlopeAlgo(opts);
  return `${opts.smoothPreset}:${r.smoothWindow}:${r.sgMinSpanM}:${r.maxGrade}:${r.alphaMinPct ?? "∅"}:${r.alphaMaxPct ?? "∅"}:L${r.trapLengthM}`;
}

export function slopeAlgoEqual(
  a: SlopeAlgoOptions,
  b: SlopeAlgoOptions
): boolean {
  return slopeAlgoKey(a) === slopeAlgoKey(b);
}

/** Migrate older session snapshots missing clip / trap fields. */
export function normalizeSlopeAlgo(
  raw: Partial<SlopeAlgoOptions> | null | undefined
): SlopeAlgoOptions {
  const presetRaw = raw?.smoothPreset;
  const smoothPreset: SlopeSmoothPreset =
    presetRaw === "fine" ||
    presetRaw === "normal" ||
    presetRaw === "avl" ||
    presetRaw === "strong"
      ? presetRaw
      : DEFAULT_SLOPE_ALGO.smoothPreset;
  return {
    smoothPreset,
    maxGrade: raw?.maxGrade ?? DEFAULT_SLOPE_ALGO.maxGrade,
    alphaMinPct: raw?.alphaMinPct === undefined ? null : raw.alphaMinPct,
    alphaMaxPct: raw?.alphaMaxPct === undefined ? null : raw.alphaMaxPct,
    trapLengthM: clampTrapLengthM(
      raw?.trapLengthM ?? DEFAULT_SLOPE_ALGO.trapLengthM
    ),
  };
}
