/**
 * Démo GitHub Pages vs builds locaux / prod avec API.
 *
 * Contrat :
 * - Le code partagé conserve HERE + Mapbox + OSRM (UI, types, analyze).
 * - Sur Pages (`NEXT_PUBLIC_DEMO_OSRM_ONLY=1` ou legacy `NEXT_PUBLIC_DISABLE_HERE=1`) :
 *   seul OSRM est coché / activable — aucune clé HERE/Mapbox côté navigateur,
 *   et on ne propose pas d’appeler ces routeurs depuis la démo live.
 * - Les clés restent serveur (`HERE_API_KEY`, `MAPBOX_ACCESS_TOKEN` dans le backend).
 */

function envFlagTrue(name: string): boolean {
  const v = (process.env[name] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Démo live : routeurs payants / à clé désactivés dans l’UI. */
export function isDemoOsrmOnly(): boolean {
  return (
    envFlagTrue("NEXT_PUBLIC_DEMO_OSRM_ONLY") ||
    envFlagTrue("NEXT_PUBLIC_DISABLE_HERE") // legacy alias
  );
}

/** @deprecated Prefer isDemoOsrmOnly — alias conservé pour CycleGenShell. */
export function isHereDisabled(): boolean {
  return isDemoOsrmOnly();
}

/**
 * Trajet GPS utilisable sur Pages même sans FastAPI :
 * géocode Photon + route OSRM publics (client).
 */
export function canUseGpsStudio(): boolean {
  const apiUrl = (process.env.NEXT_PUBLIC_API_URL || "").trim();
  return Boolean(apiUrl) || isDemoOsrmOnly();
}

/** Pas d’API FastAPI → client OSRM/Photon pour geocode / analyze / corridor. */
export function useDemoOsrmClient(): boolean {
  const apiUrl = (process.env.NEXT_PUBLIC_API_URL || "").trim();
  return !apiUrl && isDemoOsrmOnly();
}

/** Profils routeur exposés à Sidebar (Pages : OSRM seul). */
export function pagesRouterAvailability(): {
  here: boolean;
  mapbox: boolean;
  osrm: boolean;
} {
  if (isDemoOsrmOnly()) {
    return { here: false, mapbox: false, osrm: true };
  }
  // Builds locaux / API branchée : les trois restent disponibles ;
  // le backend dira « clé absente » si le secret n’est pas configuré.
  return { here: true, mapbox: true, osrm: true };
}
