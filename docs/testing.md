# CycleGen — non-regression testing

Goal: a **honest** coverage matrix aiming at ~100% of **user-facing flows**,
with Layer A/B always runnable offline, and Layer D (Playwright) optional when
servers are up. No claim of line-coverage perfection.

## Test pyramid

```
        ┌─────────────────────┐
        │  D — Playwright E2E │  optional (PLAYWRIGHT=1)
        ├─────────────────────┤
        │  C — Frontend Node  │  typecheck + tiny URL check
        ├─────────────────────┤
        │  B — API contract   │  FastAPI TestClient
        ├─────────────────────┤
        │  A — Backend unit   │  unittest, mocked / no network
        └─────────────────────┘
```

### Layer A — Backend unittest (no network / mocked)

Run from `backend/` with the project venv:

```bash
cd backend && .venv/bin/python -m unittest discover -s tests -v
```

| Test module | Focus |
|---|---|
| `test_api_contract.py` | Layer B contract (also discovered with A) |
| `test_benchmark_metrics.py` | Benchmark KPI helpers |
| `test_climb_holds_speed.py` | Grade climb holds target speed |
| `test_curvature_envelope.py` | Curve speed envelope |
| `test_driving_mode_envelope.py` | Driver mode vs envelope |
| `test_elevation_sample.py` | Elevation sampling helpers |
| `test_envelope_c1.py` | C¹ bilateral envelope |
| `test_ephemeral_store.py` | TTL / capacity store (security DoS) |
| `test_grade_coupling.py` | Grade ↔ plant coupling |
| `test_here_router.py` | HERE router parsing (mocked) |
| `test_kinematic_horizon.py` | Kinematic horizon |
| `test_legal_smooth.py` | Legal speed smoothing |
| `test_markov_off_deterministic.py` | Markov off → deterministic |
| `test_markov_solver.py` | Markov noise / solver |
| `test_n90_calibrator.py` | N90 calibration math |
| `test_osm_maxspeed.py` | OSM maxspeed parsing |
| `test_p1_security.py` | WS token, export size, corridor length match |
| `test_p5_jerk_in_loop.py` | Jerk limits in IDM loop |
| `test_profile_metrics.py` | Profile aggregates |
| `test_r_adaptive.py` | Adaptive r / plant |
| `test_security_redact.py` | Secret redaction + egress host smoke |
| `test_spatial_processor.py` | Spatial corridor builder |
| `test_vehicle_plant_clip.py` | Vehicle plant clipping |

**Security tests expected (P0 / P1)** — see also `docs/security.md`:

| Topic | Status |
|---|---|
| Secrets redaction in logs/URLs | **covered** (`test_security_redact.py`) |
| Ephemeral store TTL + max items | **covered** (`test_ephemeral_store.py`, `test_p1_security.py`) |
| Route / corridor point & km caps | **covered** (Layer B `test_api_contract.py`) |
| Empty corridor `S` rejected | **covered** (Layer B) |
| Export profile size cap | **covered** (`CYCLEGEN_MAX_ROUTE_POINTS` on `/api/export`) |
| Optional WS token reject | **covered** (`test_p1_security.py`) |
| Full API authentication | **gap** (local tool; no user auth) |
| Help markdown sanitization | **gap** (P1+) |

### Layer B — API contract (httpx / TestClient)

File: `backend/tests/test_api_contract.py`

| Case | Expectation |
|---|---|
| `GET /health` | 200 `{status: ok}` |
| `POST /api/corridor/build` empty geometry | 400 |
| `POST /api/corridor/build` oversize points | 400 (`CYCLEGEN_MAX_ROUTE_POINTS`) |
| `POST /api/simulate/start` empty `S` | 400 |
| `POST /api/export` small profile | 200 CSV |
| `POST /api/export` oversize profile | 400 (`CYCLEGEN_MAX_ROUTE_POINTS`) |

No external network; corridor *success* path is **not** covered here (needs DEM/router mocks or real keys).

### Layer C — Frontend unit-ish (Node)

Vitest is **not** added (dependency / config weight). Instead:

```bash
cd frontend
npm run typecheck          # tsc --noEmit
npm run test:unit-url      # scripts/check-api-url.mjs (simulationWsUrl join)
```

`check-api-url.mjs` mirrors `simulationWsUrl` in `src/lib/api.ts` (relative-path
only, optional `token=` query) so WS URL regressions fail without a browser.

### Layer D — Playwright E2E

```bash
cd frontend
npx playwright install chromium   # once per machine
npm run test:e2e:smoke            # home + help
npm run test:e2e                  # all e2e/
```

Config: `frontend/playwright.config.ts` — `baseURL` `http://127.0.0.1:3000`.
`webServer` can start Next.js; **API must run separately** on **8000** (Docker) or
**8000/8001** (local uvicorn). Smoke/shell specs avoid geocode and do not require
API keys.

Specs:

| Spec | Intent |
|---|---|
| `e2e/smoke.spec.ts` | Home, branding, studio title, help drawer |
| `e2e/studio-shell.spec.ts` | `/?mode=create` → sidebar + Trajet |

`data-testid` hooks (minimal): `app-header`, `app-brand`, `help-button`,
`help-drawer`, `studio-home`, `studio-home-title`, `studio-sidebar`.

---

## Root runner

```bash
# Always: Layer A + C
./scripts/test_nonreg.sh

# Also Layer D when frontend (and optionally API) are up:
PLAYWRIGHT=1 ./scripts/test_nonreg.sh
```

Exits non-zero on any failure.

---

## Coverage matrix (user-facing flows)

Status legend: **covered** · **partial** · **gap**

| UI flow | Layer A | Layer B | Layer C | Layer D | Status | Notes |
|---|---|---|---|---|---|---|
| **Route** (geocode, analyze, map A/B) | partial | gap | gap | gap | **partial** | Unit: OSM/HERE parsers mocked. No contract for `/api/route/*`. E2E avoids live keys. |
| **Corridor** (build, envelope charts) | covered | partial | gap | gap | **partial** | A: spatial/envelope/legal/curvature. B: empty/oversize reject only. Happy-path build needs providers. |
| **Sim** (IDM/SUMO start, WS stream) | covered | partial | partial | gap | **partial** | A: IDM/markov/jerk/plant. B: empty `S`. C: `simulationWsUrl`. No live WS E2E. |
| **Export** (CSV/XML download) | partial | covered | gap | gap | **partial** | A/B: size cap + small export. No UI download E2E. |
| **Compare / Versus** | gap | gap | gap | gap | **gap** | No dedicated tests yet. |
| **Library** (local cycles / corpus) | gap | gap | gap | gap | **gap** | Browser localStorage; no E2E. |
| **Help** (drawer, step docs) | gap | gap | gap | covered | **partial** | D: open help on home. Markdown sanitize = gap. |
| **Playback** (replay bar) | gap | gap | gap | gap | **gap** | New hook `useCyclePlayback`; no tests yet. |
| **Studio shell** (home, steps, sidebar) | — | — | typecheck | covered | **partial** | D smoke + shell. |
| **Security / DoS guards** | covered | covered | partial | — | **partial** | Caps + store + redact + WS path harden (C). Full user auth still gap. |

### Honest gaps (priority)

1. Live **route analyze** E2E or contract with recorded fixtures (no API keys).
2. **Compare**, **Library**, **Playback** Playwright or unit coverage.
3. Recorded-fixture **corridor build** happy path (no live DEM).
4. Full **simulate WebSocket** smoke (needs running API + short synthetic corridor).

When closing a gap, update this table and prefer Layer A/B first so CI stays offline-friendly.
