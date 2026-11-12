# 08 — Route Studio fit, fingerprint & pedal lag

## Objectif

Recaler un conducteur CycleGen sur des exports **AVL Route Studio** (XLS Maximus / PreA) sans métier dans React.

## Fingerprint

Service : `app/services/rs_fingerprint.py`

- Entrée : séries `t`, `v` (m/s), optionnel `lim` (km/h) ou fichier CSV/XLS
- Sortie : P85/P95 a±, jerk, speed_factor, physics suggérée, **SHA-256** source
- Pedal fields toujours **0** à l’ingestion (à régler au fit)

API : `POST /api/drivers/fingerprint` · `POST /api/drivers/aggregate`

## Pedal lag (solver)

Dans `IDMParams` (`kinematic_solver.py`) :

| Champ | Unité | Défaut | Effet |
|-------|-------|--------|-------|
| `pedal_tau_s` | s | **0** | Filtre 1er ordre sur \(a_\mathrm{cmd}\) |
| `vdes_tau_s` | s | **0** | Low-pass sur \(v_\mathrm{des}\) |
| `descent_hold_gain` | 1/s²/(m/s) | **0** | Retenue continue en descente |

0 = bypass. Transmis via `driver_params` sur `/simulate/start` et jobs fit.

## Geometry-lock fit (async)

Service : `rs_geometry_fit.py` (grille variants) + `rs_jobs.py` (runner) + `rs_compare.py` (RMSE / osc / fidelity).

```text
POST /api/calibrate/route-studio/jobs  →  { task_id }
GET  /api/calibrate/route-studio/jobs/{id}  →  poll status/result
```

**Interdit** : un POST sync qui attend la fin du best-of.

Score fidélité (0–100) : pénalité RMSE_v, ΔT%, oscillation.

## Pack

`frontend/public/data/route_studio_fit_pack.json` (+ copie calibration backend).  
`GET /api/calibrate/route-studio/pack` → `summary` (fidelity_mean, by_route, …).

Scripts batch (`batch_route_studio_here_replay.py`, `_refit_route_studio_pedal.py`) restent la référence offline Maximus ; le job API = grille interactive courte.
