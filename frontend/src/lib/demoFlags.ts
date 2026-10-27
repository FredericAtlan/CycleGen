/**
 * Flags démo GitHub Pages / builds sans clé HERE.
 * NEXT_PUBLIC_DISABLE_HERE=1 → radio HERE grisée, défaut OSRM.
 */
export function isHereDisabled(): boolean {
  const v = (process.env.NEXT_PUBLIC_DISABLE_HERE || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Profils routeur disponibles côté UI (Pages : OSRM seul). */
export function pagesRouterAvailability(): {
  here: boolean;
  mapbox: boolean;
  osrm: boolean;
} {
  if (isHereDisabled()) {
    return { here: false, mapbox: false, osrm: true };
  }
  return { here: true, mapbox: true, osrm: true };
}
