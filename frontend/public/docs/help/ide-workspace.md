# IDE CycleGen — workspace ingénierie

Aide austère. Pas de parcours SaaS : un **workspace unifié**.

## Layout

```text
[ Assets ]  [ Canvas v(t) / carte ]  [ Inspecteur ]
[ -------------- Console / warnings / logs -------------- ]
```

Entrée : `/?mode=ide`.  
**Non-régression** : `/?mode=create` (Shell GPS) reste intact jusqu’à validation e2e.

## Cheap vs expensive

| Action | Coût | UX |
|--------|------|-----|
| **Update dynamics** | Cheap | Re-sim IDM debounced ~75 ms. Pedals / IDM. Pas de « Générer ». |
| **Rebuild corridor** | Expensive | HERE/OSRM/élévation/feux/lois. **Bouton explicite seulement**. |
| **Fit RS** | Heavy async | `POST /api/calibrate/route-studio/jobs` → poll `task_id`. Jamais sync long. |

## Pedal (defaults 0)

```text
pedal_tau_s = 0
vdes_tau_s = 0
descent_hold_gain = 0
```

0 = désactivé. Non-zéro = lag 1er ordre / hold descente (solver).

## Fingerprint

Drawer **Fingerprint** : CSV / `.xls` / JSON → `POST /api/drivers/fingerprint`  
Réponse : physics suggérée + **SHA-256** du fichier source.  
Batch multi-fichiers → `POST /api/drivers/aggregate` (Prudent / Dynamique / PreA).

## Lois de route

Banque Dexie (`Alpine AT`, FR défaut…).  
Changer la loi **ne rebuild pas** : il faut **Rebuild corridor**.

## Strates Zustand

1. **config** — driverId, vehicleId, roadLawId, aY, maxSpeed  
2. **geometry** — corridor + route (remplacement wholesale, pas mutation)  
3. **results** — profil / séries canvas + `hoverIndex` / `playhead`

Hydrate : session studio (`studioSession`) · trajet sauvé · cycle bibliothèque.

## Versus Fidélité

Bandeau pack RS : fidelity mean / RMSE / best–worst pairs.  
Source : `GET /api/calibrate/route-studio/pack` ou `/data/route_studio_fit_pack.json`.

## API utiles

- `POST /api/drivers/fingerprint` · `/aggregate`
- `POST /api/simulate/start` (IDM cheap)
- `POST /api/corridor/build` (expensive)
- `POST /api/calibrate/route-studio/jobs` · `GET …/jobs/{id}`
- `POST /api/calibrate/route-studio/compare`
- `POST /api/export` (`csv` | `xml` | `xlsx`)

## Scripts CLI

```bash
cd backend && .venv/bin/python ../scripts/rs_cli.py fingerprint path.xls
.venv/bin/python ../scripts/rs_cli.py pack-summary
.venv/bin/python ../scripts/rs_cli.py compare --help
```

Vérité scientifique = `kinematic_solver` + `rs_*.py`. Routers = thin.
