# Architecture & choix de modèles

> Vue d’ensemble outil + modèles. Complète les fiches Science (`/docs/science/`) et `docs/architecture.md` du dépôt.

## 1. Topologie d’exécution

```text
┌─────────────────────────────────────────────────────────────┐
│  Navigateur                                                 │
│  Next.js (App Router) · Leaflet · Recharts                  │
│  CycleGenShell = orchestre UI + API + WebSocket             │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP /api/*  +  WS /api/simulate/ws/{id}
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  FastAPI                                                    │
│  routes → services → schemas (Pydantic)                     │
└───────────────┬─────────────────────────┬───────────────────┘
                │                         │
                ▼                         ▼
        IDM + Markov                 SUMO (optionnel)
        (toujours dispo)             Docker / TraCI
```

| Processus | Rôle | Ports typiques |
|-----------|------|----------------|
| Frontend Next | UI, état, charts, carte, export Excel | 3000 / 3001 |
| Uvicorn FastAPI | REST + WS | 8000 / 8001 |
| SUMO (compose) | Réseau + TraCI | 8813 |

Aide flottante : panneau ~80 % largeur, hors flux de layout.

## 2. Découpage logiciel

```text
┌─ frontend/src ─────────────────────────────────────────────┐
│  CycleGenShell · Sidebar (étapes 1–4) · MapView            │
│  ResultsAnalysisPanel · HelpDrawer        │
│  lib/api.ts · slopeAlgo · vehiclePower · exportWorkbook    │
└────────────────────────────────────────────────────────────┘

┌─ backend/app ──────────────────────────────────────────────┐
│  api/routes_route.py      analyze, geocode, elevation      │
│  api/routes_corridor.py   build SpatialCorridor            │
│  api/routes_simulate.py   start / WS / consolidate         │
│  api/routes_export.py     CSV / XML profil (API)           │
│  services/data_fetcher.py Mapbox, OSRM, Overpass, DEM      │
│  services/spatial_processor.py  α, enveloppes, feux        │
│  services/kinematic_solver.py   IDM + Markov + TLS         │
│  services/sumo_bridge.py        TraCI (optionnel)          │
└────────────────────────────────────────────────────────────┘
```

## 3. Pipeline de données

```text
┌────────┐   analyze    ┌──────────────┐   build    ┌─────────────────┐
│ Trajet │─────────────►│ RouteAnalyze │───────────►│ SpatialCorridor │
└────────┘              └──────────────┘            └────────┬────────┘
                                                             │
                                                    simulate │
                                                             ▼
                                                    ┌─────────────────┐
                                                    │ Consolidated    │
                                                    │ Profile v(t)…   │
                                                    └─────────────────┘
```

Contrats Pydantic dans `schemas.py` : une seule vérité pour OpenAPI et le front TypeScript.

Invalidation typique : changer l’itinéraire ou le corridor sans regenerer rend le profil \(v(t)\) obsolète.

## 4. Choix de modèles

### 4.1 Routage

| Option | Quand | Pourquoi |
|--------|-------|----------|
| **Mapbox driving-traffic** | Clé dispo | Trafic horaire + géométrie industrielle |
| **OSRM** | Fallback / choix UI | Libre, free-flow |

Hors périmètre Studio : VISSIM / Aimsun (lourds, licences) pour le cœur du parcours guidé.

### 4.2 Topographie

| Choix | Rationale |
|-------|-----------|
| DEM public (Open-Meteo → Open-Elevation → OpenTopoData) | Suffisant pour cycles énergétiques ; pas un levé chantier |
| Correction pont/tunnel + clamp \(\lvert dz/ds\rvert\) + SG | Réduit artefacts DEM sans inventer une topo |
| Clip α min/max optionnel | Scénarios bornés (bornes dures post-calcul) |

### 4.3 Enveloppe de vitesse

\[
V_{\mathrm{envelope}}=\min(V_{\mathrm{legal}}, V_{\mathrm{traffic}}, V_{\mathrm{curve}})
\]

avec \(V_{curve}=\sqrt{a_y R}\) — **confort latéral**, pas frottement pneu.

Le \(\min\) applique la contrainte la plus sévère parmi les sources actives (masques UI).

### 4.4 Micro-simulation

| Moteur | Forces | Limites | Usage |
|--------|--------|---------|-------|
| **IDM + Markov** | Léger, déterministe (seed), TLS maison | Pas de multi-agents riches | Défaut Studio / CI |
| **SUMO/TraCI** | Réseau, interactions | Docker, prep réseau, latence | Trafic avancé |

Si SUMO indisponible → fallback IDM (message explicite).

### 4.5 Feux

| Mode | Principe | Usage |
|------|----------|-------|
| `green_wave` | Coordination simplifiée sur axes primary/trunk | Artère |
| `stochastic` | Tirage / freinage probabiliste | Urbain dense |

Projection stricte (~5 m latéral) pour éviter les feux de voies parallèles.

### 4.6 Véhicule (post-traitement)

Road-load \(F_0,F_1,F_2\) + inertie + grade → \(P,\tau,N_{\mathrm{rpm}}\).

Calcul **après** \(v(t)\) pour analyses énergétiques / export, sans coupler un powertrain complet dans la boucle IDM.

## 5. Hors périmètre

```text
✗ Homologation WLTP / EPA
✗ Jumeau TLS municipal calibré
✗ Carte HD / localisation centimétrique
✗ Optimiseur de trajectoire ADAS
```

CycleGen est un **studio de cycles synthétiques géo-contraints**, reproductible et instrumenté (warnings, KPIs, export traçable, Versus).

## 6. Science détaillée

| Sujet | Fiche |
|-------|-------|
| Pipeline & glossaire | Science · Vue d’ensemble |
| Routage / trafic | Science · Routage & trafic |
| α, enveloppes | Science · Cycle spatial |
| TLS | Science · Feux & TLS |
| IDM / Markov | Science · IDM & Markov |
| SUMO vs IDM | Science · SUMO vs IDM |
| Recalage corpus | Science · Benchmark |
| Limites | Science · Limites & bonnes pratiques |
