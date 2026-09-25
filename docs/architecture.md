# CycleGen — Architecture logicielle

> Document **outil / code** : comment l’application est découpée et branchée.  
> Pour le **modèle scientifique** (équations, enveloppes, IDM, feux), voir [`docs/science/`](science/README.md).

## 1. Objectif produit

CycleGen est un **studio web** qui, à partir d’un trajet A→B (waypoints, horaire, conducteur), produit un **cycle de roulage synthétique** \(v(t)\), \(\alpha(t)\), accélérations, feux — exportable et comparable à un corpus de référence.

Ce n’est pas un jumeau numérique de contrôleur TLS ni une homologation réglementaire.

## 2. Topologie d’exécution

```text
┌─────────────────────────────────────────────────────────────┐
│  Navigateur                                                 │
│  Next.js (App Router) · Leaflet · Recharts                  │
│  CycleGenShell = orchestre UI + appels API + WebSocket      │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTP /api/*  +  WS /api/simulate/ws/{id}
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  FastAPI (backend/app)                                      │
│  routes → services → schemas (Pydantic)                     │
└───────────────┬─────────────────────────┬───────────────────┘
                │                         │
                ▼                         ▼
        IDM + Markov                 SUMO (optionnel)
        (toujours dispo)             Docker / TraCI
```

| Processus | Rôle | Ports typiques (dev) |
|-----------|------|----------------------|
| `frontend` (`npm run dev`) | UI, état client, charts, carte | 3000 / 3001 |
| `uvicorn app.main:app` | API REST + WebSocket simu | 8000 / 8001 |
| `sumo` (compose, optionnel) | Image SUMO + netconvert | 8813 (TraCI) |

Variables utiles : `CORS_ORIGINS`, token Mapbox, `SUMO_*` (voir `.env.example`).

## 3. Organisation du dépôt

```text
CycleGen/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI + CORS + include_router
│   │   ├── api/                 # Routes HTTP par domaine
│   │   ├── models/schemas.py    # Contrats Pydantic (source de vérité API)
│   │   ├── services/            # Métier (pas de logique métier dans les routes)
│   │   └── data/                # Corpus benchmark, TPM Markov, citations
│   ├── tests/
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── app/                 # Next.js App Router (page, layout)
│   │   ├── components/          # UI (shell, carte, corridor, simu, export)
│   │   └── lib/                 # api.ts, types, presets, zones, tripStore
│   └── public/docs/science/     # Miroir docs scientifiques pour l’aide UI
├── sumo/                        # Templates vTypes / sumocfg / prepare_network
├── docs/
│   ├── science/                 # Modèle scientifique
│   └── architecture.md          # ← ce fichier
└── scripts/                     # Import corpus, calibration, cycles réglementaires
```

**Règle de dépendance :** `api` → `services` → `models` / `data`. Les routes restent minces (validation + orchestration).

## 4. Pipeline applicatif (4 étapes)

Aligné sur l’UI (sidebar + panneau droit) et les routers :

| Étape | API | Service principal | Sortie |
|-------|-----|-------------------|--------|
| 1. Route | `POST /api/route/analyze`, geocode | `data_fetcher`, `routing/*`, `geocoder` | Géométrie, vitesses segment, feux OSM, élévation |
| 2. Corridor | `POST /api/corridor/build` | `spatial_processor`, `curvature` | `SpatialCorridor` : \(S\), \(\alpha\), \(V_*\), \(S_{\mathrm{feux}}\) |
| 3. Simulation | `POST /api/simulate/start` + WS | `simulation_manager` → IDM ou `sumo_bridge` | Frames live → `ConsolidatedProfile` |
| 4. Export / bench | `/api/export/*`, `/api/benchmark/*` | export + `benchmark_*` | CSV/XML, KPIs vs corpus |

