# CycleGen — déploiement (préparation)

Document de **préparation** uniquement : aucun déploiement distant n’est lancé depuis ce repo. Pour cloner et lancer en local, voir le [README](../README.md) (section [Télécharger](../README.md#télécharger)).

| Ressource | Lien |
|-----------|------|
| Dépôt | `https://github.com/FredericAtlan/CycleGen` |
| Fiche projet (vitrine) | [fredericatlan.github.io/projets/cyclegen.html](https://fredericatlan.github.io/projets/cyclegen.html) |
| Licence | [MIT](../LICENSE) |

Le frontend déployé sur Pages **ne duplique pas** le backend : il appelle l’**API FastAPI déjà présente** dans `backend/` (mêmes routes qu’en local), configurée via `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL`.

Ce guide prépare **deux hébergements séparés** :

| Partie | Cible | Artefact |
|--------|--------|----------|
| Frontend | GitHub Pages (statique) | `frontend/out/` |
| Backend | Render ou Railway (conteneur / Python) | `backend/Dockerfile` |

**Rien n’est déployé automatiquement.** Pas de compte créé ici — étapes manuelles ci-dessous.

## Site perso (vitrine) vs appli CycleGen

| URL | Rôle |
|-----|------|
| `https://fredericatlan.github.io/projets/` | Liste des projets (page perso) |
| `https://fredericatlan.github.io/projets/cyclegen.html` | Fiche CycleGen (description + liens) |
| `https://fredericatlan.github.io/CycleGen/` *(après deploy Pages du front)* | UI interactive (export Next) |
| `https://<api>.onrender.com` *(ou Railway)* | **Même** API FastAPI CycleGen déjà dans ce repo |

Le front **ne recrée pas** d’API : il consomme les routes existantes (`POST /api/route/analyze`, `POST /api/corridor/build`, `POST /api/simulate/start`, WS `/api/simulate/ws/{id}`, `POST /api/export`, …).

## Architecture front → API

```
Navigateur (Pages UI)
  │  HTTPS fetch / WSS  (NEXT_PUBLIC_API_MODE=direct)
  ▼
NEXT_PUBLIC_API_URL  →  https://<api>.onrender.com  (ou Railway)  ← endpoints existants
NEXT_PUBLIC_WS_URL   →  wss://<api>.onrender.com
```

- En **local** (`npm run dev`) : le navigateur passe par le BFF Next `/api/cg` (clé API injectée côté serveur).
- En **Pages** (`npm run build:static`) : `NEXT_PUBLIC_API_MODE=direct` — le navigateur appelle **directement** FastAPI (pas de route handlers Next sur Pages).

CORS backend **obligatoire** : `CORS_ORIGINS` doit contenir l’origine exacte du front (ex. `https://fredericatlan.github.io`).

### Auth / clé API

| Mode | Recommandation |
|------|----------------|
| Démo publique Pages | `CYCLEGEN_API_KEY` **vide** + `CORS_ORIGINS` verrouillé sur le domaine Pages + caps DoS déjà en place |
| Prod avec clé | La clé **ne peut pas** rester secrète en export statique. Garder un BFF Node (Vercel/`next start`) ou un reverse-proxy — hors scope Pages pur |

`ENV=production` **exige** `CYCLEGEN_API_KEY` dans le code actuel. Pour une démo sans clé : laisser `ENV` hors `production`/`prod`, ou poser une clé et accepter qu’elle ne protège pas un front statique (ne pas la mettre dans `NEXT_PUBLIC_*`).

WebSockets : vérifier que l’hébergeur API les autorise (Railway en général OK ; Render free peut être limité / cold start).

SUMO Docker **n’est pas** inclus dans l’image API free — la simu bascule sur le solveur **IDM**.

---

## 1) Backend (Render ou Railway)

Fichiers prêts :

- `backend/Dockerfile` + `backend/docker-entrypoint.sh` (`PORT` runtime)
- `backend/requirements.txt` + `backend/Procfile`
- `backend/app/main.py` → `GET /health`
- `render.yaml` (blueprint) · `railway.toml`
- Variables documentées dans `.env.example`

### Variables d’environnement (API)

| Variable | Obligatoire | Exemple |
|----------|-------------|---------|
| `PORT` | Auto (plateforme) | `10000` |
| `CORS_ORIGINS` | **Oui** | `https://fredericatlan.github.io` |
| `ENV` | Selon auth | `production` seulement si clé définie |
| `CYCLEGEN_CORS_LOCALHOST_REGEX` | Prod | `0` |
| `CYCLEGEN_API_KEY` | Si `ENV=production` | secret dashboard |
| `MAPBOX_ACCESS_TOKEN` | Non | `pk.…` (pas `sk.`) |
| `HERE_API_KEY` | Non | clé HERE |

### Render (manuel)

1. Compte Render → **New** → Web Service (Docker) **ou** Blueprint `render.yaml`.
2. Repo `FredericAtlan/CycleGen`, root / Dockerfile : `backend/`.
3. Plan free ; health check `/health`.
4. Renseigner `CORS_ORIGINS` (+ clés carto optionnelles).
5. Déployer → noter l’URL `https://….onrender.com`.
6. Tester : `curl https://….onrender.com/health`.

### Railway (manuel)

1. Compte Railway → New Project → GitHub `CycleGen`.
2. Build : Dockerfile `backend/Dockerfile` (voir `railway.toml`).
3. Variables comme ci-dessus ; `PORT` fourni par Railway.
4. Générer le domaine public → tester `/health`.

---

## 2) Frontend (GitHub Pages)

Fichiers prêts :

- `frontend/next.config.mjs` — `output: 'export'` si `CYCLEGEN_STATIC_EXPORT=1`
- `npm run build:static` — écarte temporairement `src/app/api` (BFF), produit `frontend/out/`
- `.github/workflows/pages.yml` — build + publish `gh-pages` / artifact Pages
- `NEXT_PUBLIC_BASE_PATH=/CycleGen` pour *project pages* `https://<user>.github.io/CycleGen/`

### Build local de contrôle

```bash
cd frontend
npm ci
NEXT_PUBLIC_BASE_PATH=/CycleGen \
NEXT_PUBLIC_API_URL=https://YOUR-API.onrender.com \
NEXT_PUBLIC_WS_URL=wss://YOUR-API.onrender.com \
npm run build:static
# → frontend/out/
```

Sans sous-chemin (site user racine ou custom domain) : omettre `NEXT_PUBLIC_BASE_PATH`.

### GitHub Pages (manuel)

1. Repo Settings → Pages → Source : **GitHub Actions** (une fois).
2. Pousser sur `main` **ou** `staging` (workflow `pages.yml` écoute les deux) **ou** `workflow_dispatch`.
3. Variables de dépôt (Actions) — **optionnelles** pour publier l’UI ; recommandées quand l’API est live :

| Name | Défaut / note |
|------|----------------|
| `NEXT_PUBLIC_BASE_PATH` | défaut workflow + `build:static` : `/CycleGen` |
| `NEXT_PUBLIC_API_URL` | optionnel ; warning CI si absent |
| `NEXT_PUBLIC_WS_URL` | dérivé de l’API HTTPS si omis |

4. Après le premier deploy API : `CORS_ORIGINS=https://fredericatlan.github.io` (origine sans `/CycleGen`).

---

## 3) Checklist « prêt » vs « à faire à la main »

### Déjà prêt dans le repo

- [x] [README](../README.md) — clone, structure `backend/` · `frontend/` · `sumo/` · `docs/`, démarrage local
- [x] [LICENSE](../LICENSE) — MIT
- [x] [.gitignore](../.gitignore) — `.env`, `node_modules/`, `.next/`, `out/`, `.venv/`, `.cursor/`
- [x] [.env.example](../.env.example) — variables documentées (sans secrets)
- [x] Export statique Next (`build:static` + config)
- [x] Mode API direct pour Pages (`NEXT_PUBLIC_API_MODE=direct`)
- [x] Dockerfile API + entrée `$PORT` + Procfile
- [x] Blueprint Render / hints Railway
- [x] Workflow Pages (`.github/workflows/pages.yml`, à activer côté GitHub)
- [x] Ce document

### À faire manuellement (hors agent)

- [ ] Repo GitHub **Public** (Settings → General → Danger zone → Change visibility) si téléchargement ouvert souhaité
- [ ] `git push` des commits de préparation (validation utilisateur — **non fait** par l’agent)
- [ ] Vérifier qu’aucun secret n’est tracké : `git check-ignore -v .env` doit matcher ; ne jamais `git add .env`
- [ ] Compte Render **ou** Railway + premier deploy API
- [ ] Poser les secrets/env dashboard (CORS, Mapbox/HERE, éventuelle clé)
- [ ] Activer GitHub Pages (Actions) + variables `NEXT_PUBLIC_*`
- [ ] Vérifier WSS live (simu étape 3) sur l’hébergeur choisi
- [ ] (Optionnel) Quota / cold start free tier ; custom domain
- [ ] (Optionnel) Brancher SUMO ailleurs — non couvert par l’image API free
- [ ] Commit / push de cette préparation si tu veux la versionner

### Non fait volontairement

- Aucun déploiement distant
- Aucune création de compte
- Pas de commit forcé / pas de push (sauf si tu le demandes)
- Pas de `npm install` / build CI local dans cette préparation (dépendances front absentes du disque) — lancer `npm ci && npm run build:static` chez toi pour valider l’export
