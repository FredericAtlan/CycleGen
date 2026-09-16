# 01 — Routage et enveloppe de trafic

## 1. Pourquoi

Un cycle A→B sans notion d’heure ni de congestion est souvent trop « libre » : on roule à la limite légale partout. Or en heure de pointe, la vitesse réalisée est **inférieure** à \(V_{legal}\).

CycleGen introduit donc deux champs de vitesse le long de l’itinéraire :

- \(V_{legal}(s)\) — ce que la route « autorise / annonce »
- \(V_{traffic}(s)\) — ce que le trafic **permet** à l’instant `depart_at`

## 2. Entrées utilisateur

| Champ | Obligatoire | Rôle |
|-------|-------------|------|
| Coordonnées / adresses A, B | oui | extrémités |
| Waypoints | non | arrêts intermédiaires + `stop_duration_s` |
| `depart_at` | **oui** | horodatage pour le trafic Mapbox |
| `routing_profile` | oui | `Mapbox/Traffic` ou `Car/OSRM` |
| `a_y` | oui (défaut 2,5) | utilisé plus tard pour \(V_{curve}\) |

## 3. Chaîne Mapbox → OSRM

### 3.1 Mapbox `driving-traffic` (primaire)

- Endpoint Directions Mapbox, profil **driving-traffic**
- `depart_at` est envoyé (UTC) pour conditionner la congestion
- Pour chaque segment :
  - vitesse « légale / annotation » → contribution à \(V_{legal}\)
  - vitesse fluide \(d/\mathrm{duration}\) → \(V_{traffic}\), **bornée** par \(V_{legal}\) si disponible

**Source retournée :** `traffic_source = "mapbox_traffic"`.

### 3.2 Fallback OSRM free-flow

Si token Mapbox absent, erreur réseau, ou quota :

- bascule vers OSRM
- `depart_at` **ignoré** (pas de modèle de congestion)
- \(V_{traffic} \equiv V_{legal}\) (free-flow)
- warning + `traffic_source = "osrm_freeflow"`

### 3.3 Relation entre \(V_{legal}\) et \(V_{traffic}\)

\(V_{legal}\) reflète la signalisation et les annotations routières ; \(V_{traffic}\) est dérivée du rapport distance/durée Mapbox à l’horodatage `depart_at`, donc la vitesse moyenne compatible avec le trafic observé à cet instant.

Sans Mapbox (fallback OSRM), seule \(V_{legal}\) est disponible et \(V_{traffic}\) lui est identique (free-flow).

## 4. Données annexes (même appel d’analyse)

Après la géométrie :

1. **Overpass (OSM)** — nœuds `highway=traffic_signals`, tags bridge/tunnel/highway  
2. **Élévation** — DEM (Open-Meteo / Open-Elevation) → \(z\) le long de la polyline  

Ces données nourrissent le corridor (chapitre 02), pas encore le cycle \(v(t)\).

## 5. Limites scientifiques

| Affirmation incorrecte | Réalité CycleGen |
|------------------------|------------------|
| « Mapbox = GPS flotte mesurée » | Modèle commercial de trafic |
| « OSRM = trafic temps réel » | Free-flow / annotations |
| « Sans token = même qualité » | Non : badge orange + free-flow |

## 6. Fichiers code

- `backend/app/services/routing/mapbox_router.py`
- `backend/app/services/routing/osrm_router.py`
- `backend/app/services/data_fetcher.py`
- `backend/app/models/schemas.py` (`RouteAnalyzeRequest.depart_at`)
