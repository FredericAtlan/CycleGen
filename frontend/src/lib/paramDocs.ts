/** Scientific definitions for driver / IDM parameters (UI info tips). */

export const DRIVER_PARAM_DOCS = {
  a_max: {
    title: "a_max — accélération max",
    body: "Plafond d’accélération en ligne droite dégagée (m/s²).",
  },
  b_comf: {
    title: "b_comf — freinage confort",
    body: "Force de freinage nominale anticipée, hors urgence (m/s²).",
  },
  speed_factor: {
    title: "Speed factor",
    body: "Tolérance vs limite (0,9 = prudent, 1,1 = +10 %).",
  },
  overspeed_pct: {
    title: "Dépassement limites",
    body: "Écart relatif à l’enveloppe locale en % (legacy Sport).",
  },
  jerk_max: {
    title: "Jerk+ — attaque accélérateur",
    body: "Vitesse d’enfoncement de la pédale d’accélérateur (m/s³).",
  },
  max_speed: {
    title: "Vmax véhicule",
    body: `Cap dur après enveloppe × speed factor (km/h). Vide = pas de cap.`,
  },
  a_y: {
    title: "a_y — latéral",
    body: "Tolérance centrifuge en courbe : V = √(a_y · R) (m/s²).",
  },
} as const;
