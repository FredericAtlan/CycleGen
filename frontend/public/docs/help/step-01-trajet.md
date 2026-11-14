# Étape 1 — Trajet

> Objectif : définir **où** et **quand** rouler. Aucun cycle \(v(t)\) n’est encore généré — seulement l’acquisition spatiale (géométrie, vitesses de référence, DEM, feux OSM).

## Flux UI

```text
┌──────────────────────────────────────────────────────────────┐
│  SIDEBAR · Trajet                                            │
│  1. Départ (A)  — adresse / GPS / clic carte                 │
│  2. Arrivée (B) — idem                                       │
│  3. Waypoints   — points intermédiaires optionnels           │
│  4. Routeurs (HERE + secours)                                │
│       ☑ HERE / ADAS         (défaut — maxSpeed + Z 3D)       │
│       ☐ Mapbox / Traffic    (secours / multi-compare)        │
│       ☐ OSRM (free-flow)    (secours / multi-compare)        │
│  5. Heure départ (depart_at) — congestion Mapbox             │
│  CTA → « Calculer l’itinéraire »                             │
└──────────────────────────┬───────────────────────────────────┘
                           │ POST /api/route/analyze
                           │  ↳ routing_profiles: […]  (HERE
                           │     puis Mapbox → OSRM en secours ;
                           │     multi-compare si ≥2 cochés)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  CARTE                                                       │
│  Polyligne · A/B · altitudes A/B si DEM OK                   │
│  Badge traffic_source : mapbox_traffic | osrm_freeflow       │
└──────────────────────────────────────────────────────────────┘
```

Les paramètres sont regroupés en accordéons (Points A/B, Itinéraire & routeur, Arrêts). Le CTA reste hors des panneaux.

---

## Mapbox et OSRM

CycleGen ne calcule pas le plus court chemin en interne : il interroge un **routeur externe**, puis enrichit la réponse (feux OSM, altitude DEM, structures pont/tunnel).

```text
┌─────────────────────┐         ┌─────────────────────┐
│       Mapbox        │         │        OSRM         │
│  Directions API     │         │  Project OSRM /     │
│  (commercial)       │         │  instance publique  │
├─────────────────────┤         ├─────────────────────┤
│ • Graphe routier    │         │ • Graphe OSM        │
│ • driving-traffic   │         │ • Profil « car »    │
│ • Congestion selon  │         │ • Free-flow seul    │
│   depart_at (UTC)   │         │ • Pas de modèle     │
│ • Annotations       │         │   horaire           │
│   maxspeed / durée  │         │                     │
└──────────┬──────────┘         └──────────┬──────────┘
           │                               │
           └─────────────┬─────────────────┘
                         ▼
              CycleGen (data_fetcher)
              + Overpass + DEM
```

---

### Mapbox — plateforme, API, tokens et facturation

Mapbox est une plateforme de cartographie et de données de localisation pour développeurs, souvent présentée comme alternative à Google Maps. Pour CycleGen, l’intérêt principal est la **surcouche de données de trafic** (historiques et temps réel) appliquée sur la topologie OpenStreetMap, via le profil Directions `driving-traffic`.

Dans CycleGen, le navigateur **n’appelle pas** Mapbox directement : le front envoie `POST /api/route/analyze` au backend FastAPI, qui appelle Mapbox avec `MAPBOX_ACCESS_TOKEN`. La carte Leaflet utilise des tuiles **OpenStreetMap**, pas les Map Loads Mapbox.

#### 1. API Directions & Routing

L’API fonctionne en HTTP REST et renvoie du JSON. Point d’entrée utilisé : **Directions**, profil **`mapbox/driving-traffic`**.

Requête type (simplifiée) — coordonnées A → B, heure de départ, token :

```text
GET https://api.mapbox.com/directions/v5/mapbox/driving-traffic/
    {lon_A},{lat_A};{lon_B},{lat_B}
    ?depart_at=2026-09-04T08:30
    &access_token=pk.VOTRE_TOKEN
```

(CycleGen construit cette URL côté backend dans `mapbox_router.py`, avec annotations de vitesse / durée segment.)

Réponse JSON utile :

| Élément | Usage CycleGen |
|---------|----------------|
| Géométrie du trajet | Polyligne Leaflet |
| Distance / durée totale | KPIs itinéraire |
| Instructions turn-by-turn | Non utilisées en cœur Studio |
| **Vitesses / durées par segment** | \(V_{legal}\), \(V_{traffic}\) selon la congestion à `depart_at` |

