# 06 — Benchmark, corpus externe et recalage

## 1. Objectif

Comparer un cycle **généré** (`ConsolidatedProfile`) à une **référence** :

- cycles réglementaires **proxy** (WLTC / NEDC style), ou  
- traces GPS réelles du **Vehicle Energy Dataset (VED)**, ou  
- démo geo synthétique / cycles **sauvegardés** dans l’application  

pour produire des **KPIs** et des **hints de recalage** des paramètres (Eco, `speed_factor`, TLS, Markov…).

## 2. Corpus piné (pas de clone git opaque)

Répertoire : `backend/app/data/benchmark/`

- `manifest.json` + **SHA256**  
- seeds locaux offline  
- `CITATIONS.md` : ce qui est proxy vs officiel  

| ID | Rôle | Géo | Famille |
|----|------|-----|---------|
| `wltc_class3_proxy` / `nedc_proxy` | Seeds courts offline | non | regulatory |
| `wltc_class1/2/3`, `nedc`, `udds`, `ftp75`, `us06`, `hwfet` | Cycles réglementaires pinés | non | regulatory |
| `demo_gps_richebourg_houdan` | Démo lat/lon | oui | demo |
| `ved_veh*_trip*` | Trajets GPS réels **VED** (Ann Arbor, Apache-2.0) | oui | ved |
| `geolife_u*_car/taxi_*` | Trajets GPS **GeoLife** (Pékin, modes car/taxi) | oui | geolife |

Rebuild réglementaire :

```bash
python scripts/build_regulatory_cycles.py
```

