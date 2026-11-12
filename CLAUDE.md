# CLAUDE.md — CycleGen

Repo : https://github.com/FredericAtlan/CycleGen

## À lire en premier

1. `README.md` — setup backend/frontend
2. `.cursor/rules/refonte-cyclegen.mdc` — règles de refonte en cours (toujours valides)
3. `HANDOVER.md` — état git au 2026-11-12

## Points d'attention

- Branches : `main` (stable), `staging` (export GitHub Pages), `feat/refactor-workspace-multi-router`.
- Données de calibration locales dans `backend/app/data/` — certaines poussées sur
  `wip/handover-cursor-20261112`, voir HANDOVER.md.
- venv local `backend/.venv-e9/` : non commité, régénérable (`pip install -r requirements.txt`).
- Secrets : `.env` racine et `frontend/.env.local` (git-ignorés) ; copies dans `~/Documents/_env_backup_20261112/`.
