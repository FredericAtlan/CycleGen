# CycleGen

Application web d'ingénierie pour générer des **cycles de roulage automobiles synthétiques** physiquement réalistes (profils \(v(t)\), \(\alpha(t)\)).

Pipeline : **Mapbox driving-traffic (fallback OSRM) → Overpass (feux / bridge / tunnel / highway) → elevation filtrée → corridor \(V_{legal}, V_{traffic}, V_{curve}, V_{envelope}\) → IDM + Markov asymétrique (SUMO optionnel) → export CSV/XML**.

## Documentation scientifique

Base détaillée (experts + ingénieurs hors domaine) pour le volet d’aide latéral :

→ [`docs/science/README.md`](docs/science/README.md)

Chapitres : vue d’ensemble, routage/trafic, corridor spatial, feux TLS, IDM/Markov, SUMO vs IDM, benchmark/recalage, limites & bonnes pratiques.

## Architecture logicielle

Découpage dépôt, API, frontend shell, moteurs IDM/SUMO, corpus :

→ [`docs/architecture.md`](docs/architecture.md)

## Sécurité (exposition locale)

→ [`docs/security.md`](docs/security.md) — bind loopback, caps DoS, stores TTL.

## Vague 1 — modèle scientifique (limites)

- **Macro** : enveloppe de vitesse via Mapbox `depart_at` (sans token → OSRM free-flow + warning).
- **Topo** : interpolation ponts/tunnels OSM ; rejet feux si projection > 5 m ; SG sur z (≥ 30 m) ; \(V_{curve}=\sqrt{a_y R}\).
- **Micro** : feux onde verte conditionnelle (`primary`/`trunk` espacés) sinon déphasage stochastique ; bruit Markov **coupé** en freinage look-ahead / \(a_{IDM}\le -1\,\mathrm{m/s^2}\).
- Ce n’est **pas** une vérité terrain absolue : voir `backend/app/data/markov/CITATIONS.md`.

Repo GitHub : https://github.com/FredericAtlan/CycleGen

## Structure

```
CycleGen/
  backend/     FastAPI (acquisition, spatial, SUMO bridge, IDM)
  frontend/    Next.js 16 + Leaflet + Recharts (4 étapes GIS)
  sumo/        Templates réseau / prepare_network
```

## Prérequis

- Python 3.9+ (recommandé : venv via [`uv`](https://github.com/astral-sh/uv))
- Node.js 20+
- Docker Desktop (optionnel) pour l’image SUMO + netconvert
- `curl` (fallback HTTPS si OpenSSL/httpx échoue sur le host)

## Démarrage

```bash
cp .env.example .env

# Backend — bind loopback only (no LAN exposure; API has no auth)
cd backend
uv venv --python python3 .venv && source .venv/bin/activate
uv pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

# Frontend (autre terminal)
cd frontend && npm install && npm run dev
```

- API docs : http://127.0.0.1:8000/docs  
- UI : http://localhost:3000  

Sécurité / exposition réseau : [`docs/security.md`](docs/security.md).

### SUMO (optionnel)

```bash
docker compose build sumo && docker compose up -d sumo
```

Sans SUMO, `/api/simulate/start` bascule automatiquement sur le **solveur IDM**.

## Étapes UI

1. **Route** — clic A/B sur la carte, Analyze → OSRM  
2. **Corridor** — pente α(s), V_lim, feux (Overpass)  
3. **Simulation** — SUMO/TraCI ou IDM, WebSocket live  
4. **Export** — profils consolidés CSV/XML  

Profils conduite : `Eco` | `Normal` | `Agressif`.

## API

| Méthode | Path |
|---------|------|
| POST | `/api/route/analyze` |
| POST | `/api/corridor/build` |
| POST | `/api/simulate/start` |
| WS | `/api/simulate/ws/{id}` |
| POST | `/api/simulate/{id}/stop` |
| POST | `/api/export` |

## Tests

```bash
cd backend && source .venv/bin/activate
python -m unittest discover -s tests -v
```

## Notes host

- Homebrew Python 3.12 peut être cassé sur macOS 26 (`platform.mac_ver` vide) → utiliser le Python système 3.9 + `uv`.
- Handshake SSL httpx parfois KO → fallback automatique via `curl`.
