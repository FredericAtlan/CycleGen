# CycleGen

Application web d'ingénierie pour générer des **cycles de roulage automobiles synthétiques** physiquement réalistes (profils \(v(t)\), \(\alpha(t)\)).

Pipeline scientifique : **OSRM → Overpass / Open-Elevation → corridor spatial → SUMO/TraCI → export CSV/XML**.

## Structure

```
CycleGen/
  backend/     FastAPI (acquisition, spatial, SUMO bridge, IDM fallback)
  frontend/    Next.js 14 + Leaflet + Recharts (4 étapes GIS)
  sumo/        Templates réseau / config simulation
```

## Prérequis

- Python 3.11+
- Node.js 20+
- Docker (service SUMO)

## Démarrage rapide

```bash
# Backend + SUMO
cp .env.example .env
docker compose up -d sumo
cd backend && python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# Frontend
cd frontend && npm install && npm run dev
```

- API : http://localhost:8000/docs  
- UI : http://localhost:3000  

## Étapes UI

1. **Définition spatiale** — points A/B, route OSRM  
2. **Contraintes statiques** — pente, V_lim, feux (Overpass)  
3. **Simulation microscopique** — SUMO/TraCI (WebSocket)  
4. **Export** — profils consolidés CSV/XML  

## APIs externes (override via `.env`)

| Service | Variable | Défaut |
|---------|----------|--------|
| OSRM | `OSRM_BASE_URL` | `https://router.project-osrm.org` |
| Overpass | `OVERPASS_URL` | `https://overpass-api.de/api/interpreter` |
| Open-Elevation | `OPEN_ELEVATION_URL` | `https://api.open-elevation.com/api/v1/lookup` |
| SUMO TraCI | `SUMO_HOST` / `SUMO_PORT` | `localhost:8813` |

## Profils de conduite

`Eco` | `Normal` | `Agressif` → paramètres `vType` SUMO (+ IDM fallback).