| Aspect UI | Détail |
|-----------|--------|
| **Profil UI** | « Mapbox / Traffic » |
| **Trafic** | Oui — durée segment dépend de `depart_at` (UTC) |
| **\(V_{legal}\)** | Vitesse « panneau » (annotations / dérivation segment) |
| **\(V_{traffic}\)** | Vitesse fluide \(d / \mathrm{duration}\), en général bornée par \(V_{legal}\) |
| **Badge** | `traffic_source = "mapbox_traffic"` |

\(V_{legal}\) et \(V_{traffic}\) sont deux enveloppes distinctes : borne réglementaire / de référence vs débit estimé à l’heure de départ.

#### 2. Tokens

Un **token** relie chaque appel API au compte de facturation Mapbox. Deux familles :

| Type | Préfixe | Usage |
|------|---------|--------|
| **Public Access Token** | `pk.…` | Peut être exposé côté client **si** l’app appelle Mapbox depuis le navigateur. À restreindre par **URL Restrictions** dans le dashboard Mapbox (ex. `localhost`, domaine de prod). |
| **Secret Access Token** | `sk.…` | Droits étendus (uploads, admin). **Jamais** dans le frontend ni un dépôt public. |

**CycleGen :** configurer `MAPBOX_ACCESS_TOKEN` dans le `.env` du **backend** (voir `.env.example`). Un token public Directions (`pk.…`) suffit en général pour le routage `driving-traffic`. Ne pas mettre de `sk.…` dans le code front React.

```text
# .env (backend)
MAPBOX_ACCESS_TOKEN=pk.…
```

Sans token (ou en échec Mapbox) → repli OSRM free-flow + warning UI.

#### 3. Limites et facturation

Mapbox est en **pay-as-you-go** avec un **free tier** mensuel. Les chiffres ci-dessous sont indicatifs (vérifier le tarif courant sur le site Mapbox) :

| Service Mapbox | Quota gratuit mensuel (indicatif) | Au-delà (indicatif) |
|----------------|-----------------------------------|---------------------|
| **Directions API** (routage) | ~100 000 requêtes / mois | ~2,00 $ / 1 000 req |
| **Map Loads** (fond de carte Mapbox) | ~50 000 affichages / mois | ~5,00 $ / 1 000 affichages |

Pour CycleGen aujourd’hui :

- Chaque « Calculer l’itinéraire » ≈ **1 requête Directions** (plus si waypoints / retries).
- Les **Map Loads** Mapbox ne sont en principe **pas** consommés (tuiles OSM Leaflet).
- **Rate limit** Directions (ordre de grandeur) : ~**300 requêtes / minute**. Bloquant surtout en batch massif, pas en usage Studio interactif.

En pratique : un compte gratuit + token Directions dans le `.env` backend suffit pour développer, tester (ex. Grossglockner) et un usage interne d’équipe sans volume batch.

---

### OSRM — Open Source Routing Machine

OSRM (*Open Source Routing Machine*) est un moteur de calcul d’itinéraires **open source**, conçu pour fonctionner avec les données cartographiques **OpenStreetMap (OSM)**. Il est réputé pour sa latence très faible grâce à des structures précalculées (notamment les *Contraction Hierarchies*), ce qui permet un plus court chemin (éventuellement via waypoints) en quelques millisecondes, même à grande échelle.

Historiquement, Mapbox a appuyé une partie de son routage sur OSRM avant d’évoluer vers ses propres services (dont `driving-traffic`).

Dans CycleGen, le front n’appelle pas OSRM directement : `POST /api/route/analyze` → backend → `OSRM_BASE_URL` (défaut `https://router.project-osrm.org`).

#### 1. Fonctionnement de l’API

Comme Mapbox, c’est du HTTP REST + JSON. Requête type (profil `driving`) :

```text
GET http://router.project-osrm.org/route/v1/driving/
    {lon_A},{lat_A};{lon_B},{lat_B}
    ?overview=full&geometries=geojson
```

(CycleGen construit l’appel côté backend dans `osrm_router.py`.)

