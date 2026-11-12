# Refonte IDE — statut P5

Phases livrées : **P0 → P4 + P5 polish**. Gate e2e Playwright = à faire ensuite (hors agent).

## CLI

```bash
cd backend
.venv/bin/python ../scripts/rs_cli.py fingerprint /path/to/file.xls
.venv/bin/python ../scripts/rs_cli.py pack-summary
.venv/bin/python ../scripts/rs_cli.py compare --t-ref ref.json --t-cg cg.json
```

## Services purs

| Module | Rôle |
|--------|------|
| `rs_fingerprint.py` | séries → physics + sha256 |
| `rs_compare.py` | RMSE / osc / fidelity |
| `rs_geometry_fit.py` | grille IDM geometry-lock |
| `rs_jobs.py` | runner async `task_id` |

## Aide UI

- Drawer Help → onglet **IDE** (`/docs/help/ide-workspace.md`)
- Science → **08 Route Studio fit**

## Non-régression

`/?mode=create` intact. Validation e2e = prochaine étape utilisateur.