Scénarios batch (comparaison conducteurs / TLS / caps) : `POST /api/scenario/run` (`routes_scenario.py`), déclenchés depuis le frontend sans onglet dédié.

```text
A/B + depart_at + a_y + conducteur (+ zones)
        │
        ▼
   route/analyze  ──►  corridor/build  ──►  simulate/start
        │                    │                    │
     geometry            V_envelope            IDM | SUMO
     warnings            feux_meta             WebSocket frames
                                                  │
                                                  ▼
                                           ConsolidatedProfile
                                           export / benchmark
```

## 5. Backend — couches

### 5.1 Entrée HTTP (`app/api/`)

| Module | Préfixe | Responsabilité |
|--------|---------|----------------|
| `routes_route.py` | `/api` | Analyse trajet, geocode |
| `routes_corridor.py` | `/api` | Construction corridor |
| `routes_simulate.py` | `/api` | Start / stop / WS |
| `routes_export.py` | `/api` | Téléchargements |
| `routes_benchmark.py` | `/api/benchmark` | Catalogue + comparaison |
| `routes_scenario.py` | `/api` | Bras de scénario multi-params |

### 5.2 Services (`app/services/`)

| Domaine | Fichiers | Notes |
|---------|----------|-------|
| Routage | `routing/mapbox_router.py`, `osrm_router.py` | Mapbox traffic si token, sinon OSRM free-flow + warning |
| Acquisition | `data_fetcher.py` | Overpass (feux, structures), DEM élévation |
| Spatial | `spatial_processor.py`, `curvature.py` | \(S\), \(\alpha\), enveloppes, projection feux 5 m |
| Micro IDM | `kinematic_solver.py`, `markov_noise.py` | Euler IDM + TPM ; params par **zone de distance** optionnelle |
| Orchestration simu | `simulation_manager.py` | Store mémoire, thread SUMO / run IDM sync |
| SUMO | `sumo_bridge.py`, `sumo_session.py` | Prépare workdir, TraCI, fallback IDM |
| Benchmark | `benchmark_loader.py`, `benchmark_metrics.py` | Manifest SHA256, KPIs, hints |
| KPIs profil | `profile_metrics.py` | Stats cycle généré |

### 5.3 Contrats (`app/models/schemas.py`)

Objets centraux :

- `SpatialCorridor` — axe \(S\), pente, vitesses, feux / meta  
- `SimulateStartRequest` — profil conducteur, overrides, **`driver_zones`**, TLS  
- `ConsolidatedProfile` — séries temporelles consolidées + warnings  
- `BenchmarkSourceMeta` — catalogue corpus (stats, zones, provenance)

Tout client TypeScript (`frontend/src/lib/types.ts`) doit rester aligné sur ces DTO.

### 5.4 Données embarquées

- `data/benchmark/` — CSV corpus + `manifest.json` + `CITATIONS.md`  
- `data/markov/` — TPM Eco / Normal / Agressif / Sportif  
- Calibration GPS : `data/benchmark/calibration/`

## 6. Frontend — architecture UI

### 6.1 Shell

`CycleGenShell.tsx` est le **cerveau client** :

- état du pipeline (`stage` : route → corridor → simulating → completed) ;
- paramètres conducteur / enveloppe / feux / **zones distance** ;
- appels `lib/api.ts` ;
- WebSocket via `useSimulationSocket` ;
- sync carte ↔ graphes (`mapFocus`, curseur temps, brush) ;
- dirty params → bouton **Appliquer** (pas d’auto-regen à chaque slider).

Layouts : `map` | `split` | `analysis` (`LayoutToggle`) — la sidebar gauche reste visible.

Page dédiée **`/compare`** (`CompareStudio`) : bibliothèque de cycles (corpus + enregistrés), cartes caractéristiques, graphes de comparaison (v, a_lon, a_lat, pente, limites).

### 6.2 Découpage composants

