# HANDOVER — CycleGen (2026-11-12)

Migration Cursor → Claude Code.

## État git

- `main` : propre, synchro `origin/main`.
- `wip/handover-cursor-20261112` : fichiers non commités au 12/11 — `LICENSE`,
  `backend/Procfile`, `backend/app/api/routes_drivers.py`, CSV benchmark
  (`avl_rs_iseran_*`, `avl_rs_stelvio_dynamique`). Poussée sur origin.
- `handover/stash-00` (« staging-wip-before-pages-alpine ») et `handover/stash-01`
  (« wip calibration dumps ») : stashs convertis en branches poussées
  (les stashs locaux existent toujours).
- Volontairement exclus du commit : `backend/.venv-e9/` (venv régénérable).

## Secrets

`.env` racine + `frontend/.env.local` (git-ignorés) ; copies datées dans
`~/Documents/_env_backup_20261112/`.

## Archives Cursor

Transcripts : `~/Documents/_cursor_export_20261112/transcripts/Users-fredericatlan-Documents-CycleGen/`.
