# CycleGen — Roadmap (planning)

> Snapshot post-call (2026-10-27). Pas de déploiement dans ce document — plan seulement.

## Current state

| Area | Status |
|------|--------|
| **Wizard Créer** | Étapes 1–4 : Trajet → Contraintes → Conducteur → Cycle. |
| **Étape 4** | Génération IDM via `POST /api/simulate/start` (corridor + params conducteur en mémoire). **Pas** de solveur IDM dans le front (`ideSim` / `CycleGenShell` orchestrent l’API). |
| **Backend local** | FastAPI `:8000`, **sans base**. Trajet/corridor → HERE / Mapbox / OSRM / Overpass / DEM selon config. `simulate/start` → `IDMSolver` (SUMO optionnel si dispo). |
| **GitHub Pages** | Front static (`NEXT_PUBLIC_STATIC_EXPORT`, OSRM-only client pour A→B). **Étape 4 bloquée** sans `NEXT_PUBLIC_API_URL` (API absente). |
| **Versus** | Onglet masqué sur la démo live (`isDemoOsrmOnly` / static export). |
| **Bibliothèque** | 4 packs HERE pré-enregistrés (Grossglockner, Veleta, Iseran, Stelvio) dans `route_studio_fit_pack.json` — geo + corridor + profil pour peupler les 4 écrans. |
| **Docs science** | Équations / modèles dans `docs/science/` (miroir `frontend/public/docs/science/`), ex. `04-idm-markov.md`. |
| **Hébergement API** | **Render free live** : `https://cyclegen-api.onrender.com` (srv `cyclegen-api`, Frankfurt). Variables Pages `NEXT_PUBLIC_API_URL` / `WS` à brancher sur le build static. |

## Near-term priorities

### 1. Backend hébergé pour la démo Pages (P0)

- Déployer FastAPI (Docker `backend/`) sur **Render free** (ou Cloud Run en alternative).
- Config : `CORS_ORIGINS` → `https://fredericatlan.github.io`, `ENV=production`, clés HERE/Mapbox **optionnelles** (OSRM suffit pour une démo allégée).
- Build Pages : `NEXT_PUBLIC_API_URL=https://<service>.onrender.com` (inline au build static).
- Accepter cold start ~1 min après 15 min d’idle (limite free).

### 2. Fiabilité étape 3 → 4 (P0)

- Aujourd’hui : `handleWizardCta` → `handleGenerateCycle` → `startSimulation` → `fetch` ; échec API → retour étape 3 + `simError`.
- Rendre l’échec **toujours visible** (URL tentée, message clair).
- En local : repli documenté `http://localhost:8000` si `NEXT_PUBLIC_API_URL` manque et hostname = localhost.
- Vérifier parcours bout-en-bout : corridor présent → Générer → profil → unlock step 4.

### 3. Décision « mode local » (P1)

Choisir explicitement une des options :

| Option | Implication |
|--------|-------------|
| **A. API locale / hébergée obligatoire pour Générer** | Statu quo architecture (vérité = `kinematic_solver`). Pages = API Render. |
| **B. Packs bibliothèque = step 4 sans re-sim** | Sigles `studioComplete` déjà peuplés ; Générer reste API-only. |
| **C. IDM client (WASM / port)** | Contredit la règle « pas de métier dans React » — hors scope court terme. |

Recommandation courte : **A + B** (API pour générer ; packs pour démo offline/lecture).

### 4. Produit démo (P1)

- Accueil alpine → 4 sigles HERE ; navigation libre sur étapes 1–3 avec données remplies.
- Versus reste hors démo Pages jusqu’à besoin produit.
- Docs science accessibles via aide latérale (pas de régression).

### 5. Suite (P2)

- Warm-up / ping Render pour limiter le cold start perçu.
- E2E Playwright Pages : ouverture sigle → step 4 visible ; Générer avec API mock ou skip si pas d’URL.
- Ne pas embarquer SUMO sur le free tier (IDM only).

## Open questions

1. **Render vs Cloud Run** — Render free OK pour hobby ; Cloud Run si besoin scale / billing GCP déjà actif ?
2. **Clés HERE/Mapbox sur l’API hébergée** — nécessaires pour « vrai » corridor démo, ou OSRM free-flow suffisant ?
3. **Cold start** — message UI « réveil API… » acceptable, ou petit plan always-on (~7 $/mois) ?
4. **API key publique** — `CYCLEGEN_API_KEY` + header front Pages, ou API ouverte CORS-restreinte github.io seulement ?
5. **Générer vs ouvrir pack** — sur Pages sans API, forcer l’ouverture « étude » (profil déjà là) et désactiver le CTA Générer ?
6. **Versus** — réintroduire plus tard sur Pages une fois l’API stable, ou rester Studio-only ?

## References

- Backend entry : `backend/app/main.py` · simulate : `routes_simulate.py` · IDM : `kinematic_solver.py`
- Front transition 3→4 : `CycleGenShell.handleWizardCta` → `handleGenerateCycle` → `api.startSimulation`
- Hosting sketch : `render.yaml`, `railway.toml`, `backend/Procfile`
- Science : `docs/science/README.md`