| Élément de réponse | Usage CycleGen |
|--------------------|----------------|
| Géométrie (GeoJSON / polyline) | Polyligne Leaflet |
| Distance / durée théorique | KPIs ; vitesses free-flow |
| Instructions turn-by-turn | Non utilisées en cœur Studio |
| Vitesses de référence OSM | \(V_{legal}\) ; \(V_{traffic} \equiv V_{legal}\) |

**Différence majeure avec Mapbox :** OSRM de base **ne gère pas** le trafic temps réel ni historique. La durée suppose une route **toujours fluide** (vitesses légales / free-flow OSM).

**Altitude :** le serveur public OSRM standard **ne fournit pas** le profil topographique utilisé par CycleGen. L’altitude \(z(s)\) vient de la chaîne **DEM** CycleGen (Open-Meteo → …) après le routage — Mapbox ou OSRM.

| Aspect UI | Détail |
|-----------|--------|
| **Profil UI** | « Car / OSRM » |
| **Trafic** | Non — `depart_at` **n’influence pas** la congestion |
| **Vitesses** | \(V_{traffic} \equiv V_{legal}\) |
| **Badge** | `traffic_source = "osrm_freeflow"` + warning UI |

#### 2. Déploiement : public vs auto-hébergé

OSRM n’est pas un SaaS payant : c’est un **logiciel libre**. Deux modes :

**Option A — Serveur public de démonstration** (`router.project-osrm.org`)

| Aspect | Détail |
|--------|--------|
| Coût | Gratuit — pas de compte ni de token |
| Limites | Rate limit strict (souvent ~**1 req/s**), pas de requêtes de masse, **pas de SLA** |
| CycleGen | Défaut actuel via `OSRM_BASE_URL` — adapté au **prototypage**, fragile en prod intensive |

**Option B — Auto-hébergement (Docker / serveur local)**

| Aspect | Détail |
|--------|--------|
| Principe | Installer OSRM, charger un extrait OSM (ex. France, Autriche), router en local |
| Coût | 0 € hors machine / serveur |
| Limites | Aucune quota éditeur — le débit dépend de votre CPU / RAM |
| CycleGen | Pointer `OSRM_BASE_URL` vers votre instance — choix robuste **sans** besoin de bouchons |

```text
# .env (backend)
OSRM_BASE_URL=https://router.project-osrm.org
# ou http://localhost:5000  (instance Docker auto-hébergée)
```

#### 3. Mapbox ou OSRM dans CycleGen ?

Proposer les deux au wizard (étape 1 · choix du routeur) couvre des cas d’usage distincts :

| Besoin | Routeur recommandé | Pourquoi |
|--------|--------------------|----------|
| **Urbain / périurbain avec congestion** (ex. Richebourg → Houdan à 08h30) | **Mapbox** `driving-traffic` | \(V_{traffic}\) intègre les ralentissements à `depart_at` |
| **Haute montagne / free-flow** (Grossglockner, Iseran, Stelvio) | **OSRM** | Peu de « bouchons » urbains ; la vitesse utile est surtout contrainte par **topologie** (virages \(V_{curve}\), pente \(\alpha\)) après le routage ; OSRM est rapide et sans token |

Dans les deux cas, CycleGen enrichit ensuite : Overpass (feux / structures) + DEM (altitude) + solveur cinématique (étape 3).

### Sélection du routeur

```text
Profil UI = Mapbox/Traffic ?
        │
        ├─ oui + token OK + réponse OK ──► Mapbox driving-traffic
        │                                   traffic_source=mapbox_traffic
        │
        └─ non / échec / pas de token ───► OSRM car
                                            traffic_source=osrm_freeflow
                                            warning explicite
```

Choix explicite « Car / OSRM » → OSRM même si un token Mapbox est présent.

---

## Localisation des points A / B

| Entrée | Traitement |
|--------|------------|
| Adresse textuelle | `POST /api/geocode` → lat/lon (+ altitude DEM si disponible) |
| Coordonnées `lat, lon` | Parsing local puis validation / elevation |
| Clic carte | Pose A ou B (ou waypoint) selon le mode clic |

Les altitudes A/B affichées dans la sidebar viennent du DEM (lookup ponctuel). Elles peuvent différer légèrement de \(z(s)\) le long du tracé après construction du cycle (étape 2).

---

## API CycleGen (étape Trajet)

Le front **ne parle pas** directement à Mapbox/OSRM. Tout passe par FastAPI.