| Zone | Composants | Rôle |
|------|------------|------|
| Gauche | `Sidebar`, `SimParamsPanel`, `DriverZonesEditor` | Trajet, enveloppe, conducteur, zones, Générer / Appliquer |
| Centre | `DynamicMap` / `MapView`, contrôles caméra / couches | Carte, ego, feux, focus range |
| Droite | `ConstraintWorkspace` (step 2) · `ResultsAnalysisPanel` (step 4) | Contraintes, analyse, export |
| Persist | `tripStore` / IndexedDB profils | Sauvegardes locales, injecter un cycle référence |
| Aide | `HelpDrawer` + `public/docs/science/*` | Doc scientifique embarquée |

### 6.3 Bibliothèques client (`src/lib/`)

- `api.ts` — client HTTP typé  
- `driverPresets.ts` / `driverZones.ts` — Eco…Sportif + splits distance  
- `corridorEdit.ts` — édition feux / masque enveloppe côté client  
- `tripStore.ts` — persistance locale des trajets  
- `scenarios.ts` — catalogue A–I (chips comparaison)

## 7. Moteurs de simulation

```text
create_simulation(engine)
        │
        ├─ engine=idm  ou  SUMO indisponible  →  IDMSolver (sync)
        └─ engine=sumo + SumoBridge.available → thread TraCI
                    └─ échec réseau / TraCI → fallback IDM
```

- **IDM** : référence CycleGen pour itérations rapides, zones conducteur, Markov.  
- **SUMO** : même corridor ; vTypes dans `sumo/templates/vtypes.add.xml` (Eco / Normal / Agressif / Sportif).

Les frames sont bufferisées dans `SimulationRecord` et rejouées sur le WebSocket.

## 8. Corpus & traçabilité

- Catalogue : `GET /api/benchmark/sources` (familles : `oem`, `regulatory`, `ved`, `geolife`, `demo`).  
- Chaque entrée peut porter `source`, `added_at`, `stats`, `zones`, `zone_split`, `citation`.  
- Exemple OEM : `renault_grossglockner_route_planner` (profil officiel + 2 zones distance).  
- Comparaison : `POST /api/benchmark/run` → RMSE/MAE, hints de recalage.

## 9. Paramètres conducteur & zones

1. **Profil global** (Eco / Normal / Agressif / Sportif) + overrides `a_max`, `b_comf`, `speed_factor`, Vmax, \(a_y\).  
2. **Option zones** (`driver_zones`) : intervals \([s_0, s_1)\) avec params IDM locaux ; l’IDM sélectionne la zone contenant \(s\) ego.  
3. \(a_y\) par zone est stocké comme **hint** ; l’enveloppe courbe reste globale (rebuild corridor unique) dans l’état actuel.

Après une première génération, les changements de params mettent l’UI en **dirty** ; l’utilisateur clique **Appliquer** pour relancer le lot.

## 10. Contrats de non-régression

- Tests backend : `backend/tests/` (métriques, Markov, spatial, élévation).  
- Manifest benchmark : SHA256 des CSV pinés.  
- Warnings pipeline (`CycleGenWarning`) : traçabilité des imputations (ponts, feux rejetés, élévation plate, etc.).

## 11. Évolutions naturelles (hors scope de ce doc)

- Rebuild enveloppe \(V_{curve}\) **par zone** si \(a_y\) zonal devient un vrai paramètre spatial.  
- Doc OpenAPI générée : `/docs` sur l’API.  
- Persistance serveur des simulations (aujourd’hui store mémoire).

## 12. Liens

| Doc | Contenu |
|-----|---------|
| [`README.md`](../README.md) | Démarrage, prérequis |
| [`docs/science/README.md`](science/README.md) | Modèle scientifique |
| [`backend/app/data/benchmark/CITATIONS.md`](../backend/app/data/benchmark/CITATIONS.md) | Corpus & licences |
| [`sumo/README.md`](../sumo/README.md) | Image / TraCI SUMO |