**GeoLife** = même corpus que
[Kaggle microsoft-geolife-gps-trajectory-dataset](https://www.kaggle.com/datasets/arashnic/microsoft-geolife-gps-trajectory-dataset)
(téléchargé via miroir Figshare 1.3).

```bash
python scripts/import_ved_trips.py --download --n 5
python scripts/import_geolife_trips.py --download --n 5
```

Upstream VED : https://github.com/gsoh/VED — Oh, LeBlanc, Peng, IEEE T-ITS 2020.  
Upstream GeoLife : Zheng et al. (WWW 2009 / UbiComp 2008).  
EPA schedules : https://www.epa.gov/vehicle-and-fuel-emissions-testing/dynamometer-drive-schedules  
WLTC Class 1–3 dans CycleGen = **reconstruction d’ingénierie** (pas table UNECE officielle).

## 3. Alignement

- **time** : ré-échantillon 1 Hz sur \([0,\min(T_{gen},T_{ref})]\)  
- **distance** : commun sur \(s\) si positions disponibles, sinon fallback time + warning  

## 4. KPIs principaux

| KPI | Sens |
|-----|------|
| RMSE / MAE / biais sur \(v\) | Erreur de vitesse alignée |
| \(\Delta T\), \(\Delta\) distance | Écarts globaux de durée / longueur |
| Nb d’arrêts, ratio temps arrêté | Structure stop-and-go |
| mean / p95 \(\lvert a\rvert\) | Nervosité / agressivité |

## 5. Hints de recalage (heuristiques)

Exemples :

- biais \(>+1{,}5\,\mathrm{m/s}\) → Eco / baisser `speed_factor` / vérifier trafic  
- trop peu d’arrêts → TLS / densité d’intersections  
- p95 \(\lvert a\rvert\) trop haut → baisser Markov / \(a_{\max}\)  

Ce sont des **diagnostics**, pas un auto-tune.

### Auto-calibrage batch (corpus GPS)

```bash
# API locale requise (uvicorn :8001)
python scripts/calibrate_from_gps_corpus.py --skip-demo
```

Pour chaque trajet `has_geo` : analyze (A→vias→B) → corridor → grille
(profil × physics × `tls_override` × densité feux) → `/api/benchmark/run` →
score multi-KPI → moyenne pondérée.

Rapports : `backend/app/data/benchmark/calibration/latest.md`.  
Le preset **Normal** reflète la dernière moyenne recommandée.

## 6. Injection & comparaison dans l’UI

La barre workspace CycleGen permet de :

1. **Voir** un cycle corpus ou sauvegardé (viewer)  
2. **Injecter** une référence dans l’espace de travail (overlay carte si geo, série pour compare)  
3. **Comparer** au cycle généré courant (Benchmark / corpus)  
4. **Sauvegarder / recharger** un trajet complet (A/B, corridor, profil) sans export XLS/XML  

Il n’y a **plus d’onglet « Scénarios »** dédié. Les scénarios A–I vivent dans le **pipeline principal** (chips Sidebar + panneaux de variante / audit / warnings). Catalogue et modes : `COMPARE_MODES` / `SCENARIO_CATALOG` dans `frontend/src/lib/scenarios.ts`.

## 7. Scénarios opérationnels A–I (pipeline)

### Vague 1 (Gemini primaire A–E)

| ID | Nom | Surface UI | Ce que CycleGen fait | Ce qu’il ne fait **pas** |
|----|-----|------------|----------------------|---------------------------|
| **A** | Pointe / Nuit | Chip Sidebar « A · Pointe/Nuit » + `VariantComparePanel` | Même A→B, re-analyze avec `depart_at` pointe vs nuit ; overlay + Δ stops / durée | Consommation énergie / thermique |
| **B** | Audit sécurité | `SafetyAuditBanner` sur le profil consolidé | `max\|a\|`, `\|a\|/g`, fraction Markov gated, clips | Crash test physique réel |
| **C** | 3 conducteurs | Chip « C · 3 conducteurs » + `VariantComparePanel` (batch arms) | Eco / Normal / Agressif sur même corridor ; RPA, stops | Auto-tune IDM |
| **D** | Feux | Chip « D · Feux » + `VariantComparePanel` | `tls_override` green_wave vs stochastic | Simulation SUMO multi-bras |
| **E** | Murs de pente | `WarningsPanel` / Imputations (sidebar & corridor) — **pas de chip** | Warning `slope_spike_residual` + imputations ponts/tunnels | Correction manuelle MNT |

### Vague 2 (F–I)

| ID | Nom | Surface UI | Ce que CycleGen fait |
|----|-----|------------|----------------------|
| **F** | 3 graines | Chip optionnel « F · 3 graines » | Normal × seeds 1/2/3 (robustesse Markov / TLS) |
| **G** | Cap 90·130 | Chip optionnel « G · Cap 90·130 » | `max_speed` 90 vs 130 km/h |
| **H** | Recalage GPS | Workspace « Comparer » + inject corpus | Inject référence geo → compare gen vs référence |
| **I** | Alpine | GPS A/B + \(a_y\) — **pas de chip** | Stress montagne, warnings pente / latéral |

API batch (bras sur un corridor déjà construit, typiquement C/D/F/G) :

```http
POST /api/scenario/run
{ "corridor": <SpatialCorridor>, "arms": [ ... ] }
```

Scénario **A** : double pipeline client (analyze → corridor → sim) via le chip Pointe/Nuit, pas un second onglet.

## 8. Limites

Comparer Richebourg→Houdan à du WLTC via RMSE(\(v(t)\)) est un **signal de forme**, pas une preuve d’homologation. Préférez KPIs distributionnels ou GPS **same-route**. VED / GeoLife = diagnostic dynamique (régions différentes).

## 9. Fichiers code

- `backend/app/services/benchmark_loader.py`, `benchmark_metrics.py`, `profile_metrics.py`
- `backend/app/api/routes_benchmark.py`, `routes_scenario.py`
- `frontend/src/components/benchmark/BenchmarkViewer.tsx`
- `frontend/src/lib/scenarios.ts` (`COMPARE_MODES`, `SCENARIO_CATALOG`)
- `frontend/src/components/scenarios/VariantComparePanel.tsx`
- `frontend/src/components/scenarios/SafetyAuditBanner.tsx`
- `frontend/src/components/WarningsPanel.tsx`
- `frontend/src/lib/tripStore.ts`