| Méthode | Chemin | Rôle |
|---------|--------|------|
| `POST` | `/api/geocode` | Adresse → lat/lon (+ altitude) |
| `POST` | `/api/elevation` | Lookup DEM pour points UI |
| `POST` | `/api/route/analyze` | **Cœur étape 1** — itinéraire enrichi |

### Corps typique de `POST /api/route/analyze`

```text
{
  origin, destination,          // LatLon
  waypoints[],                  // optionnels + stop_duration_s
  depart_at,                    // ISO datetime (trafic Mapbox)
  routing_profile,              // mapbox_traffic | osrm | …
  a_y_mps2                      // stocké pour V_curve (étapes 2–3)
}
```

### Chaîne backend

```text
UI ──POST /api/route/analyze──► routes_route.analyze_route
                                      │
                                      ▼
                               SpatialDataAcquisition
                               (data_fetcher.py)
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
              MapboxRouter      (fallback)         Overpass
              ou OSRMRouter       OSRM          feux / ponts
                    │                                   │
                    └────────────┬──────────────────────┘
                                 ▼
                           DEM elevations
                           (chaîne Open-Meteo → …)
                                 │
                                 ▼
                      RouteAnalyzeResponse
                      • geometry[]
                      • segment_distances_m / speeds
                      • segment_traffic_speeds_mps
                      • elevations_m[]
                      • traffic_signals[]
                      • road_structures[]
                      • traffic_source
                      • warnings[]
```

### Champs consommés par l’UI

| Champ | Usage |
|-------|--------|
| `geometry` | Polyligne carte |
| `segment_*_speeds` | → \(V_{legal}\), \(V_{traffic}\) au build cycle (étape 2) |
| `elevations_m` | → pente \(\alpha\) (étape 2) |
| `traffic_signals` | → \(S_{\mathrm{feux}}\) |
| `road_structures` | Correction altitude pont / tunnel |
| `traffic_source` | Badge / confiance trafic |
| `warnings` | Fallback OSRM, DEM plat, etc. |

Code : `routes_route.py`, `data_fetcher.py`, `routing/mapbox_router.py`, `routing/osrm_router.py`.

---

## Données dérivées (après analyze)

| Donnée | Calcul / source | Unité |
|--------|-----------------|-------|
| Géométrie | Mapbox ou OSRM | lat/lon |
| \(S\) (étape 2) | Cumul des longueurs de segments | m |
| \(V_{legal}\) | annotations / vitesses de référence | m/s |
| \(V_{traffic}\) | \(d/\mathrm{duration}\) à `depart_at` (Mapbox) ou = \(V_{legal}\) (OSRM) | m/s |
| \(z(s)\) | DEM échantillonné + interpolé | m |
| Feux OSM | Overpass `highway=traffic_signals` | points |
| Structures | Overpass pont / tunnel | segments |

---

## Impacts des paramètres UI

| Paramètre UI | Impact |
|--------------|--------|
| **Profil Mapbox/Traffic** | Active congestion horaire si token OK |
| **Profil Car/OSRM** | Force free-flow ; `depart_at` n’agit pas sur le trafic |
| **`depart_at`** | Change \(V_{traffic}\) **Mapbox** — **ne change pas** la géométrie |
| **Waypoints** | Force le passage ; allonge le trajet ; plus de feux / relief |
| **Clic carte vs adresse** | Même `analyze` ; geocode seulement pour remplir lat/lon |
| **`a_y`** | Pas d’effet visible ici ; transmis pour \(V_{curve}\) plus tard |

---

## Limites techniques

- Mapbox trafic = modèle commercial externe, pas une flotte GPS CycleGen.
- OSRM public = free-flow OSM ; latence et quotas possibles.
- DEM public ≠ levé topographique de chantier.
- Annotations « legal » Mapbox ≠ inventaire exhaustif des panneaux OSM `maxspeed`.
- Sans token Mapbox valide → fallback OSRM (badge + warning).
- Modifier A/B, waypoints, routeur ou `depart_at` **invalide** le cycle spatial et le profil \(v(t)\) déjà calculés : il faut relancer analyze → build → simulate.

## Suite

Après analyse réussie → **Contraintes** (étape 2) : `POST /api/corridor/build` construit \(S, \alpha, V_{\mathrm{envelope}}, S_{\mathrm{feux}}\) à partir de cette réponse.
