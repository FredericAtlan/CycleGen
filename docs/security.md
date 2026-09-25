# CycleGen — modèle de menace & exposition réseau

CycleGen est un **outil d’ingénierie local**. Par défaut l’API FastAPI
**n’a pas d’authentification**. Toute machine qui peut joindre le port API
peut consommer les clés HERE/Mapbox serveur, géocoder, simuler et exporter.

Activez `CYCLEGEN_API_KEY` (P2) dès qu’un reverse-proxy / LAN est envisagé.

## Règles d’exposition (P0)

| Environnement | Bind recommandé | Notes |
|---|---|---|
| Laptop / CI locale | `127.0.0.1` uniquement | Défaut `.env.example` (`API_HOST`) |
| Docker Compose | Publier `127.0.0.1:8000:8000` | Le conteneur écoute `0.0.0.0` *interne* ; le mapping host reste loopback |
| LAN / Internet | **Interdit** sans reverse-proxy + auth | Sinon Critical (OWASP A01 / CWE-306) |

```bash
# Backend local (obligatoire hors Docker)
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

## Contre-mesures DoS (P0 — implémentées)

- **IDM hors event loop** : solveur dans un thread daemon ; `await wait_idm_done` via `asyncio.to_thread` pour ne pas geler `/health` ni les autres clients.
- **Caps route / corridor** : `CYCLEGEN_MAX_ROUTE_POINTS` (défaut 12000), `CYCLEGEN_MAX_ROUTE_KM` (défaut 120) aussi sur `POST /api/corridor/build`.
- **Stores éphémères** : `SIM_STORE` / `CORRIDOR_STORE` avec TTL + taille max (`CYCLEGEN_SIM_TTL_S`, `CYCLEGEN_MAX_SIMULATIONS`, `CYCLEGEN_CORRIDOR_TTL_S`, `CYCLEGEN_MAX_CORRIDORS`). Réponse `429` si saturation des simulations *running*.

## Contre-mesures P1 / P2 (implémentées)

| ID | Contrôle | Détail |
|---|---|---|
| S3 | N90 grid DoS | `build_grid` estime le produit cartésien **avant** `itertools.product` ; refuse si `> max_arms*20` ou `> 50_000`. Chaque axe plafonné à 32 (`N90CalibrateRequest.*_grid` `max_length=32`). |
| S11 | Export payload | `POST /api/export` refuse les profils dont `time`/`velocity`/`position`/`acceleration`/`slope` dépassent `CYCLEGEN_MAX_ROUTE_POINTS` (HTTP 400). Soft cap pydantic `max_length=12000` sur `ConsolidatedProfile`. |
| B3 | SpatialCorridor | `model_validator` : `len(S)==len(alpha)==len(V_limite)` ; séries optionnelles non vides (`V_curve`, `geometry`, …) doivent aussi matcher. |
| S6 | WS access token | `SimulateStartResponse.ws_token` (`secrets.token_urlsafe(24)`). WS : `GET /api/simulate/ws/{id}?token=…` ; close `4401` si absent / faux. |
| S8 | CORS prod | `allow_origin_regex` localhost **uniquement** si `CYCLEGEN_CORS_LOCALHOST_REGEX=1` (défaut : `1` hors `ENV=production`, sinon `0`). |
| P2 | API key optionnelle | Si `CYCLEGEN_API_KEY` est défini : header `X-API-Key` ou `Authorization: Bearer …` requis sur `/api/*` (sauf `/health`). WebSocket navigateur : `?api_key=`. |
| B10 | Geocode throttle | Nominatim : max 1 req / 1.1 s (process-global) ; HTTP `429` si flood. |

### Auth optionnelle (exemple)

```bash
export CYCLEGEN_API_KEY='change-me'
# HTTP
curl -H "X-API-Key: change-me" http://127.0.0.1:8000/api/...
# WebSocket (browser)
# ws://127.0.0.1:8000/api/simulate/ws/{id}?token={ws_token}&api_key=change-me
```

### Production CORS

```bash
export ENV=production
# ou explicitement :
export CYCLEGEN_CORS_LOCALHOST_REGEX=0
export CORS_ORIGINS=https://app.example.com
```

## Ce qui n’est pas couvert (P3+)

Sanitization Help markdown côté frontend, rate-limit HTTP global, mTLS / OIDC — hors scope outil local.
